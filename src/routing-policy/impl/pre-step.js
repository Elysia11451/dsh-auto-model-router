// routing-policy / impl / pre-step —— agent/pre-step 钩子主体（单咽喉）。
// 回答的问题：这一条真人消息进来 → 取文本 → 状态机定 task → 路由 → 要不要真切？
//
// 纪律：本 handler 只做「取文本 → 复用既有判定/注解/真切」，不改 decideRoute /
// manualKeepReason / annotateRoute / realSwitch 任何一行路由核心逻辑。
// 安全阀：任何异常都放行，绝不阻断这一步。
//
// 拆分铁律：本文件不 import 本域 interface.js；跨域（first-turn / leaderboard /
// switch-controller / telemetry）一律经 deps 注入。域内纯函数直接 import 同域 impl。
import { extractUserText, hasPendingToolCalls, textSig, classifyTask, isGroupMeta, sourceFromMeta } from './classifier.js';
import { decideRoute, nextSessionMode } from './decider.js';

/**
 * @typedef {object} PreStepDeps
 * @property {object} ctx
 * @property {object} cfg
 * @property {{freeModelOk: boolean}} flags
 * @property {(ctx: object, level: string, msg: string) => void} safeLog
 * @property {(exec: any) => string} sidOf
 * @property {{read: Function, set: Function, peek: Function}} modeStore
 * @property {(sid: string) => any} peekSessionMode
 * @property {Map<string, string>} lastSwitch
 * @property {Function} establishFirstTurnState      —— 跨域（first-turn）
 * @property {() => void} ensureFresh                —— 跨域（leaderboard）
 * @property {Function} annotateRoute                —— 域内实例（decider）
 * @property {Function} maybeGroupHint               —— 域内实例（decider）
 * @property {Function} routeBranch                  —— 域内实例（decider）
 * @property {Function} readSelectionForRoute        —— 跨域（switch-controller）
 * @property {Function} applyPriorityMode            —— 跨域（switch-controller）
 * @property {Function} manualKeepReason             —— 跨域（switch-controller）
 * @property {Function} shouldSwitch                 —— 跨域（switch-controller）
 * @property {Function} realSwitch                   —— 跨域（switch-controller）
 * @property {(entry: object) => Promise<void>} appendRouteLog —— 跨域（telemetry）
 * @property {Function} firstTurnDeps                —— 首轮弹窗的依赖包（原样转交 first-turn）
 */

export function createPreStepHandler(d) {
  const {
    ctx, cfg, flags, safeLog, sidOf, modeStore, peekSessionMode, lastSwitch,
    establishFirstTurnState, ensureFresh, annotateRoute, maybeGroupHint, routeBranch,
    readSelectionForRoute, applyPriorityMode, manualKeepReason, shouldSwitch, realSwitch,
    appendRouteLog, firstTurnDeps,
  } = d;

  const stepRouted = new Map(); // sid|turn|textSig -> 已路由时间戳（同一轮只判一次）
  const stepProbed = new Set(); // sid|turn -> 已记录过"取不到文本"的形状探针（每轮只探一次）
  const stepSkipped = new Set(); // sid|turn -> 已记录过"系统注入跳过"（每轮只记一次）

  return async function preStepHandler(payload, next) {
    try {
      const agent = payload?.agent;
      const holder = { agent };
      const sid = sidOf(holder);
      const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
      const { text, skipReason, rejectedText } = extractUserText(msgs);
      if (!text) {
        // v0.7.1 来源过滤：本步输入是系统/插件注入的重试通知等（非真人消息）→
        // 一律跳过路由决策，保持当前模型不变；落一行 reason=system-retry-skipped 便于验证。
        if (skipReason === 'system-retry-skipped') {
          const skey = `${sid || 'unknown'}|${payload?.turn ?? '?'}`;
          if (!stepSkipped.has(skey)) {
            if (stepSkipped.size > 500) stepSkipped.clear();
            stepSkipped.add(skey);
            try {
              let actual = null;
              try { actual = readSelectionForRoute(sid); } catch { actual = null; }
              appendRouteLog({
                sid,
                tool: 'agent/pre-step/skip',
                extractText: String(rejectedText ?? '').slice(0, 300),
                task: '', route: '', target: null,
                keepReason: 'system-retry-skipped',
                reason: 'system-retry-skipped',
                actualSel: actual,
                turn: payload?.turn ?? null,
                step: payload?.step ?? null,
              }).catch(() => {});
            } catch { /* 跳过日志失败不阻断 */ }
          }
          return await next();
        }
        // 形状探针：取不到文本 ≠ 没有轮次。每 (sid,turn,step) 记一次角色形状，
        // 阶段一若失败，这一行就是定位"消息形状对不上"的唯一线索。
        if (msgs.length) {
          const pkey = `${sid || 'unknown'}|${payload?.turn ?? '?'}|${payload?.step ?? '?'}`;
          if (!stepProbed.has(pkey)) {
            if (stepProbed.size > 500) stepProbed.clear();
            stepProbed.add(pkey);
            try {
              const roles = msgs.map((m) => `${m?.role ?? '?'}/${m?.source?.kind ?? '-'}`).slice(0, 12).join(',');
              appendRouteLog({
                sid,
                tool: 'agent/pre-step/probe',
                extractText: `[no-user-text] n=${msgs.length} roles=${roles}`,
                task: '', route: '', target: null, keepReason: null, actualSel: null,
                turn: payload?.turn ?? null, step: payload?.step ?? null,
              }).catch(() => {});
            } catch { /* 探针失败不阻断 */ }
          }
        }
        return await next();
      }
      const key = `${sid || 'unknown'}|${payload?.turn ?? '?'}|${textSig(text)}`;
      if (stepRouted.has(key)) return await next();
      if (stepRouted.size > 500) stepRouted.clear(); // 有界，防长期常驻泄漏
      stepRouted.set(key, Date.now());

      let meta = {};
      try { meta = agent?.source || {}; } catch { meta = {}; }
      let source = 'main';
      try { source = sourceFromMeta(meta); } catch { source = 'main'; }

      // ── v0.7.2 阶段三 3.2/3.3/3.5：状态机路由（本步 task 的唯一权威来源）──
      // 优先级（与设计一致）：
      //   1. isHumanInput 过滤（上方 extractUserText，已跳过的轮次到不了这里 → 计数冻结）
      //   2. 手动选择优先（下方 realSwitch 内 manualKeepReason，不动）
      //   3. 状态机：sessionMode==='work' → agent-work；==='chat' → chat
      //   4. 关键词预判：仅无状态新会话首轮定初始模式（不再全局判定）
      let smTask = null; // null = 状态机异常降级：decideRoute 内退回关键词分类（旧行为兜底）
      let firstTurnPending = false; // v0.8.6 issues NTR 1：首轮 ask 已派出 → 本轮只注解不真切
      try {
        const kwHit = classifyTask(text) === 'agent-work'; // 关键词信号（仅首轮预判 + 降档计数防抖）
        const pending = hasPendingToolCalls(msgs);         // 任务进行中 → 冻结降档
        let st = await modeStore.read(sid);                // Map 优先，缺失读侧车（幂等 hydrate）
        if (!st) {
          const fst = establishFirstTurnState({ sid, meta, agent, text, source }, firstTurnDeps);
          st = fst;
          firstTurnPending = fst?.firstTurnPending === true;
        } else {
          // v0.7.2 修正（turn 计数）：降档计数按真人 turn 结算。
          // 本分支每真人 turn 只进一次（stepRouted 按 sid|turn|textSig 去重），语义 = 一个 turn。
          // 结算顺序：①本 turn 有真实工具调用（tool 标记，pre-execute 置位）→ 清零计数并消费标记；
          // ②无工具调用 → 关键词防抖（有 kw 清零）否则 chatTurns+1，>=3 降 chat。
          // pending（任务进行中）→ 冻结计数。观测型工具永不置 tool 标记（pre-execute 已排除）。
          const hadTool = st.tool === true;
          // 先消费标记（无论哪条分支，标记只活一个 turn）
          let next;
          let why;
          if (hadTool) {
            // 有真实工具调用（上一 turn 的工具在本 turn 消费）：本 turn 即新 turn 的起点。
            // 边界1：本轮又有关键词（新工作指令）→ 不计数，保持 work/0。
            // 边界2：本轮稍后又有新工具调用 → pre-execute 会重新置 tool 标记，
            //   下一轮重新消费，计数永不推进（持续干活不降档）。
            // 无关键词：本轮就是第 1 轮闲聊，直接起计 chatTurns=1（省掉清零轮，多一轮的问题）。
            if (kwHit) {
              next = { mode: 'work', chatTurns: 0 };
            } else {
              next = { mode: 'work', chatTurns: 1 };
            }
            why = 'tool-call';
          } else {
            const effKw = kwHit;
            next = nextSessionMode(st.mode, false, effKw, st.chatTurns, { pendingToolCalls: pending });
            why = next.mode !== st.mode ? (next.mode === 'work' ? 'keyword-upgrade' : 'idle-3-turns') : 'chat-turn-count';
          }
          if (next.mode !== st.mode || next.chatTurns !== st.chatTurns || hadTool) {
            modeStore.set(sid, {
              mode: next.mode,
              chatTurns: next.chatTurns,
              tool: false,
              reason: why,
            });
            st = { mode: next.mode, chatTurns: next.chatTurns, tool: false };
          }
        }
        smTask = st.mode === 'work' ? 'agent-work' : 'chat';
      } catch { /* 状态机失败保守回 chat 关键词兜底（decideRoute 内 classifyTask） */ }

      let route;
      try {
        route = decideRoute({ source, text, meta, currentMode: lastSwitch.get(sid) ? 'work' : null, strategy: cfg.privateChatWorkStrategy, task: smTask });
      } catch { return await next(); }

      ensureFresh(); // 与 pre-execute 一致：过期才后台补拉
      annotateRoute(holder, route);
      maybeGroupHint(ctx, holder, route);

      // JSONL 诊断：纯聊天轮第一次有落盘（tool=agent/pre-step）
      try {
        const target = holder?.autoModelRouter?.target ?? null;
        const ms = peekSessionMode(sid); // v0.7.2 阶段二：状态机投影（热 Map，缺失 null）
        const logEntry = {
          sid,
          tool: 'agent/pre-step',
          extractText: String(text).slice(0, 500),
          task: route?.task ?? '',
          route: route?.mode ?? '',
          branch: routeBranch(route), // v0.7.5 Step4 分支四：work/chat 档位来源（诊断）
          target: target ? `${target.provider}/${target.model}/${target.effort ?? '-'}` : null,
          keepReason: holder?.autoModelRouter?.keepReason ?? null,
          actualSel: null,
          turn: payload?.turn ?? null,
          step: payload?.step ?? null,
          mode: ms?.mode ?? null,
          chatTurns: ms?.chatTurns ?? null,
        };
        try { logEntry.actualSel = readSelectionForRoute(sid); } catch { /* 读回失败留空 */ }
        appendRouteLog(logEntry).catch(() => {});
      } catch { /* 诊断失败不阻断 */ }

      // 真切：与 pre-execute 同一套短路（手动优先 / 同类保留）。
      // 差别只有一处：这里 await + 1500ms 上限，让选择在本步 prompt 组装前落定；
      // fire-and-forget 会与组装赛跑，纯聊天轮极易读不到新选择。
      try {
        const target = holder?.autoModelRouter?.target;
        const origTargetStr = target ? `${target.provider}/${target.model}/${target.effort ?? '-'}` : null;
        // v0.7.5 Step4 分支一：enabled=false ⇒ 插件只记日志不切换模型。
        // decision 行照写（keepReason=enabled-off），target 置 null = 本轮不真切。
        if (target && sid && sid !== 'unknown' && cfg?.enabled === false) {
          holder.autoModelRouter.target = null;
          holder.autoModelRouter.keepReason = 'enabled-off';
          safeLog(ctx, 'info', `pre-step skip switch for ${sid} (reason=enabled-off; target=${origTargetStr ?? '-'}; log-only mode).`);
        } else if (firstTurnPending && target && sid && sid !== 'unknown') {
          // v0.8.6 issues NTR 1：首轮 ask 已派出、答案未回 → 本轮只注解不真切。
          // 首轮默认 chat 真切会覆盖用户手选 work 档模型（issues NTR 1）；等弹窗答案落定
          // （modeStore.set reason=first-turn-prompt*）后，下一轮状态机自然给出正确路由再切。
          holder.autoModelRouter.target = null;
          holder.autoModelRouter.keepReason = 'first-turn-pending';
          safeLog(ctx, 'info', `pre-step skip switch for ${sid} (reason=first-turn-pending; prompt answer unsettled, annotate-only this round).`);
        } else if (target && sid && sid !== 'unknown' && flags.freeModelOk !== false) {
          let keep = null;
          try { keep = applyPriorityMode(manualKeepReason(sid, null, route?.mode ?? ''), sid, 'pre-step'); } catch { keep = null; }
          if (keep) {
            holder.autoModelRouter.target = null;
            holder.autoModelRouter.keepReason = keep;
            safeLog(ctx, 'info', `pre-step kept session ${sid} on ${readSelectionForRoute(sid)} (${keep}; routing skipped).`);
          } else {
            const actual = readSelectionForRoute(sid);
            if (actual === '(projection-unreadable)') {
              // 修复点二：读不出当前模型就不能盲切（否则可能覆盖用户手动选择）。
              // 降级为保守不覆盖，并把原因写进注解与日志，便于事后核对。
              holder.autoModelRouter.target = null;
              holder.autoModelRouter.keepReason = 'projection-unreadable-fallback';
              safeLog(ctx, 'warn', `pre-step kept session ${sid} on unknown (reason=projection-unreadable-fallback; conservative no-override).`);
            } else if (shouldSwitch(actual, target) === null) {
              holder.autoModelRouter.target = null;
              holder.autoModelRouter.keepReason = 'same-kind-kept';
              safeLog(ctx, 'info', `pre-step kept session ${sid} on ${actual} (manual choice respected, no switch).`);
            } else {
              const sw = await Promise.race([
                realSwitch(sid, target, route?.mode ?? ''),
                new Promise((resolve) => { const t = setTimeout(() => resolve({ ok: false, reason: 'pre-step-timeout' }), 1500); if (typeof t.unref === 'function') t.unref(); }),
              ]).catch(() => null);
              try {
                holder.autoModelRouter.switched = sw?.ok ?? null;
                if (sw && !sw.ok) holder.autoModelRouter.switchError = sw.reason ?? 'unknown';
              } catch { /* noop */ }
            }
          }
        }
        // 决策后补一条：keepReason / 真实读回 / 是否真切，阶段二核对全靠这行
        try {
          const dms = peekSessionMode(sid); // v0.7.2 阶段二：状态机投影（热 Map，缺失 null）
          const decision = {
            sid,
            tool: 'agent/pre-step/decision',
            extractText: String(text).slice(0, 300),
            task: route?.task ?? '',
            route: route?.mode ?? '',
            branch: routeBranch(route), // v0.7.5 Step4 分支四：work/chat 档位来源（诊断）
            target: origTargetStr,
            keepReason: holder?.autoModelRouter?.keepReason ?? null,
            switched: holder?.autoModelRouter?.switched ?? null,
            switchError: holder?.autoModelRouter?.switchError ?? null,
            actualSel: null,
            turn: payload?.turn ?? null,
            step: payload?.step ?? null,
            mode: dms?.mode ?? null,
            chatTurns: dms?.chatTurns ?? null,
          };
          try { decision.actualSel = readSelectionForRoute(sid); } catch { decision.actualSel = null; }
          appendRouteLog(decision).catch(() => {});
        } catch { /* 诊断失败不阻断 */ }
      } catch { /* 真切失败不影响放行 */ }
      return await next();
    } catch (err) {
      try {
        safeLog(ctx, 'warn', `pre-step hook degraded: ${String(err?.message ?? err)}`);
      } catch { /* noop */ }
      // 放行优先：路由判失败也绝不阻断这一步
      return await next();
    }
  };
}
