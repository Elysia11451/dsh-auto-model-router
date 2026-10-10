// first-turn / impl / prompt —— 新会话首轮模式的建立与弹窗。
// 回答的问题：这是不是新会话第一轮？该默认什么？要不要弹窗问用户？
//
// 口径锁定（v0.8.0）：getService(ctx,'userQuestions') + 带 live agent + 群聊不弹；
// 任何失败（NO_PROVIDER / 超时 / child agent / abort）一律降级 chat，绝不阻塞。
//
// v0.8.6 issues NTR 1：ask 实际派出时返回 firstTurnPending=true —— 调用方（pre-step）本轮只注解
// 不真切，等弹窗答案落定后下一轮再切；否则首轮默认 chat 真切会覆盖用户手选 work 档模型。
// v0.8.6 issues NTR 2：IM session 就绪探针 + asked/settled 双落盘（jsonl）+ 自超时（ask 无视
// AbortSignal 悬挂时的兜底）+ NO_PROVIDER 显式 warn（IM 桥吞掉时给提示）。
//
// 拆分铁律：本文件不 import 本域 interface.js；isGroupMeta 属 routing-policy，
// 经 deps 注入，不跨域 import 实现。
import { createAskTimeout, askErrorReason } from './timing.js';

/**
 * @typedef {object} FirstTurnPromptDeps
 * @property {object} ctx
 * @property {object} cfg                         —— 稳定配置对象
 * @property {{set: Function, read: Function}} modeStore
 * @property {(ctx: object, name: string) => any} getService
 * @property {(ctx: object, level: string, msg: string) => void} safeLog
 * @property {(meta: object) => boolean} isGroupMeta —— 跨域注入（routing-policy）
 * @property {(entry: object) => Promise<void>} [appendRouteLog] —— 跨域注入（telemetry，可缺省）
 */

/**
 * 建立新会话首轮状态（群默认 / 关闭弹窗 / pending + 后台弹窗）。
 * 行为与 v0.8.0 原内联块一致：先落 chat，再异步弹窗纠正（fire-and-forget）。
 *
 * @param {object} o
 * @param {string} o.sid
 * @param {object} o.meta
 * @param {any}    o.agent —— pre-step 的 live runtime root（child 会被 DELEGATED_CALLER 拒）
 * @param {FirstTurnPromptDeps} d
 * @returns {{mode: string, chatTurns: number, firstTurnPending: boolean}} st
 *   firstTurnPending=true 仅表示"本轮 ask 已实际派出、答案未回"（调用方本轮只注解不真切）；
 *   其余一切路径（群默认/关闭/无 provider/同步失败）均为 false。
 */
export function establishFirstTurnState(o, d) {
  const { ctx, cfg, modeStore, getService, safeLog, isGroupMeta, appendRouteLog, classifyTask } = d;
  const { sid, meta, agent, text = '', source = '' } = o;
  // 已有记录的 sid 直接跳过弹窗（老会话误弹修复：pre-step read  miss 后的二次保险）
  try {
    const existing = modeStore?.peek?.(sid);
    if (existing && (existing.mode === 'work' || existing.mode === 'chat')) {
      return { mode: existing.mode, chatTurns: existing.chatTurns ?? 0, firstTurnPending: false };
    }
  } catch { /* peek 失败走正常首轮流程 */ }
  const logJsonl = (entry) => {
    try {
      if (typeof appendRouteLog === 'function') appendRouteLog(entry).catch(() => {});
    } catch { /* 诊断失败不阻断 */ }
  };

  // v0.8.0 首轮弹窗（异步纠正）：新会话首轮先默认 chat 放行，弹窗答案回来再纠正。
  // 口径锁定：getService(ctx,'userQuestions') + 带 live agent + 不 await + 群聊不弹。
  // v0.7.8 旧预判 fallback（保留作安全网，弹窗验证通过前不删）：
  //   const first = source === 'main' ? 'work' : (kwHit ? 'work' : 'chat');
  // 现默认 chat 放行，第二轮关键词升档（keyword-upgrade）自然纠正；旧分支仅注释保留。
  if (isGroupMeta(meta)) {
    modeStore.set(sid, { mode: 'chat', chatTurns: 0, reason: 'first-turn-group-default' });
    return { mode: 'chat', chatTurns: 0, firstTurnPending: false };
  }
  if (cfg.firstTurnPrompt === false) {
    modeStore.set(sid, { mode: 'chat', chatTurns: 0, reason: 'first-turn-disabled' });
    return { mode: 'chat', chatTurns: 0, firstTurnPending: false };
  }
  // v0.8.6.1-preview（底线降级）：IM 首轮跳过 ask，直接按关键词定初始档。
  // 纠正：HTTP 投递探针实测成功（{"sent":true}，QQ 已收到），不存在“无投递服务”；
  // 本版为保发版时效放弃消息往返，不取 dshIm、不挂起、不 pending。
  // v0.8.7 审计 P0-6：旧版无条件落 chat = IM 首轮忽略关键词（干活指令首条被判闲聊，
  //   要等第二轮 keyword-upgrade 才纠回）→ 改用 classifyTask(text) 定初始模式；
  //   第二轮 keyword-upgrade 语义不变（已 work 则不重复升）。群聊/关弹窗分支仍先于本分支（不变）。
  if (source === 'im') {
    const imMode = (typeof classifyTask === 'function' && classifyTask(text) === 'agent-work') ? 'work' : 'chat';
    const imReason = imMode === 'work' ? 'first-turn-im-keyword-work' : 'first-turn-im-default-chat';
    modeStore.set(sid, { mode: imMode, chatTurns: 0, reason: imReason });
    logJsonl({ sid, tool: 'first-turn/im-keyword', mode: imMode, reason: imReason });
    return { mode: imMode, chatTurns: 0, firstTurnPending: false };
  }
  modeStore.set(sid, { mode: 'chat', chatTurns: 0, reason: 'first-turn-pending' });
  let asked = false; // ask 是否实际派出（issues NTR 1 pending 标记的唯一依据）
  try {
    const __svc = getService(ctx, 'userQuestions');
    if (!__svc || typeof __svc.ask !== 'function') {
      // v0.8.7 审计 P0-6：ask provider 缺席（main 通道也弹不了窗）→ 同样用 classifyTask 定初始档，
      //   不再无条件 chat（否则干活指令首轮被判闲聊，成本与轮次都浪费在错误档位）。
      const npMode = (typeof classifyTask === 'function' && classifyTask(text) === 'agent-work') ? 'work' : 'chat';
      modeStore.set(sid, { mode: npMode, chatTurns: 0, reason: 'first-turn-no-provider' });
      try { safeLog(ctx, 'info', `first-turn prompt skipped for session ${sid} (reason=first-turn-no-provider; mode=${npMode}).`); } catch { /* noop */ }
      logJsonl({ sid, tool: 'first-turn/prompt-settled', mode: npMode, reason: 'first-turn-no-provider', settled: 'skipped', err: 'no-provider' });
      return { mode: npMode, chatTurns: 0, firstTurnPending: false };
    }
    // v0.8.6 issues NTR 2 探针：IM 桥 session 绑定就绪检查（#D 返回 null 透传是零触发主因之一）。
    // 只记录、不拦截：绑定未就绪也照常 ask（宿主 Web 端 waterfall 仍可能认领），诊断靠这一行二选一。
    let __hasAgent = false;
    let __hasSession = false;
    let __sidPresent = false;
    try {
      __hasAgent = !!agent;
      __hasSession = !!(agent && agent.session);
      __sidPresent = !!sid && sid !== 'unknown';
    } catch { /* 探针失败不阻断 */ }
    const __sessionReady = __hasAgent && __hasSession && __sidPresent;
    logJsonl({
      sid,
      tool: 'first-turn/probe',
      hasAgent: __hasAgent,
      hasSession: __hasSession,
      sidPresent: __sidPresent,
      sessionReady: __sessionReady,
    });
    const __to = createAskTimeout(cfg.firstTurnPromptTimeoutMs);
    try { safeLog(ctx, 'info', `first-turn prompt asked for session ${sid} (timeout=${__to.timeoutMs}ms; sessionReady=${__sessionReady}).`); } catch { /* noop */ }
    logJsonl({
      sid,
      tool: 'first-turn/prompt-asked',
      timeoutMs: __to.timeoutMs,
      sessionReady: __sessionReady,
      hasAgent: __hasAgent,
      hasSession: __hasSession,
    });
    // v0.8.0 指令：必须带 live agent，否则 Web 应答器收不到（NO_PROVIDER）。
    // payload.agent = pre-step 的 live runtime root；child agent 会被拒（DELEGATED_CALLER→降级 chat）。
    // 前置检查：child agent 不传 agent，走降级避免 DELEGATED_CALLER。
    // 根因：userQuestions 要求 exact live runtime root，child 会被 DELEGATED_CALLER 拒绝。
    // 保护：仅当能确认为 child（agents.roots() 非空且不含 agent）时才跳过；roots 空/异常不误判。
    let __isChildAgent = false;
    try {
      const __agentsSvc = getService(ctx, 'agents');
      if (agent && __agentsSvc && typeof __agentsSvc.roots === 'function') {
        const __roots = __agentsSvc.roots();
        if (Array.isArray(__roots) && __roots.length > 0) __isChildAgent = !__roots.includes(agent);
      }
    } catch { __isChildAgent = false; }
    const __req = {
      questions: [{
        id: 'init-mode',
        question: '本轮对话请选择模式',
        header: '模式选择',
        options: [
          { label: 'Chat 档（省钱模式）', description: '闲聊、日常对话，使用自有 API，成本最低' },
          { label: 'Work 档（能力模式）', description: '干活、调试、代码任务，使用免费池最强模型' },
        ],
      }],
      signal: __to.signal,
    };
    try {
      if (agent && !__isChildAgent) __req.agent = agent;
      else if (__isChildAgent) {
        try { safeLog(ctx, 'info', `first-turn prompt skipped for session ${sid} (reason=first-turn-child-agent; child has no answerer).`); } catch { /* noop */ }
      }
    } catch { /* 无 agent 字段则降级为 agentless */ }
    // v0.8.6 issues NTR 2 自超时：ask 可能无视 AbortSignal 悬挂（IM 桥吞掉 NO_PROVIDER 后永不 settle），
    // 只靠 signal 会在 QQ 侧挂到 60s 无感知。自定时器与 signal 同超时（+1s 让 signal 路径先赢），
    // 先落定者赢、迟到答案不再覆盖（与"超时后 abort 拒收"语义一致）。
    let __settled = false;
    let __selfTimer = null;
    const __finish = (mode, reason, msg, level, extra) => {
      if (__settled) return;
      __settled = true;
      try { __to.clear(); } catch { /* noop */ }
      try { if (__selfTimer) clearTimeout(__selfTimer); } catch { /* noop */ }
      // v0.8.7 initialMode 四件套：仅 answered 分支写 initialMode 承诺（首轮弹窗实答）。
      // timeout / reject / 群聊 / IM / 无 provider 一律不写，保持旧行为测试绿；
      // set 缺 initialMode 键时沿用旧值（新会话即 null），hydrate 同理保留。
      const settledKind = extra?.settled;
      if (settledKind === 'answered') {
        modeStore.set(sid, { mode, chatTurns: 0, reason, initialMode: mode });
      } else {
        modeStore.set(sid, { mode, chatTurns: 0, reason });
      }
      // 1a 探针（只读诊断，不改状态、不调 selectModel）：dump 会话服务/回调上下文/modeStore。
      try {
        const __sessionsSvc = getService(ctx, 'sessions');
        const __ctrl = getService(ctx, 'sessionController');
        const __peek = (() => { try { return modeStore?.peek?.(sid) ?? null; } catch { return null; } })();
        logJsonl({
          sid, tool: 'first-turn/probe-1a',
          sessionsSvcKeys: (() => { try { return Object.keys(__sessionsSvc ?? {}).slice(0, 20); } catch { return []; } })(),
          sessionsHasSelectModel: !!(__sessionsSvc && typeof __sessionsSvc.selectModel === 'function'),
          ctxSessionsKeys: (() => { try { return Object.keys(ctx?.sessions ?? {}).slice(0, 20); } catch { return []; } })(),
          ctxSessionsHasSelectModel: !!(ctx?.sessions && typeof ctx.sessions.selectModel === 'function'),
          controllerKeys: (() => { try { return Object.keys(__ctrl ?? {}).slice(0, 20); } catch { return []; } })(),
          controllerHasSelectModel: !!(__ctrl && typeof __ctrl.selectModel === 'function'),
          agentPresent: !!agent,
          agentSession: (() => { try { const s = agent?.session; return typeof s === 'string' ? s : (s?.header?.id ?? s?.id ?? null); } catch { return null; } })(),
          modeStorePeek: __peek ? { mode: __peek.mode ?? null, initialMode: __peek.initialMode ?? null, reason: __peek.reason ?? null } : null,
          finishMode: mode, finishReason: reason, settledKind: settledKind ?? null, selected: extra?.selected ?? null,
        });
      } catch { /* 探针失败不阻断 */ }
      try { safeLog(ctx, level, msg); } catch { /* noop */ }
      logJsonl({ sid, tool: 'first-turn/prompt-settled', mode, reason, ...(extra || {}) });
    };
    try {
      __selfTimer = setTimeout(() => {
        __finish(
          'chat',
          'first-turn-timeout',
          `first-turn prompt self-timeout for session ${sid} (reason=first-turn-timeout; ask ignored abort after ${__to.timeoutMs}ms, check IM bridge binding).`,
          'warn',
          { settled: 'self-timeout' },
        );
      }, __to.timeoutMs + 1000);
      if (__selfTimer && typeof __selfTimer.unref === 'function') {
        try { __selfTimer.unref(); } catch { /* noop */ }
      }
    } catch { /* 自超时挂失败不阻断（signal 超时仍在） */ }
    asked = true; // ask 即将派出：本轮 firstTurnPending=true，调用方只注解不真切（issues NTR 1）
    __svc.ask(__req).then((ans) => {
      if (__settled) return; // 自超时已先落定，迟到答案不再覆盖
      let selected = '';
      try { selected = ans?.answers?.[0]?.selected?.[0] ?? ans?.answers?.[0]?.answer ?? ''; } catch { selected = ''; }
      if (String(selected).includes('Work')) {
        __finish(
          'work',
          'first-turn-prompt',
          `first-turn prompt answered for session ${sid}: work (reason=first-turn-prompt).`,
          'info',
          { settled: 'answered', selected: String(selected).slice(0, 80) },
        );
      } else {
        __finish(
          'chat',
          'first-turn-prompt-chat',
          `first-turn prompt answered for session ${sid}: chat (reason=first-turn-prompt-chat).`,
          'info',
          { settled: 'answered', selected: String(selected).slice(0, 80) },
        );
      }
    }).catch((err) => {
      if (__settled) return; // 自超时已先落定，迟到拒绝不再覆盖
      const code = err?.code ?? err?.name ?? '';
      const reason = askErrorReason(err);
      // issues NTR 2：NO_PROVIDER 显式 warn（IM 桥吞掉后 QQ 侧零感知，日志里必须一眼可见）。
      const level = reason === 'first-turn-no-provider' ? 'warn' : 'info';
      const hint = reason === 'first-turn-no-provider'
        ? ' (no answerer claimed the prompt; IM bridge may have swallowed NO_PROVIDER — QQ first-turn degrades to silent chat, next-round keyword-upgrade corrects)'
        : '';
      __finish(
        'chat',
        reason,
        `first-turn prompt settled for session ${sid}: chat (reason=${reason}; err=${String(code || err?.message || err).slice(0, 120)}).${hint}`,
        level,
        { settled: 'rejected', err: String(code || err?.message || err).slice(0, 120) },
      );
    });
  } catch { /* 弹窗失败保持 chat */ }
  return { mode: 'chat', chatTurns: 0, firstTurnPending: asked };
}
