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
 * @property {(ctx: object, name: string) => any} [getService] —— 跨域（ctx 服务读取，work-tool 弹窗用）
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
    readSelectionProjection, appendRouteLog, getService,
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
            // v0.8.7 initialMode 四件套：initialMode=chat 的会话永不自动升 Work —— 工具调用也不升档。
            // v0.8.7 promptOnWorkTool：Chat 档遇到生产型工具只弹窗问一次（fire-and-forget，不阻塞工具链）；
            //   同意 → 手动切 Work（reason=manual-switch-to-work-privacy-released，承诺翻为 work）；
            //   拒绝/超时/失败 → 留 chat 且本会话不再问（workToolAsked=true 粘住，后续生产工具也不再自动升）。
            const cur = modeStore.peek(execSid);
            const curMode = cur?.mode ?? 'chat';
            let toolNameForPrompt = '';
            try { toolNameForPrompt = String(exec?.name ?? exec?.tool ?? '').trim(); } catch { toolNameForPrompt = ''; }
            // 生产型 = 会改东西的工具；read/grep/glob 只读仍走旧自动升（低风险，不打扰）。
            const isProdTool = !!toolNameForPrompt && !/^(read|grep|glob)$/i.test(toolNameForPrompt);
            const promptOn = cfg?.promptOnWorkTool !== false;
            const alreadyAsked = cur?.workToolAsked === true;
            const doAutoUpgrade = () => {
              try {
                const c2 = modeStore.peek(execSid);
                modeStore.set(execSid, { mode: 'work', chatTurns: c2?.chatTurns ?? cur?.chatTurns ?? 0, reason: 'tool-call', tool: true });
              } catch { /* noop */ }
            };
            if (curMode !== 'chat') {
              doAutoUpgrade();
            } else if (isProdTool && promptOn && !alreadyAsked) {
              // 先看有没有弹窗通道：无通道（单测/离线）= 回落旧行为直接自动升，
              // 且不消耗“只问一次”额度（workToolAsked 保持 false，后续有通道时仍可问）。
              let svc = null;
              try {
                svc = (typeof getService === 'function') ? getService(ctx, 'userQuestions') : (ctx?.userQuestions ?? null);
              } catch { svc = null; }
              if (!svc || typeof svc.ask !== 'function') {
                try { safeLog(ctx, 'info', `work-tool prompt skipped for session ${execSid} (reason=work-tool-no-provider; fallback auto-upgrade).`); } catch { /* noop */ }
                doAutoUpgrade();
              } else {
                try {
                  // 首问：同步落 asked 标记（只问一次的并发保险），本轮先记 tool=true 留 chat，等答案异步纠正。
                  try {
                    modeStore.set(execSid, { mode: 'chat', chatTurns: cur?.chatTurns ?? 0, reason: 'promptOnWorkTool-asked', tool: true, workToolAsked: true });
                  } catch { /* noop */ }
                  try { safeLog(ctx, 'info', `work-tool prompt asked for session ${execSid} (tool=${toolNameForPrompt}; timeout=${Number(cfg?.firstTurnPromptTimeoutMs) || 60000}ms).`); } catch { /* noop */ }
                  try { appendRouteLog({ sid: execSid, tool: 'work-tool/prompt-asked', mode: 'chat', reason: 'promptOnWorkTool-asked', workTool: toolNameForPrompt }).catch(() => {}); } catch { /* noop */ }
                  // fire-and-forget：绝不 await，工具链立即放行。
                  const timeoutMs = (() => { const n = Number(cfg?.firstTurnPromptTimeoutMs); return Number.isFinite(n) && n > 0 ? n : 60000; })();
                  let settled = false;
                  const finishAccept = () => {
                    if (settled) return; settled = true;
                    try {
                      // 用户同意 = 手动切 Work（隐私放行）：承诺翻为 work，后续正常升降档。
                      modeStore.set(execSid, { mode: 'work', chatTurns: (modeStore.peek(execSid)?.chatTurns ?? 0), reason: 'manual-switch-to-work-privacy-released', tool: true, workToolAsked: true, initialMode: 'work' });
                    } catch { /* noop */ }
                    try { safeLog(ctx, 'info', `work-tool prompt answered for session ${execSid}: work (reason=manual-switch-to-work-privacy-released).`); } catch { /* noop */ }
                    try { appendRouteLog({ sid: execSid, tool: 'work-tool/prompt-settled', mode: 'work', reason: 'manual-switch-to-work-privacy-released', settled: 'answered' }).catch(() => {}); } catch { /* noop */ }
                  };
                  const finishDecline = (reason) => {
                    if (settled) return; settled = true;
                    try {
                      // 拒绝/超时/失败 = 留 chat，asked 已粘住，本会话不再问也不再自动升。
                      const c3 = modeStore.peek(execSid);
                      modeStore.set(execSid, { mode: 'chat', chatTurns: c3?.chatTurns ?? 0, reason, tool: true, workToolAsked: true });
                    } catch { /* noop */ }
                    try { safeLog(ctx, 'info', `work-tool prompt settled for session ${execSid}: chat (reason=${reason}).`); } catch { /* noop */ }
                    try { appendRouteLog({ sid: execSid, tool: 'work-tool/prompt-settled', mode: 'chat', reason, settled: reason.includes('timeout') ? 'timeout' : 'declined' }).catch(() => {}); } catch { /* noop */ }
                  };
                  let selfTimer = null;
                  try {
                    selfTimer = setTimeout(() => finishDecline('work-tool-timeout'), timeoutMs + 1000);
                    if (selfTimer && typeof selfTimer.unref === 'function') try { selfTimer.unref(); } catch { /* noop */ }
                  } catch { /* noop */ }
                  let ctl = null;
                  try {
                    ctl = new AbortController();
                    setTimeout(() => { try { ctl.abort(); } catch { /* noop */ } }, timeoutMs);
                    if (typeof ctl.signal === 'object') { /* signal 挂到请求上 */ }
                  } catch { ctl = null; }
                  const req = {
                    questions: [{
                      id: 'work-tool-switch',
                      question: `检测到生产型工具调用（${toolNameForPrompt}），当前是 Chat 档（省钱模式），是否切换到 Work 档（能力模式）？`,
                      header: '档位确认',
                      options: [
                        { label: 'Work 档（能力模式）', description: '切换到 Work 档干活，用免费池最强模型' },
                        { label: 'Chat 档（省钱模式）', description: '留在 Chat 档，本会话不再询问' },
                      ],
                    }],
                  };
                  if (ctl?.signal) req.signal = ctl.signal;
                  // live agent 优先：exec.agent 是 ToolExecution 形状时不一定是 live root，能带才带。
                  try {
                    const liveAgent = exec?.agent;
                    if (liveAgent && typeof liveAgent === 'object' && (liveAgent.session && typeof liveAgent.session === 'object')) req.agent = liveAgent;
                  } catch { /* agentless 降级 */ }
                  Promise.resolve().then(() => svc.ask(req)).then((ans) => {
                    try { if (selfTimer) clearTimeout(selfTimer); } catch { /* noop */ }
                    if (settled) return;
                    let selected = '';
                    try { selected = ans?.answers?.[0]?.selected?.[0] ?? ans?.answers?.[0]?.answer ?? ''; } catch { selected = ''; }
                    if (String(selected).includes('Work')) finishAccept();
                    else finishDecline('work-tool-declined');
                  }).catch(() => {
                    try { if (selfTimer) clearTimeout(selfTimer); } catch { /* noop */ }
                    if (!settled) finishDecline('work-tool-error');
                  });
                } catch {
                  // 弹窗组装失败 = 回落自动升（不阻断、不丢工具信号）。
                  try { doAutoUpgrade(); } catch { /* noop */ }
                }
              } // 有通道分支结束（无通道已在上方回落自动升，不耗只问一次额度）
            } else if (isProdTool && promptOn && alreadyAsked) {
              // 已问过（上次拒绝/超时）：留 chat，只记 tool 标记供 pre-step 结算，不再弹窗、不自动升。
              try {
                modeStore.set(execSid, { mode: 'chat', chatTurns: cur?.chatTurns ?? 0, reason: 'promptOnWorkTool-asked-once-keep', tool: true, workToolAsked: true });
              } catch { /* noop */ }
              try { safeLog(ctx, 'info', `pre-execute keep ${execSid} on chat (reason=promptOnWorkTool-asked-once-keep; tool=${toolNameForPrompt}).`); } catch { /* noop */ }
            } else if (cur?.initialMode === 'chat') {
              try { safeLog(ctx, 'info', `pre-execute keep ${execSid} on chat (reason=initial-mode-chat-keep; tool=${String(exec?.name ?? exec?.tool ?? '')}).`); } catch { /* noop */ }
            } else {
              modeStore.set(execSid, { mode: 'work', chatTurns: cur?.chatTurns ?? 0, reason: 'tool-call', tool: true });
            }
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
