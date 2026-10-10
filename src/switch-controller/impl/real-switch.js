// switch-controller / impl / real-switch —— 「现在真切吗？真切成什么样？」的唯一咽喉。
// 回答的问题：能不能切（手动保持/同类/冷却/门控）？怎么切（payload/无 effort 重试/读回确认）？
//
// 真切：sessionId 直传 + effort 归一化 + 无 effort 菜单自动省略重试。
// saveSelection 已被拦截（report-only）；若拦截未生效，realSwitch 内仍有"切前默认写回"兜底。
// 任何异常都吞掉：真切失败只降级为注解模式，绝不阻断工具链。
// 权威读回：model/selection 投影（sessionProjections.stateOf）。
// 绝不读 exec.agent.model（官方无此字段）；读不到回退本插件切换缓存。
//
// 拆分铁律：本文件不 import 本域 interface.js，也不 import 其他域的实现 ——
// 跨域（路由判定纯函数 / 动态选模 / 已知对集合）一律经 deps 注入。

/**
 * @typedef {object} RealSwitchDeps
 * @property {object} ctx
 * @property {object} cfg                       —— 稳定配置对象（原地更新）
 * @property {{saveIntercepted: boolean}} flags
 * @property {(ctx: object, name: string) => any} getService
 * @property {(ctx: object, level: string, msg: string) => void} safeLog
 * @property {Map<string, string>} lastSwitch   —— 本插件切换台账
 * @property {{switchState: Map<string, number>, gate: Function}} cooldown
 * @property {() => string[]} knownWorkPairs    —— 跨域注入（routing-policy）
 * @property {() => string} currentWorkModel    —— 跨域注入（leaderboard）
 * @property {Function} resolveChatTarget       —— 跨域注入（routing-policy）
 * @property {Function} isColdStartCrossKind    —— 跨域注入（routing-policy）
 * @property {Function} isUnknownDrift          —— 跨域注入（routing-policy）
 * @property {Function} isSameKind              —— 跨域注入（routing-policy）
 * @property {Function} buildSelectModelPayload —— 跨域注入（routing-policy）
 * @property {string} DEFAULT_WORK_MODEL        —— 跨域注入（leaderboard）
 */

export function createRealSwitch(d) {
  const {
    ctx, cfg, flags, getService, safeLog, lastSwitch, cooldown,
    knownWorkPairs, currentWorkModel,
    resolveChatTarget, isColdStartCrossKind, isUnknownDrift, isSameKind,
    buildSelectModelPayload, DEFAULT_WORK_MODEL,
  } = d;
  const { switchState, gate: cooldownGate } = cooldown;

  // v0.8.7 步骤10（save-guard 收窄）：路由自己发起的 selectModel 期间开窗 ——
  // 进窗 flags.saveWindow +1，出窗（含异常）-1；save-guard 仅在窗口深度 >0 时把
  // saveSelection 变 report-only，窗口外用户手动选择照常写 settings。计数 + finally 配对，嵌套安全。
  const withSaveWindow = async (fn) => {
    flags.saveWindow = (Number(flags.saveWindow) || 0) + 1;
    try { return await fn(); }
    finally { flags.saveWindow = Math.max(0, (Number(flags.saveWindow) || 1) - 1); }
  };

  // 同步版：pre-execute 热路径用（服务引用由调用方保证新鲜）。
  function readSelectionProjection(sid, services = null) {
    try {
      const sp = services?.sp ?? getService(ctx, 'sessionProjections');
      const sessionsSvc = services?.sessions ?? getService(ctx, 'sessions');
      const sess = typeof sid === 'string' && sessionsSvc?.get ? sessionsSvc.get(sid) : null;
      const st = sp?.stateOf?.(sess, 'modelSelection');
      const sel = st?.pending ?? st?.assembled;
      if (sel) return `${sel.provider}/${sel.model}/${sel.reasoningEffort ?? '-'}`;
    } catch { /* 读回失败不影响切换 */ }
    return lastSwitch.get(sid) ?? '(projection-unreadable)';
  }

  // v0.6.0 阶段二·修复点二：pre-step 的权威读取（旧路只有 pending/assembled 两个投影位）。
  // 三段降级：① 投影 pending/assembled → ② 会话 requestHeader().config（真实请求配置，
  // 外部漂移也会落这里）→ ③ 本插件切换台账 lastSwitch；三段全空才判 unreadable。
  // 投影对象在场但没有选择记录时返回 '(no-selection)'，与"读不出"区分开：
  // 前者可以正常判定，后者必须保守不覆盖。
  function readSelectionForRoute(sid) {
    try {
      if (!sid || sid === 'unknown') return '(projection-unreadable)';
      const sp = getService(ctx, 'sessionProjections');
      const sessionsSvc = getService(ctx, 'sessions');
      const sess = sessionsSvc?.get ? sessionsSvc.get(sid) : null;
      const st = sp?.stateOf?.(sess, 'modelSelection');
      const sel = st?.pending ?? st?.assembled;
      if (sel?.provider && sel?.model) return `${sel.provider}/${sel.model}/${sel.reasoningEffort ?? '-'}`;
      let hdr;
      try { hdr = typeof sess?.requestHeader === 'function' ? sess.requestHeader() : undefined; } catch { hdr = undefined; }
      const hc = hdr?.config;
      if (hc?.provider && hc?.model) return `${hc.provider}/${hc.model}/${hc.reasoningEffort ?? '-'}`;
      const mine = lastSwitch.get(sid);
      if (mine) return mine;
      if (st || sess) return '(no-selection)';
      return '(projection-unreadable)';
    } catch { return '(projection-unreadable)'; }
  }

  // 异步版：自测/后台路径用，先有界重查服务再读（宿主回收后旧引用失效）。
  async function readSelectionProjectionFresh(sid) {
    const sp = await resolveService('sessionProjections');
    const sessionsSvc = await resolveService('sessions');
    if (!sp) return lastSwitch.get(sid) ?? '(projection-unreadable)';
    return readSelectionProjection(sid, { sp, sessions: sessionsSvc });
  }

  // ── 功能一（v0.5.1）：用户手动选择绝对优先 —— durable 判定 ──
  // durable 信号（宿主 dsh-api-session-controller modelSelection 投影 + dsh-session 折叠）：
  //  ① 投影 pending —— 显式 selectModel 写入的 model/selection，尚未被请求消费；
  //  ② 会话 durable request header（session.requestHeader().config）—— 首条消息后即存在。
  // 来源判定（v0.5.1/内部模拟实测补）：durable 选择与本路由自己的切换台账 lastSwitch 一致
  //  ⇒ 路由自有态（chat/work 四象限来回切），允许继续路由；不一致（用户/其他来源改过）
  //  ⇒ 绝对优先返回 'user-manual-selection-kept'；
  // 状态读不出（服务缺席/会话查无）⇒ 返回 'selection-state-unreadable' 同样不覆盖（绝不赌手动选择）。
  // 落点说明：规格写"shouldSwitch 短路"；实现收敛到 realSwitch 入口 + pre-execute 注解
  // （单一咽喉，行为一致），shouldSwitch 保留精确同类判定语义。
  function manualKeepReason(sid, services = null, routeMode = '') {
    try {
      if (!sid || sid === 'unknown') return 'selection-state-unreadable';
      const sp = services?.sp ?? getService(ctx, 'sessionProjections');
      const sessionsSvc = services?.sessions ?? getService(ctx, 'sessions');
      const sess = sessionsSvc?.get ? sessionsSvc.get(sid) : null;
      if (!sess) return 'selection-state-unreadable';
      const st = sp?.stateOf?.(sess, 'modelSelection');
      let sel = st?.pending ?? null;
      if (!sel) {
        let hdr = null;
        try { hdr = typeof sess.requestHeader === 'function' ? sess.requestHeader() : undefined; } catch { hdr = undefined; }
        if (hdr?.config) sel = hdr.config;
      }
      if (!sel) {
        if (!st || typeof sp?.stateOf !== 'function') return 'selection-state-unreadable';
        return null;
      }
      // 来源判定：与路由自有切换台账比对（lastSwitch = 'provider/model/effort'，仅本插件真切成功时写入）
      const mine = lastSwitch.get(sid);
      if (mine) {
        const mineKey = mine.split('/').slice(0, 2).join('/');
        const selKey = `${sel.provider ?? ''}/${sel.model ?? ''}`;
        if (mineKey === selKey) return null; // 路由自己切的 → 四象限继续工作
      } else {
        // v0.5.2 冷启动空台账二次判定：台账为空（重启失忆）时用 route.mode × 当前档 provider
        // 做跨类放行（模型只来自配置）。routeMode 由 realSwitch/pre-execute 调用方透传；
        // 缺省（旧调用）→ 保守返回手动保持，不赌。
        try {
          if (routeMode) {
            const ct = resolveChatTarget({
              chatProvider: cfg.chatProvider,
              chatModel: cfg.chatModel,
              workProvider: cfg.workProvider,
              workModelFallback: cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL,
            });
            if (isColdStartCrossKind({
              selProvider: sel.provider ?? '',
              routeMode,
              workProvider: cfg.workProvider,
              chatTargetProvider: ct.provider,
            })) {
              const targetPair = routeMode === 'chat' ? `${ct.provider}/${ct.model}` : `${cfg.workProvider}/${currentWorkModel()}`;
              safeLog(ctx, 'info', `cold-start reroute allowed: ${sel.provider}/${sel.model} -> ${targetPair} (route.mode=${routeMode}; reason=cold-start-cross-kind).`);
              return null; // 放行一次：路由继续走真切，并重写 lastSwitch 台账
            }
          }
        } catch { /* 二次判定失败走保守路径 */ }
      }
      // ── v0.5.3 未知漂移纠偏（Config.reclaimUnknownModel，默认 true）──
      // 走到这里 = 台账外来（或冷启动跨类未命中）：当前模型既非聊天目标也非配置干活对
      // ⇒ 判为外部漂移，开关打开时放行真切（reason=reclaim-unknown-model）；
      // 关闭（false）→ 维持保守"不认识就不动"。routeMode 缺省（旧调用）不纠偏，绝不赌。
      try {
        if (routeMode && cfg.reclaimUnknownModel !== false) {
          const ct = resolveChatTarget({
            chatProvider: cfg.chatProvider,
            chatModel: cfg.chatModel,
            workProvider: cfg.workProvider,
            workModelFallback: cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL,
          });
          if (isUnknownDrift({
            selProvider: sel.provider ?? '',
            selModel: sel.model ?? '',
            chatTargetProvider: ct.provider,
            chatTargetModel: ct.model,
            knownWorkPairs: knownWorkPairs(),
          })) {
            const targetPair = routeMode === 'chat' ? `${ct.provider}/${ct.model}` : `${cfg.workProvider}/${currentWorkModel()}`;
            safeLog(ctx, 'info', `reclaim unknown model: ${sel.provider}/${sel.model} -> ${targetPair} (route.mode=${routeMode}; reason=reclaim-unknown-model).`);
            return null; // 纠偏放行：路由继续真切并重写 lastSwitch 台账
          }
        }
      } catch { /* 纠偏失败走保守路径 */ }
      return 'user-manual-selection-kept';
    } catch {
      return 'selection-state-unreadable';
    }
  }

  // ── v0.7.5 Step4 分支二：priorityMode 门控 ──
  // 'manual'（默认）⇒ manualKeepReason 结果原样生效（尊重用户手动选择）；
  // 'auto' ⇒ 路由规则优先，仅放行 'user-manual-selection-kept' 这一条保守理由，
  // 其余（selection-state-unreadable / projection-unreadable-fallback）读不出状态时
  // 永不放行——绝不赌手动选择。
  function applyPriorityMode(keep, sid, where) {
    try {
      if (keep !== 'user-manual-selection-kept') return keep;
      if (String(cfg?.priorityMode ?? 'manual') !== 'auto') return keep;
      safeLog(ctx, 'info', `${where} ${sid}: manual keep overridden (reason=priority-auto-override; priorityMode=auto, routing rules win).`);
      return null;
    } catch { return keep; } // 配置读取失败保持保守（照旧尊重手动）
  }

  // 仅当需要真切时返回目标，否则返回 null（表示：已在同类档位 / 用户选择优先，不干预）
  // v0.8.7 千问审计 P0-1：同类判定升级为 (provider, model, effort) 三元组——
  // 同模型不同 effort（chat=light vs work=deep）也必须真切，否则档位永远切不动。
  function shouldSwitch(actualSel, target) {
    try {
      if (!target?.provider || !target?.model) return target; // 目标无效交给调用方处理
      if (isSameKind(actualSel, target.provider, target.model, target.effort)) return null; // 三元组全等才不覆盖
      return target;
    } catch { return target; }
  }

  // 有界重查（官方补丁口径：3 次 × 250ms）：移动端宿主会回收服务，
  // 启动时取一次的引用不可信——每次用前重取，失败则等 250ms 再取，最多 3 次。
  async function resolveService(name, { retries = 3, intervalMs = 250 } = {}) {
    for (let i = 0; i < retries; i++) {
      let svc = null;
      try { svc = getService(ctx, name); } catch { svc = null; }
      if (svc) return svc;
      if (i < retries - 1) await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
  }

  async function realSwitch(sessionId, target, routeMode = '') {
    const sid = String(sessionId || '');
    const tag = `realSwitch ${sid || '(empty)'} -> ${target?.provider ?? '?'}/${target?.model ?? '?'}/${target?.effort ?? '-'}`;
    // STEP1 全部 early-return 带声音：no-session / no-controller / same-kind-kept / cooldown
    if (!sid || sid === 'unknown') {
      safeLog(ctx, 'warn', `${tag} | early-return reason=no-session`);
      return { ok: false, reason: 'no-session', target };
    }
    // v0.7.5 Step4 分支一：enabled=false 总开关关闭 ⇒ 插件只记日志不切换模型
    // （pre-step 已有显式分支落 keepReason=enabled-off；此处是真切单咽喉的兜底门）。
    if (cfg?.enabled === false) {
      safeLog(ctx, 'info', `${tag} | early-return reason=enabled-off (plugin disabled; log-only mode, no model switch).`);
      return { ok: false, reason: 'enabled-off', target };
    }
    // 功能一短路（规格落点）：durable 手动选择/请求头在位 → 绝不覆盖（user-manual-selection-kept）。
    // v0.5.2：透传 route.mode，冷启动空台账时跨类可放行一次（reason 不再是 kept 而是真切）。
    // 放在 controller 解析之前：保留与否是读判定，不依赖真切服务是否就绪。
    try {
      const keep = applyPriorityMode(manualKeepReason(sid, null, target?.__routeMode ?? routeMode), sid, 'realSwitch');
      if (keep) {
        safeLog(ctx, 'info', `${tag} | early-return reason=${keep} (manual selection absolute; durable selection/header present).`);
        return { ok: false, reason: keep, target };
      }
    } catch { /* manualKeepReason 自带兜底，绝不阻断 */ }
    // 每次用前重取 + 有界重查（不用 apply 时缓存的引用，宿主回收后旧引用失效）
    const controller = await resolveService('sessionController');
    if (!controller || typeof controller.selectModel !== 'function') {
      safeLog(ctx, 'warn', `${tag} | early-return reason=no-controller (3x250ms retry exhausted, controller=${controller ? typeof controller.selectModel : 'null'})`);
      return { ok: false, reason: 'no-controller', target };
    }
    // 尊重手动选择：当前已是目标同类档位（our-free-model 任意模型 / 同 provider）=> 不覆盖
    try {
      const proj = readSelectionProjection(sid);
      if (shouldSwitch(proj, target) === null) {
        safeLog(ctx, 'info', `${tag} | early-return reason=same-kind-kept kept=${proj} (manual choice respected).`);
        return { ok: false, reason: 'same-kind-kept', kept: proj, target };
      }
    } catch { /* 读回失败不影响后续 */ }
    // 节流：同一会话冷却内不重复切（默认 5s，可配 switchCooldownMs；旧 60s 会吞连续纠偏）
    // v0.7.8 方向区分：升档（chat→work，含 routeMode==='work'）跳过冷却立即放行；
    // 降档（work→chat）与同档切换仍受冷却约束。routeMode 由调用方透传（pre-step/pre-execute/runRoute）。
    const __routeMode = String(target?.__routeMode ?? routeMode ?? '');
    const __isUpgrade = __routeMode === 'work';
    const cooldownMs = Number.isFinite(Number(cfg?.switchCooldownMs)) ? Number(cfg.switchCooldownMs) : 5000;
    const cd = cooldownGate(sid, { cooldownMs, isUpgrade: __isUpgrade, ctx, tag, safeLog });
    if (cd.blocked) {
      return { ok: false, reason: 'downgrade-cooldown-blocked', target };
    }
    // 切前记住全局默认：用前重取（宿主回收后旧引用失效），拦截生效时仅用于断言
    let beforeDefault = null;
    try {
      const adm = await resolveService('agentDefaultModel');
      beforeDefault = typeof adm?.currentSelection === 'function' ? adm.currentSelection() : null;
    } catch { beforeDefault = null; }
    const payload = buildSelectModelPayload({
      sessionId: sid,
      provider: target.provider,
      model: target.model,
      effort: target.effort,
    });
    try {
      const res = await withSaveWindow(() => controller.selectModel(payload));
      // v0.8.7 步骤9：两处写入走有界口径 —— switchState 经 cooldown.mark（FIFO 500），
      // lastSwitch 直接 set 时同样做 FIFO 淘汰（其实例是 BoundedMap 时 set 自带淘汰；
      // 外部注入裸 Map（如单测/旧装配）时此处兜底删最旧，保证任何 Map 实例都不无界）。
      try {
        if (typeof cooldown?.mark === 'function') cooldown.mark(sid, Date.now());
        else switchState.set(sid, Date.now());
        lastSwitch.set(sid, `${payload.provider}/${payload.model}/${payload.reasoningEffort ?? '-'}`);
        if (lastSwitch.size > 500) {
          const oldest = lastSwitch.keys().next();
          if (!oldest.done) lastSwitch.delete(oldest.value);
        }
      } catch { /* noop */ }
      // 兜底写回：仅当 saveSelection 拦截未生效时才需要（拦截生效时 save 已是 report-only）。
      // 用 __autoModelRouterGuard 标记区分，避免拦截后又调被替换的空函数。
      try {
        if (!flags.saveIntercepted) {
          const adm = await resolveService('agentDefaultModel');
          if (beforeDefault && adm?.__autoModelRouterGuard) {
            // 其他实例已拦截，无需写回
          } else if (beforeDefault && adm && typeof adm.saveSelection === 'function') {
            const orig = adm.__autoModelRouterOrigSave ?? adm.saveSelection.bind(adm);
            await orig(beforeDefault).catch(() => {});
          }
        }
      } catch { /* 回写失败不影响会话选择 */ }
      // UI 同步确认：selectModel 成功 -> 投影变更 -> 控制流自动 broadcast 到前端选择器。
      // 这里读回投影做一致性确认：不一致只打 warn（通常是前端尚未刷新，非错误）。
      try {
        const back = readSelectionProjection(sid);
        const expect = `${payload.provider}/${payload.model}`;
        if (!String(back).startsWith(expect)) {
          safeLog(ctx, 'warn', `UI sync check: projection=${back} != selected ${expect} (frontend may refresh late; session works with ${expect}).`);
        }
      } catch { /* 确认失败不影响结果 */ }
      safeLog(ctx, 'info', `switched session ${sid} -> ${payload.provider}/${payload.model}/${payload.reasoningEffort ?? '(no-effort)'} ok | projection=${readSelectionProjection(sid)}`);
      return { ok: true, payload, res };
    } catch (err) {
      const code = err?.code || err?.message || String(err);
      // 无 effort 菜单的模型（如 glm-5.3-flash）：去掉 effort 重试一次
      if (payload.reasoningEffort && /model-unavailable|effort/i.test(String(code))) {
        try {
          const retry = { sessionId: sid, provider: payload.provider, model: payload.model };
          const res2 = await withSaveWindow(() => controller.selectModel(retry));
          // v0.8.7 步骤9：同上有界口径（主路径注释见上）。
          try {
            if (typeof cooldown?.mark === 'function') cooldown.mark(sid, Date.now());
            else switchState.set(sid, Date.now());
            lastSwitch.set(sid, `${retry.provider}/${retry.model}/-`);
            if (lastSwitch.size > 500) {
              const oldest = lastSwitch.keys().next();
              if (!oldest.done) lastSwitch.delete(oldest.value);
            }
          } catch { /* noop */ }
          try {
            if (!flags.saveIntercepted) {
              const adm = await resolveService('agentDefaultModel');
              if (beforeDefault && adm && typeof adm.saveSelection === 'function' && !adm.__autoModelRouterGuard) {
                const orig = adm.__autoModelRouterOrigSave ?? adm.saveSelection.bind(adm);
                await orig(beforeDefault).catch(() => {});
              }
            }
          } catch { /* noop */ }
          safeLog(ctx, 'info', `switched session ${sid} -> ${retry.provider}/${retry.model}/(no-effort retry) ok | projection=${readSelectionProjection(sid)}`);
          return { ok: true, payload: retry, res: res2, retried: true };
        } catch (err2) {
          safeLog(ctx, 'warn', `selectModel failed for ${sid} (${String(err2?.message ?? err2)}); degraded to annotate-only.`);
          return { ok: false, reason: String(err2?.message ?? err2) };
        }
      }
      safeLog(ctx, 'warn', `selectModel failed for ${sid} (${String(err?.message ?? err)}); degraded to annotate-only.`);
      return { ok: false, reason: String(err?.message ?? err) };
    }
  }

  return {
    readSelectionProjection,
    readSelectionForRoute,
    readSelectionProjectionFresh,
    manualKeepReason,
    applyPriorityMode,
    shouldSwitch,
    resolveService,
    realSwitch,
  };
}
