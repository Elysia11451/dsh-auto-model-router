// routing-policy / impl / pre-execute —— tools/pre-execute 钩子主体。
// 回答的问题：工具真要跑了，这一轮算 chat 还是 work？要不要记升档铁证？
//
// v0.7.2 阶段三 3.4：pre-execute 旧文本真切已降级为**纯注解** —— 真切以
// agent/pre-step 的状态机决策为准（避免双钩子打架）。工具升档（3.1）与 JSONL 诊断照写。
//
// 拆分铁律：本文件不 import 本域 interface.js；跨域（leaderboard 的 ensureFresh、
// switch-controller 的读回、telemetry 的落盘）一律经 deps 注入。
// 域内纯函数（classifyTask/sourceFromMeta）直接 import 同域 impl —— 不跨域。
import { sourceFromMeta } from './classifier.js';
import { decideRoute } from './decider.js';

/**
 * @typedef {object} PreExecuteDeps
 * @property {object} ctx
 * @property {object} cfg
 * @property {object} flags
 * @property {(ctx: object, level: string, msg: string) => void} safeLog
 * @property {(exec: any) => string} sidOf
 * @property {{peek: Function, set: Function, read: Function}} modeStore
 * @property {(sid: string) => any} peekSessionMode
 * @property {Map<string, string>} lastSwitch
 * @property {() => void} ensureFresh                    —— 跨域（leaderboard）
 * @property {Function} annotateRoute                    —— 域内实例（decider）
 * @property {Function} maybeGroupHint                   —— 域内实例（decider）
 * @property {Function} routeBranch                      —— 域内实例（decider）
 * @property {Function} readSelectionProjection          —— 跨域（switch-controller）
 * @property {(entry: object) => Promise<void>} appendRouteLog —— 跨域（telemetry）
 */

export function createPreExecuteHandler(d) {
  const {
    ctx, cfg, safeLog, sidOf, modeStore, peekSessionMode, lastSwitch,
    ensureFresh, annotateRoute, maybeGroupHint, routeBranch,
    readSelectionProjection, appendRouteLog,
  } = d;

  // pre-execute 主体（单独命名，便于自测探活）
  return async function preExecuteHandler(exec, next) {
    {
        // ── 安全阀：任何异常都放行，绝不阻断工具链 ──
        try {
          let text = '';
          let isToolCall = false;
          const execSid = (() => { try { return sidOf(exec); } catch { return 'unknown'; } })();
          try {
            const args = exec?.args ?? exec?.arguments;
            if (typeof args === 'string') text = args;
            else if (args && typeof args === 'object') {
              text = [args.input, args.prompt, args.message, args.text, args.command, args.file_path, args.path, args.filePath, args.content, args.textContent]
                .filter((v) => typeof v === 'string').join('\n');
            }
            // 工具名直判（ToolExecution 实测形：exec.name + exec.arguments，无 .tool 字段）：
            // write/edit/bash/read 等工具名本身就是"干活"证据 —— 哪怕自然语言已被压缩成“测试”二字，
            // 工具调用仍是铁证。补一句"工具调用:<name>"，classifyTask 命中 AGENT_KEYWORDS 即判 work。
            // v0.7.2 阶段三 3.1：同一正则同时产出升档信号 isToolCall（集合含 read）。
            try {
              const toolName = String(exec?.name ?? exec?.tool ?? '').trim();
              // v0.7.2 修正（turn 计数）：观测型/调试型工具不算工作信号。
              // 参考 dsh-tool-turbo：简单确定性工具（write/read/grep/glob/bash 等）才算干活证据；
              // web_search/web_fetch/browser/android 等信息获取类不自动算干活，避免闲聊查个天气就升 work。
              const OBSERVATION_TOOLS = /^(run_code|send_meme|ask_user_question|read_image|present|compress|decompress|search_context|acp_status|acp_cache)$/i;
              const isObservation = !!toolName && OBSERVATION_TOOLS.test(toolName);
              isToolCall = !!toolName && !isObservation && /^(write|edit|bash|exec|run|create|update|delete|remove|move|copy|mkdir|install|deploy|publish|build|test|run_command|file|shell|read|grep|glob)$/i.test(toolName);
              if (isToolCall) {
                text += `\n工具调用:${toolName} 建文件 写代码 跑命令`;
              } else if (toolName) {
                text += `\n工具调用:${toolName}`;
              }
            } catch { /* 工具名读取失败不影响文本分类 */ }
          } catch { text = ''; }

          // ── v0.7.2 阶段三 3.1：真实工具调用 = "正在干活"的铁证 → 升 work + 计数清零 ──
          // 为什么在 pre-step 拿不到这个信号：agent/pre-step 在消息进入时触发，此时工具还没调；
          // tools/pre-execute 是工具执行前 waterfall，可见真实 exec.name。
          // set() 内部即时写侧车 + 触发 mode-changed 事件（阶段二存储层）。
          if (isToolCall && execSid && execSid !== 'unknown') {
            // v0.7.2 修正（turn 计数）：升档不清零 chatTurns（避免同 turn 内多次工具调用反复清零）；
            // 只置 tool 标记，真正的清零由 pre-step 在下一轮真人消息时按 turn 结算。
            const cur = modeStore.peek(execSid);
            modeStore.set(execSid, { mode: 'work', chatTurns: cur?.chatTurns ?? 0, reason: 'tool-call', tool: true });
          }

          let meta = {};
          try {
            meta = exec?.agent?.source || exec?.meta || {};
          } catch { meta = {}; }

          let source = 'main';
          try {
            source = sourceFromMeta(meta);
          } catch { source = 'main'; }

          // 3.3：task 由状态机给出（有状态时）；无状态退关键词兜底（升档 set 后必有状态，
          // 纯注解轮/直调场景仍按文本分类）。
          const st = (execSid && execSid !== 'unknown') ? await modeStore.read(execSid) : null;
          const smTask = st ? (st.mode === 'work' ? 'agent-work' : 'chat') : null;
          let route;
          try {
            route = decideRoute({ source, text, meta, currentMode: lastSwitch.get(execSid) ? 'work' : null, strategy: cfg.privateChatWorkStrategy, task: smTask });
          } catch {
            return await next();
          }

          ensureFresh(); // 后台补拉（不阻塞）：过期才触发
          annotateRoute(exec, route);
          maybeGroupHint(ctx, exec, route);
          // JSONL 诊断：决策落盘（fire-and-forget，不阻塞工具链）
          try {
            const __sid = sidOf(exec);
            const __target = exec?.autoModelRouter?.target ?? null;
            const __ms = peekSessionMode(__sid); // v0.7.2 阶段二：状态机投影（热 Map，缺失 null）
            const __logEntry = {
              sid: __sid,
              tool: String(exec?.name ?? exec?.tool ?? ''),
              extractText: String(text ?? '').slice(0, 500),
              task: route?.task ?? '',
              route: route?.mode ?? '',
              branch: routeBranch(route), // v0.7.5 Step4 分支四：work/chat 档位来源（诊断）
              target: __target ? `${__target.provider}/${__target.model}/${__target.effort ?? '-'}` : null,
              keepReason: exec?.autoModelRouter?.keepReason ?? null,
              actualSel: null,
              mode: __ms?.mode ?? null,
              chatTurns: __ms?.chatTurns ?? null,
            };
            try { __logEntry.actualSel = readSelectionProjection(__sid); } catch { /* 读回失败留空 */ }
            appendRouteLog(__logEntry).catch(() => {});
          } catch { /* 诊断失败不阻断 */ }
          // ── v0.7.2 阶段三 3.4：pre-execute 旧文本真切降级为纯注解 ──
          // 真切以 agent/pre-step 的状态机决策为准（避免双钩子打架：文本触发的真切与
          // 状态机路由会互相覆盖，且 fire-and-forget 与 prompt 组装赛跑读不到新选择）。
          // 注解（annotateRoute）与 JSONL 诊断照写；工具升档已在上方 3.1 完成。
          return await next();
        } catch (err) {
          try {
            safeLog(ctx, 'warn', `pre-execute hook degraded: ${String(err?.message ?? err)}`);
          } catch { /* noop */ }
          try {
            return await next();
          } catch { /* next 本身抛错时不再传播 */ return { kind: 'allow' }; }
        }
    }
  };
}
