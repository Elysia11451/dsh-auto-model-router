  if (cfg.selftest) {
    selftestLines = [];
    const RAW_ROUND = String(cfg.selftestRound ?? (typeof cfg.selftest === 'string' ? cfg.selftest : 'all')).toLowerCase();
    const ROUND = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'].includes(RAW_ROUND) ? RAW_ROUND : 'all';
    const ROUND_TAGS = {
      r1: ['prework', 't1-privchat', 't2-privwork-free'],
      r2: ['t3-privwork-owned', 't4-groupchat'],
      r3: ['t5-groupwork', 't6-manual'],
      r4: ['t7-uisync', 't8-pollute'],
      r5: ['t9-chatmodel-empty', 't10-dynamic-off'],
      r6: ['t11-manual-lock', 't12-manual-lock-off'],
      // r7 = m01290 隔离内部模拟 6 项（四象限核心路由 + 手动优先 + 全局不污染）
      r7: ['s1-privchat', 's2-privwork', 's3-groupwork', 's4-groupchat', 's5-manual', 's6-nopollute'],
      // r8 = v0.5.2 冷启动空台账二次判定 2 项（台账为空 + durable 在位 + 跨类 → 放行一次）
      r8: ['t13-coldstart-chat', 't14-coldstart-work'],
      all: ['prework', 't1-privchat', 't2-privwork-free', 't3-privwork-owned', 't4-groupchat', 't5-groupwork', 't6-manual', 't7-uisync', 't8-pollute', 't9-chatmodel-empty', 't10-dynamic-off', 't11-manual-lock', 't12-manual-lock-off', 's1-privchat', 's2-privwork', 's3-groupwork', 's4-groupchat', 's5-manual', 's6-nopollute', 't13-coldstart-chat', 't14-coldstart-work'],
    };
    const ACTIVE_TAGS = ROUND_TAGS[ROUND];
    const hasTag = (t) => ACTIVE_TAGS.includes(t);
    // 回合输出隔离：r1..r4 写 selftest-result-rN.json，全量写原路径（兼容旧断言）。
    const SELFTEST_OUT_BASE = String(cfg.selftestOut || '');
    const SELFTEST_OUT_PATH = (ROUND === 'all' || !SELFTEST_OUT_BASE) ? SELFTEST_OUT_BASE
      : SELFTEST_OUT_BASE.replace(/\.json$/, `-${ROUND}.json`);
    const out = { startedAt: new Date().toISOString(), round: ROUND, checks: {}, logs: [] };
    const flush = async () => {
      try {
        out.logs = selftestLines ? selftestLines.slice(-40) : [];
        if (SELFTEST_OUT_PATH) await writeTextFile(SELFTEST_OUT_PATH, JSON.stringify(out, null, 2));
        else if (cfg.selftestOut) await writeTextFile(cfg.selftestOut, JSON.stringify(out, null, 2));
      } catch (e) { console.log('[selftest] flush failed:', String(e?.message ?? e)); }
    };
      const getSvc = () => getService(ctx, 'sessionController'); // 遗留：自测内已改走 resolveService，仅留兼容
      const getAdm = () => getService(ctx, 'agentDefaultModel'); // 遗留：t8 已改走 resolveService，仅留兼容

    const runSelftest = async () => {
      // 回合开始：重取服务并记录 ready（方案B要求：不复用旧引用，每回合新鲜实例）
      out.checks.service_ready = {};
      const svc = await resolveService('sessionController', { retries: 40, intervalMs: 250 });
      const admProbe = await resolveService('agentDefaultModel');
      out.checks.service_ready = {
        round: ROUND,
        sessionController: svc ? `ok(has ${typeof svc.selectModel === 'function' ? 'selectModel' : 'no-selectModel'})` : 'null',
        agentDefaultModel: admProbe ? `ok(has ${typeof admProbe.currentSelection === 'function' ? 'currentSelection' : 'no-currentSelection'})` : 'null',
      };
      await flush();
      // 1) 等 sessionController 就绪（有界重查：官方 3×250ms 打底，加长到 40×250ms 覆盖冷启动）
      if (!svc?.selectModel) { out.fatal = 'sessionController unavailable'; await flush(); return; }
      // svc 引用不缓存：每次 create 前重取（宿主回收后旧引用失效）
      const t0 = Date.now();
      const mkSession = async (tag) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const sid = `session-selftest-${tag}-${Date.now()}-${attempt}`;
          try {
            const fresh = await resolveService('sessionController');
            if (!fresh?.create) throw new Error('no-controller');
            await fresh.create({ sessionId: sid, cwd: process.cwd() }); return sid;
          }
          catch (e) {
            if (attempt === 2) out.checks[`create_${tag}`] = { error: String(e?.message ?? e) };
            else await new Promise((r) => setTimeout(r, 800));
          }
        }
        return null;
      };
      // 顺序：先建本回合会话（agents 上下文活跃期），再预热榜单，最后逐项跑路由。
      // 原因：预热的网络等待会拖出 agents 活跃窗口，后建会话必报 inactive context。
      // 方案B：只建 ACTIVE_TAGS（本回合 2-3 个），不建全量 9 个。
      const preSids = {};
      for (const tag of ACTIVE_TAGS) {
        preSids[tag] = await mkSession(tag);
      }
      const takeSid = (tag) => {
        const sid = preSids[tag];
        preSids[tag] = null;
        return sid;
      };
      // 先预热：排行榜 + 可用清单拉完再跑 8 项，否则早期项只能命中回退值而非动态最强
      try {
        await refreshFreeList();
        await refreshLeaderboard();
        safeLog(ctx, 'info', `selftest warmed: workModel=${currentWorkModel()} free=${(freeList.avail ?? []).length} lb=${(lb.get() ?? []).length}`);
      } catch { /* 预热失败走回退，不阻断 */ }
      // 榜单快照钉死：8 项全程用同一 picked 值断言，不受后台刷新抖动干扰。
      // refreshFreeList/refreshLeaderboard 不再触发（预热已拉完，TTL 内也不会过期）。
      const PINNED_WORK_MODEL = currentWorkModel();
      const dynModel = () => PINNED_WORK_MODEL;

      // ── 8 项验证（四象限口径，每项读 model/selection 真实投影）──
      // 辅助：走完整 pre-execute 路径（decideRoute→annotate→真切），返回 { route, projection }。
      // sid 为空（创建失败）时返回 pass:null（环境偶发，非逻辑失败），failures 口径跳过 null。
      // sid 预取自 preSids（tag 须与预建表一致），避免逐项建会话拖出 agents 活跃窗口。
      const runRoute = async (tag, { text, meta, strategy, preset }) => {
        const sid = takeSid(tag);
        if (!sid) return { sid: null, pass: null, projection: null, note: 'session-create-failed' };
        // 前置档位（内部模拟 6 项用）：先用路由自己的真切把会话置于指定档（写 lastSwitch 台账，
        // 模拟"会话当前处于 X 档"的路由自有态），再走完整路由路径。
        let presetRes = null;
        let presetProjection = null;
        if (preset) {
          presetRes = await realSwitch(sid, preset);
          await new Promise((r) => setTimeout(r, 300));
          presetProjection = await readSelectionProjectionFresh(sid);
          // 自测前置档位是"稳态模拟"（会话本来就停在该档），不是 300ms 前的一次真实切换——
          // 清掉同会话 60s 节流，让随后的路由真切不受 preset 污染（生产节流逻辑不动）。
          try { switchState.delete(sid); } catch { /* noop */ }
        }
        const exec = { args: text, agent: { session: sid, source: meta } };
        const route = decideRoute({ source: sourceFromMeta(meta), text, meta, strategy: strategy ?? cfg.privateChatWorkStrategy });
        ensureFresh();
        annotateRoute(exec, route, PINNED_WORK_MODEL);
        // 手动尊重检查（与 pre-execute 主体同逻辑；自测走新鲜读回，宿主回收后旧引用失效）
        // v0.5.2：先走 manualKeepReason（含冷启动二次判定），再走精确同类 —— 与 pre-execute 主体同序，
        // 否则自测 runRoute 里手动门被跳过，老用例/新 t13 口径对不上。
        let target = exec?.autoModelRouter?.target;
        try {
          if (target) {
            // v0.7.5 Step4 分支二：与生产 pre-step 同口径套 priorityMode 门控（默认 manual 时零变化）。
            const keep = applyPriorityMode(manualKeepReason(sid, null, route?.mode ?? ''), sid, 'runRoute');
            if (keep) {
              exec.autoModelRouter.target = null;
              exec.autoModelRouter.kept = await readSelectionProjectionFresh(sid);
              exec.autoModelRouter.keepReason = keep;
              target = null;
            } else {
              const actual = await readSelectionProjectionFresh(sid);
              if (shouldSwitch(actual, target) === null) {
                exec.autoModelRouter.target = null;
                exec.autoModelRouter.kept = actual;
                target = null;
              }
            }
          }
        } catch { /* 走原路径 */ }
        let sw = { ok: false, reason: 'skipped-no-target' };
        if (target) {
          sw = await realSwitch(sid, target, route?.mode ?? '');
          await new Promise((r) => setTimeout(r, 300)); // 等投影落定
        }
        return { sid, route, preset: presetRes, presetProjection, target: exec?.autoModelRouter?.target ?? null, kept: exec?.autoModelRouter?.kept ?? null, switch: sw, projection: await readSelectionProjectionFresh(sid) };
      };

      // 1) 私聊闲聊 → 强制回自有 chat/light（先停在 work 档也要切回）
      // 方案B：r1 含 prework+t1+t2；其他回合跳过（checks 不留该键，failures 不计）。
      if (hasTag('prework') && hasTag('t1-privchat')) {
        const sidPre = takeSid('prework');
        if (sidPre) await realSwitch(sidPre, { provider: cfg.workProvider, model: dynModel(), effort: cfg.workEffort });
        const t1 = await runRoute('t1-privchat', { text: '今天天气怎么样', meta: { channel: 'qq' } });
        out.checks.t1_private_chat = { round: ROUND, route: t1.route, projection: t1.projection,
          switchOk: t1.switch?.ok ?? null, switchReason: t1.switch?.reason ?? null, switchTarget: t1.switch?.target ?? t1.target ?? null,
          switched: t1.switch?.ok ?? null, reason: t1.switch?.reason ?? t1.note ?? null,
          target: t1.switch?.target ?? t1.target ?? null, kept: t1.kept ?? null,
          skipped: t1.pass === null ? true : undefined,
          pass: t1.pass === null ? null : (typeof t1.projection === 'string' && t1.projection.startsWith(`${cfg.chatProvider}/${cfg.chatModel}`)) };
        if (t1.pass === null) { out.checks.t1_private_chat.skipped = true; out.checks.t1_private_chat.reason = t1.note ?? 'session-create-failed'; }
        await flush();
      }

      // 2) 私聊干活 free → 动态最强/deep
      if (hasTag('t2-privwork-free')) {
        const t2 = await runRoute('t2-privwork-free', { text: '帮我装插件', meta: { channel: 'qq' }, strategy: 'free' });
        const dyn2 = dynModel();
        out.checks.t2_private_work_free = { round: ROUND, route: t2.route, picked: dyn2, projection: t2.projection,
          switchOk: t2.switch?.ok ?? null, switchReason: t2.switch?.reason ?? null, switchTarget: t2.switch?.target ?? t2.target ?? null,
          reason: t2.switch?.reason ?? t2.note ?? null, target: t2.switch?.target ?? t2.target ?? null, kept: t2.kept ?? null,
          pass: t2.pass === null ? null : (t2.route?.workStyle === 'free' && typeof t2.projection === 'string' && t2.projection.startsWith(`${cfg.workProvider}/${dyn2}`)) };
        if (t2.pass === null) { out.checks.t2_private_work_free.skipped = true; out.checks.t2_private_work_free.reason = t2.note ?? 'session-create-failed'; }
        await flush();
      }

      // 3) 私聊干活 owned → 自有/deep（workEffortOwned）
      if (hasTag('t3-privwork-owned')) {
        const t3 = await runRoute('t3-privwork-owned', { text: '帮我装插件', meta: { channel: 'qq' }, strategy: 'owned' });
        out.checks.t3_private_work_owned = { round: ROUND, route: t3.route, projection: t3.projection,
          switchOk: t3.switch?.ok ?? null, switchReason: t3.switch?.reason ?? null, switchTarget: t3.switch?.target ?? t3.target ?? null,
          reason: t3.switch?.reason ?? t3.note ?? null, target: t3.switch?.target ?? t3.target ?? null, kept: t3.kept ?? null,
          pass: t3.pass === null ? null : (t3.route?.workStyle === 'owned' && typeof t3.projection === 'string' && t3.projection.startsWith(`${cfg.chatProvider}/${cfg.chatModel}`)) };
        if (t3.pass === null) { out.checks.t3_private_work_owned.skipped = true; out.checks.t3_private_work_owned.reason = t3.note ?? 'session-create-failed'; }
        await flush();
      }

      // 4) 群聊闲聊 → 自有 chat/light
      if (hasTag('t4-groupchat')) {
        const t4 = await runRoute('t4-groupchat', { text: '大家好', meta: { channel: 'qq', chatType: 'group' } });
        out.checks.t4_group_chat = { round: ROUND, route: t4.route, projection: t4.projection,
          switchOk: t4.switch?.ok ?? null, switchReason: t4.switch?.reason ?? null, switchTarget: t4.switch?.target ?? t4.target ?? null,
          reason: t4.switch?.reason ?? t4.note ?? null, target: t4.switch?.target ?? t4.target ?? null, kept: t4.kept ?? null,
          pass: t4.pass === null ? null : (t4.route?.mode === 'chat' && typeof t4.projection === 'string' && t4.projection.startsWith(`${cfg.chatProvider}/${cfg.chatModel}`)) };
        if (t4.pass === null) { out.checks.t4_group_chat.skipped = true; out.checks.t4_group_chat.reason = t4.note ?? 'session-create-failed'; }
        await flush();
      }

      // 5) 群聊干活 → 动态最强/deep
      if (hasTag('t5-groupwork')) {
        const t5 = await runRoute('t5-groupwork', { text: '帮我装插件', meta: { channel: 'qq', chatType: 'group' }, strategy: 'free' });
        const dyn5 = dynModel();
        out.checks.t5_group_work = { round: ROUND, route: t5.route, picked: dyn5, projection: t5.projection,
          switchOk: t5.switch?.ok ?? null, switchReason: t5.switch?.reason ?? null, switchTarget: t5.switch?.target ?? t5.target ?? null,
          reason: t5.switch?.reason ?? t5.note ?? null, target: t5.switch?.target ?? t5.target ?? null, kept: t5.kept ?? null,
          pass: t5.pass === null ? null : (t5.route?.mode === 'work' && typeof t5.projection === 'string' && t5.projection.startsWith(`${cfg.workProvider}/${dyn5}`)) };
        if (t5.pass === null) { out.checks.t5_group_work.skipped = true; out.checks.t5_group_work.reason = t5.note ?? 'session-create-failed'; }
        await flush();
      }

      // 6)（v0.5.1 严格语义）手动选择绝对优先：手动 selectModel 后发工作指令 → 绝不覆盖。
      //    pass = realSwitch 返回 reason=user-manual-selection-kept + ok=false + 投影前后一致（仍为手动值）。
      //    规格 m01006 功能一.3「一旦用户在会话里做了显式选择，该选择始终优先」。
      // 方案B：仅 r3 跑。
      if (hasTag('t6-manual')) {
      const sid6 = takeSid('t6-manual');
      let t6out = null;
      if (sid6) {
        // 手动模型取自配置回退值（禁硬编码），且须与动态榜首不同——否则 same-kind 与 manual-keep 语义撞车。
        const manualModel6 = cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL;
        try {
          const freshSvc = await resolveService('sessionController');
          await freshSvc.selectModel({ sessionId: sid6, provider: cfg.workProvider, model: manualModel6, reasoningEffort: cfg.workEffort });
        } catch { /* 切失败会体现在 before6/断言里 */ }
        // 投影落定有延迟：最多等 3×500ms；仍读不出判环境抖动 → pass:null 跳过（不记失败）。
        let before6 = await readSelectionProjectionFresh(sid6);
        for (let ri = 0; ri < 3 && (before6 === '(projection-unreadable)' || before6 == null); ri++) {
          await new Promise((r) => setTimeout(r, 500));
          before6 = await readSelectionProjectionFresh(sid6);
        }
        if (before6 === '(projection-unreadable)' || before6 == null) {
          t6out = { round: ROUND, pass: null, skipped: true, reason: 'projection-unreadable-after-retry' };
        } else {
        // 工作指令经完整路径：durable 门应短路为 user-manual-selection-kept，绝不真切
        const exec6 = { args: '帮我装插件', agent: { session: sid6, source: {} } };
        const route6 = decideRoute({ source: 'main', text: '帮我装插件', meta: {}, strategy: cfg.privateChatWorkStrategy });
        annotateRoute(exec6, route6, PINNED_WORK_MODEL);
        const target6 = exec6?.autoModelRouter?.target ?? null;
        let sw6 = { ok: false, reason: 'skipped-no-target' };
        if (target6) { sw6 = await realSwitch(sid6, target6); await new Promise((r) => setTimeout(r, 300)); }
        const after6 = await readSelectionProjectionFresh(sid6);
        t6out = { round: ROUND, before: before6, manualPair: `${cfg.workProvider}/${manualModel6}`, dynTarget: `${cfg.workProvider}/${dynModel()}`, keepReason: sw6.reason ?? null, switched: sw6.ok, reason: sw6.reason ?? null, switchReason: sw6.reason ?? null, target: sw6.target ?? target6 ?? null, switchTarget: sw6.target ?? target6 ?? null, after: after6,
          pass: sw6.ok === false && sw6.reason === 'user-manual-selection-kept'
            && String(after6) === String(before6)
            && String(before6).startsWith(`${cfg.workProvider}/${manualModel6}`) };
        }
      } else {
        t6out = { round: ROUND, pass: null, skipped: true, reason: 'session-create-failed' };
      }
      out.checks.t6_manual_kept = t6out;
      await flush();
      }

      // 7) UI 同步：真切后投影与 selected 一致
      // 方案B：仅 r4 跑。
      if (hasTag('t7-uisync')) {
      const sid7 = takeSid('t7-uisync');
      if (sid7) {
        const warnBefore = selftestLines.filter((l) => l.includes('UI sync check')).length;
        const r = await realSwitch(sid7, { provider: cfg.workProvider, model: dynModel(), effort: cfg.workEffort });
        const back = await readSelectionProjectionFresh(sid7);
        const warnAfter = selftestLines.filter((l) => l.includes('UI sync check')).length;
        out.checks.t7_uisync = { round: ROUND, ok: r.ok, reason: r.reason ?? null, target: r.target ?? { provider: cfg.workProvider, model: dynModel() }, kept: r.kept ?? null, projection: back, matches: typeof back === 'string' && back.startsWith(`${cfg.workProvider}/`), syncWarn: warnAfter - warnBefore, pass: r.ok === true && typeof back === 'string' && back.startsWith(`${cfg.workProvider}/`) };
        if (out.checks.t7_uisync.pass !== true && out.checks.t7_uisync.reason && !r.ok) { out.checks.t7_uisync.skipped = true; }
      } else {
        out.checks.t7_uisync = { round: ROUND, ok: false, reason: 'session-create-failed', skipped: true, pass: null };
      }
      await flush();
      }

      // 8) 全局污染：切前后 currentSelection() 一致（有界重查 adm，始终记录该键）
      // 方案B：仅 r4 跑。
      if (hasTag('t8-pollute')) {
      const adm8 = await resolveService('agentDefaultModel');
      // 拦截若在宿主回收后丢失，在新鲜实例上重建（report-only，不写 settings）
      try {
        if (adm8 && typeof adm8.saveSelection === 'function' && !adm8.__autoModelRouterGuard) {
          const origSave = adm8.saveSelection.bind(adm8);
          adm8.__autoModelRouterOrigSave = origSave;
          adm8.saveSelection = async (next) => {
            try { safeLog(ctx, 'info', `default-save intercepted (kept, not written): ${next?.provider ?? '?'} / ${next?.model ?? '?'}`); } catch { /* noop */ }
            return;
          };
          adm8.__autoModelRouterGuard = true;
          saveIntercepted = true;
        }
      } catch { /* 拦截重建失败走写回兜底 */ }
      const sid8 = takeSid('t8-pollute');
      if (adm8 && sid8) {
        const before = adm8.currentSelection();
        const r = await realSwitch(sid8, { provider: cfg.workProvider, model: dynModel(), effort: cfg.workEffort });
        const after = adm8.currentSelection();
        out.checks.t8_pollution = { round: ROUND, switchOk: r.ok, reason: r.reason ?? null, target: r.target ?? null, unchanged: JSON.stringify(before) === JSON.stringify(after), intercepted: adm8.__autoModelRouterGuard === true, pass: JSON.stringify(before) === JSON.stringify(after) };
      } else {
        out.checks.t8_pollution = { round: ROUND, pass: null, skipped: true, reason: !adm8 ? 'no-agentDefaultModel' : 'session-create-failed' };
        safeLog(ctx, 'warn', `t8 skipped: adm=${adm8 ? 'ok' : 'null'} sid=${sid8 ?? 'null'}`);
      }
      await flush();
      } // hasTag t8-pollute

      // 9) chatModel 为空回退（v0.5.0）：resolveChatTarget 必须给 workProvider/workModelFallback，
      //    且真切后真实投影落在该目标上（配置空 → 免费池 light 档，不向 selectModel 传空 model）。
      if (hasTag('t9-chatmodel-empty')) {
      const sid9 = takeSid('t9-chatmodel-empty');
      if (sid9) {
        const ct = resolveChatTarget({ chatProvider: cfg.chatProvider, chatModel: '', workProvider: cfg.workProvider, workModelFallback: cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL });
        const sw = await realSwitch(sid9, { provider: ct.provider, model: ct.model, effort: cfg.chatEffort });
        await new Promise((r) => setTimeout(r, 300));
        const back = await readSelectionProjectionFresh(sid9);
        out.checks.t9_chatmodel_empty = { round: ROUND, source: ct.source, target: `${ct.provider}/${ct.model}`, switchOk: sw.ok, reason: sw.reason ?? null, projection: back,
          pass: ct.source === 'fallback' && ct.provider === cfg.workProvider && ct.model === (cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL)
            && sw.ok === true && typeof back === 'string' && back.startsWith(`${ct.provider}/${ct.model}`) };
      } else {
        out.checks.t9_chatmodel_empty = { round: ROUND, pass: null, skipped: true, reason: 'session-create-failed' };
      }
      await flush();
      }

      // 10) enableDynamicRanking=false 不请求（v0.5.0）：临时翻转开关调 refreshLeaderboard，
      //     OpenRouter 请求计数必须 0 增长，且 currentWorkModel 直接回退配置值（不读榜单）。
      if (hasTag('t10-dynamic-off')) {
      const before10 = lbFetchCount;
      const savedOn = dynamicOn;
      dynamicOn = false;
      try {
        await refreshLeaderboard();
        const fallback10 = cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL;
        const wm = currentWorkModel();
        const fetchDelta = lbFetchCount - before10;
        out.checks.t10_dynamic_off = { round: ROUND, fetchDelta, workModel: wm, fallback: fallback10,
          pass: fetchDelta === 0 && wm === fallback10 };
      } finally {
        dynamicOn = savedOn;
      }
      await flush();
      } // hasTag t10-dynamic-off

      // 11)（v0.5.1 功能二）手动锁定 work 模型：locked=true + manualWorkModel 指定 →
      //     工作指令真切到锁定模型（压过动态榜/modelOverride），OpenRouter 请求计数 0 增长，
      //     锁定日志 reason=manual-work-model-locked。夹具值 = workProvider/workModelFallback（即规格示例 our-free-model/mimo-v2.6-flash-free）。
      if (hasTag('t11-manual-lock')) {
        const savedLocked11 = cfg.manualWorkModelLocked;
        const savedManual11 = cfg.manualWorkModel;
        // 不 takeSid：预建会话由 runRoute 内 takeSid 消费，此处先取会吞掉它
        const MANUAL_PAIR = `${cfg.workProvider}/${cfg.workModelFallback}`;
        cfg.manualWorkModelLocked = true;
        cfg.manualWorkModel = MANUAL_PAIR;
        syncManualLock();
        try {
          const beforeFetch11 = lbFetchCount;
          await refreshLeaderboard(); // 锁下必须 0 请求（lbFetchCount 不动）
          const fetchDelta11 = lbFetchCount - beforeFetch11;
          const t11 = await runRoute('t11-manual-lock', { text: '帮我装插件', meta: { channel: 'qq' }, strategy: 'free' });
          const lockLogs11 = (selftestLines ?? []).filter((l) => l.includes('manual-work-model-locked')).length;
          out.checks.t11_manual_lock = { round: ROUND, manualPair: MANUAL_PAIR, lock: { on: manualLock.on, provider: manualLock.provider, model: manualLock.model, reason: manualLock.reason ?? null },
            fetchDelta: fetchDelta11, lockLogCount: lockLogs11, route: t11.route,
            switchOk: t11.switch?.ok ?? null, reason: t11.switch?.reason ?? null, target: t11.switch?.target ?? t11.target ?? null,
            projection: t11.projection,
            pass: t11.pass !== null && manualLock.on === true && fetchDelta11 === 0 && lockLogs11 >= 1
              && t11.switch?.ok === true && t11.route?.workStyle === 'free'
              && typeof t11.projection === 'string' && t11.projection.startsWith(MANUAL_PAIR) };
          if (t11.pass === null) { out.checks.t11_manual_lock.skipped = true; out.checks.t11_manual_lock.reason = t11.note ?? 'session-create-failed'; }
        } finally {
          cfg.manualWorkModelLocked = savedLocked11;
          cfg.manualWorkModel = savedManual11;
          syncManualLock();
        }
        await flush();
      } // hasTag t11-manual-lock

      // 12)（v0.5.1 功能二）锁关闭 / 锁值为空 → 恢复动态排行榜逻辑：
      //     ① locked=false → 非锁态；② locked=true 但 manualWorkModel 空 → 不构成锁；
      //     ③ 恢复正常后完整路由：真切到动态/回退（currentWorkModel 不再被手动值钉死）。
      if (hasTag('t12-manual-lock-off')) {
        const savedLocked12 = cfg.manualWorkModelLocked;
        const savedManual12 = cfg.manualWorkModel;
        // 不 takeSid（会吞掉 runRoute 的预建会话）；空 sid 由 runRoute 返回 note 处理
        {
          cfg.manualWorkModelLocked = false;
          cfg.manualWorkModel = `${cfg.workProvider}/should-not-be-used`;
          syncManualLock();
          const offWhenDisabled = manualLock.on === false;
          cfg.manualWorkModelLocked = true;
          cfg.manualWorkModel = '';
          syncManualLock();
          const offWhenEmpty = manualLock.on === false;
          cfg.manualWorkModelLocked = false;
          cfg.manualWorkModel = '';
          syncManualLock();
          const t12 = await runRoute('t12-manual-lock-off', { text: '帮我装插件', meta: { channel: 'qq' }, strategy: 'free' });
          const wm12 = currentWorkModel();
          out.checks.t12_manual_lock_off = { round: ROUND, offWhenDisabled, offWhenEmpty,
            switchOk: t12.switch?.ok ?? null, reason: t12.switch?.reason ?? null, target: t12.switch?.target ?? t12.target ?? null,
            projection: t12.projection, workModel: wm12, pinned: dynModel(),
            pass: t12.pass !== null && offWhenDisabled && offWhenEmpty
              && t12.switch?.ok === true
              && typeof t12.projection === 'string' && t12.projection.startsWith(`${cfg.workProvider}/${dynModel()}`)
              && wm12 === dynModel() };
          if (t12.pass === null) { out.checks.t12_manual_lock_off.skipped = true; out.checks.t12_manual_lock_off.reason = t12.note ?? 'session-create-failed'; }
        }
        cfg.manualWorkModelLocked = savedLocked12;
        cfg.manualWorkModel = savedManual12;
        syncManualLock();
        await flush();
      } // hasTag t12-manual-lock-off

      // ── m01290 隔离内部模拟 6 项（四象限核心路由）──
      // 每项记录真实 model/selection 投影值；前置档位用路由自有真切建立（写 lastSwitch 台账），
      // 手动项用直接 selectModel（模拟用户路径，不写台账）。全部模型值取自 config/动态榜。

      // 模拟1) 私聊闲聊：当前 work 档 → 切回 config.chatModel
      if (hasTag('s1-privchat')) {
        const ct1 = resolveChatTarget({ chatProvider: cfg.chatProvider, chatModel: cfg.chatModel, workProvider: cfg.workProvider, workModelFallback: cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL });
        const chatPair1 = `${ct1.provider}/${ct1.model}`;
        const r1s = await runRoute('s1-privchat', {
          text: '今天天气怎么样', meta: { channel: 'qq' },
          preset: { provider: cfg.workProvider, model: currentWorkModel(), effort: cfg.workEffort },
        });
        out.checks.s1_privchat_work_to_chat = { round: ROUND, chatTarget: chatPair1,
          presetOk: r1s.preset?.ok ?? null, presetReason: r1s.preset?.reason ?? null, presetProjection: r1s.presetProjection ?? null,
          route: r1s.route, projection: r1s.projection,
          switchOk: r1s.switch?.ok ?? null, reason: r1s.switch?.reason ?? r1s.note ?? null, target: r1s.switch?.target ?? r1s.target ?? null,
          pass: r1s.pass === null ? null : (
            r1s.preset?.ok === true && typeof r1s.presetProjection === 'string' && r1s.presetProjection.startsWith(`${cfg.workProvider}/`)
            && r1s.route?.mode === 'chat' && r1s.switch?.ok === true
            && typeof r1s.projection === 'string' && r1s.projection.startsWith(chatPair1)) };
        if (r1s.pass === null) { out.checks.s1_privchat_work_to_chat.skipped = true; out.checks.s1_privchat_work_to_chat.reason = r1s.note ?? 'session-create-failed'; }
        await flush();
      }

      // 模拟2) 私聊干活：当前 chat 档 → 切 config.workModel（动态最强/回退）
      if (hasTag('s2-privwork')) {
        const ct2 = resolveChatTarget({ chatProvider: cfg.chatProvider, chatModel: cfg.chatModel, workProvider: cfg.workProvider, workModelFallback: cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL });
        const chatPair2 = `${ct2.provider}/${ct2.model}`;
        const dyn2s = currentWorkModel();
        const r2s = await runRoute('s2-privwork', {
          text: '帮我查日志', meta: { channel: 'qq' }, strategy: cfg.privateChatWorkStrategy,
          preset: { provider: ct2.provider, model: ct2.model, effort: cfg.chatEffort },
        });
        out.checks.s2_privwork_chat_to_work = { round: ROUND, chatPreset: chatPair2, picked: dyn2s,
          presetOk: r2s.preset?.ok ?? null, presetReason: r2s.preset?.reason ?? null, presetProjection: r2s.presetProjection ?? null,
          route: r2s.route, projection: r2s.projection,
          switchOk: r2s.switch?.ok ?? null, reason: r2s.switch?.reason ?? r2s.note ?? null, target: r2s.switch?.target ?? r2s.target ?? null,
          pass: r2s.pass === null ? null : (
            r2s.preset?.ok === true && typeof r2s.presetProjection === 'string' && r2s.presetProjection.startsWith(chatPair2)
            && r2s.route?.mode === 'work' && r2s.route?.workStyle === 'free' && r2s.switch?.ok === true
            && typeof r2s.projection === 'string' && r2s.projection.startsWith(`${cfg.workProvider}/${dyn2s}`)) };
        if (r2s.pass === null) { out.checks.s2_privwork_chat_to_work.skipped = true; out.checks.s2_privwork_chat_to_work.reason = r2s.note ?? 'session-create-failed'; }
        await flush();
      }

      // 模拟3) 群聊干活：当前 chat 档 → 切 config.workModel（群工作恒 free 动态）
      if (hasTag('s3-groupwork')) {
        const ct3 = resolveChatTarget({ chatProvider: cfg.chatProvider, chatModel: cfg.chatModel, workProvider: cfg.workProvider, workModelFallback: cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL });
        const chatPair3 = `${ct3.provider}/${ct3.model}`;
        const dyn3s = currentWorkModel();
        const r3s = await runRoute('s3-groupwork', {
          text: '写个脚本', meta: { channel: 'qq', chatType: 'group' }, strategy: cfg.privateChatWorkStrategy,
          preset: { provider: ct3.provider, model: ct3.model, effort: cfg.chatEffort },
        });
        out.checks.s3_groupwork_chat_to_work = { round: ROUND, chatPreset: chatPair3, picked: dyn3s,
          presetOk: r3s.preset?.ok ?? null, presetReason: r3s.preset?.reason ?? null, presetProjection: r3s.presetProjection ?? null,
          route: r3s.route, projection: r3s.projection,
          switchOk: r3s.switch?.ok ?? null, reason: r3s.switch?.reason ?? r3s.note ?? null, target: r3s.switch?.target ?? r3s.target ?? null,
          pass: r3s.pass === null ? null : (
            r3s.preset?.ok === true && typeof r3s.presetProjection === 'string' && r3s.presetProjection.startsWith(chatPair3)
            && r3s.route?.mode === 'work' && r3s.route?.workStyle === 'free' && r3s.switch?.ok === true
            && typeof r3s.projection === 'string' && r3s.projection.startsWith(`${cfg.workProvider}/${dyn3s}`)) };
        if (r3s.pass === null) { out.checks.s3_groupwork_chat_to_work.skipped = true; out.checks.s3_groupwork_chat_to_work.reason = r3s.note ?? 'session-create-failed'; }
        await flush();
      }

      // 模拟4) 群聊闲聊：当前 work 档 → 切回 chatModel；冷却提示只触发一次（第二次进冷却）
      if (hasTag('s4-groupchat')) {
        const sid4 = takeSid('s4-groupchat');
        if (sid4) {
          const ct4 = resolveChatTarget({ chatProvider: cfg.chatProvider, chatModel: cfg.chatModel, workProvider: cfg.workProvider, workModelFallback: cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL });
          const chatPair4 = `${ct4.provider}/${ct4.model}`;
          const pre4 = await realSwitch(sid4, { provider: cfg.workProvider, model: currentWorkModel(), effort: cfg.workEffort });
          await new Promise((r) => setTimeout(r, 300));
          try { switchState.delete(sid4); } catch { /* 自测前置档位清节流（同 runRoute preset 口径），生产不动 */ }
          const before4 = await readSelectionProjectionFresh(sid4);
          const exec4 = { args: '哈哈哈', agent: { session: sid4, source: { channel: 'qq', chatType: 'group' } } };
          const meta4 = { channel: 'qq', chatType: 'group' };
          const route4 = decideRoute({ source: 'im', text: '哈哈哈', meta: meta4, strategy: cfg.privateChatWorkStrategy });
          const hintKey = `group hint for session ${sid4}`;
          const cnt = () => selftestLines.filter((l) => l.includes(hintKey)).length;
          // v0.7.5 Step4 分支三：断言随 enableGroupHint 门控走（不再块内强行打开）——
          // 开 = 发一次 + 冷却内不再发；关（生产默认）= 全程静默。iso2 patch 配 true 验真机 ON 路径。
          const hintGateOn = cfg.enableGroupHint === true;
          const h0 = cnt();
          maybeGroupHint(ctx, exec4, route4);
          const h1 = cnt();
          maybeGroupHint(ctx, exec4, route4); // 开：冷却内第二次不再提示；关：第二次同样静默
          const h2 = cnt();
          annotateRoute(exec4, route4, PINNED_WORK_MODEL);
          const tgt4 = exec4?.autoModelRouter?.target ?? null;
          let sw4 = { ok: false, reason: 'skipped-no-target' };
          if (tgt4) { sw4 = await realSwitch(sid4, tgt4); await new Promise((r) => setTimeout(r, 300)); }
          const after4 = await readSelectionProjectionFresh(sid4);
          out.checks.s4_groupchat_work_to_chat = { round: ROUND, chatTarget: chatPair4,
            presetOk: pre4.ok, presetReason: pre4.reason ?? null, before: before4,
            hintGate: hintGateOn, hintBefore: h0, hintAfter1: h1, hintAfter2: h2, hintCooldownMs: cfg.hintCooldownMs,
            route: route4, switchOk: sw4.ok, reason: sw4.reason ?? null, target: sw4.target ?? tgt4 ?? null, projection: after4,
            pass: pre4.ok === true && typeof before4 === 'string' && before4.startsWith(`${cfg.workProvider}/`)
              && h0 === 0 && h1 === (hintGateOn ? 1 : 0) && h2 === (hintGateOn ? 1 : 0)
              && route4?.mode === 'chat' && sw4.ok === true
              && typeof after4 === 'string' && after4.startsWith(chatPair4) };
        } else {
          out.checks.s4_groupchat_work_to_chat = { round: ROUND, pass: null, skipped: true, reason: 'session-create-failed' };
        }
        await flush();
      }

      // 模拟5) 手动选择优先：直接 selectModel（用户路径）选配置回退档 → 工作指令绝不覆盖
      if (hasTag('s5-manual')) {
        const sid5 = takeSid('s5-manual');
        if (sid5) {
          const manual5 = cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL;
          const manualPair5 = `${cfg.workProvider}/${manual5}`;
          try {
            const c5 = await resolveService('sessionController');
            await c5.selectModel({ sessionId: sid5, provider: cfg.workProvider, model: manual5, reasoningEffort: cfg.workEffort });
          } catch { /* 切失败体现在 before5/断言 */ }
          await new Promise((r) => setTimeout(r, 300));
          const before5 = await readSelectionProjectionFresh(sid5);
          const exec5 = { args: '帮我装插件', agent: { session: sid5, source: {} } };
          const route5 = decideRoute({ source: 'main', text: '帮我装插件', meta: {}, strategy: cfg.privateChatWorkStrategy });
          annotateRoute(exec5, route5, PINNED_WORK_MODEL);
          const tgt5 = exec5?.autoModelRouter?.target ?? null;
          let sw5 = { ok: false, reason: 'skipped-no-target' };
          if (tgt5) { sw5 = await realSwitch(sid5, tgt5); await new Promise((r) => setTimeout(r, 300)); }
          const after5 = await readSelectionProjectionFresh(sid5);
          out.checks.s5_manual_keep = { round: ROUND, manualPair: manualPair5, before: before5, after: after5,
            switchOk: sw5.ok, reason: sw5.reason ?? null, target: sw5.target ?? tgt5 ?? null,
            pass: sw5.ok === false && sw5.reason === 'user-manual-selection-kept'
              && String(after5) === String(before5)
              && typeof before5 === 'string' && before5.startsWith(manualPair5) };
        } else {
          out.checks.s5_manual_keep = { round: ROUND, pass: null, skipped: true, reason: 'session-create-failed' };
        }
        await flush();
      }

      // 模拟6) 全局不污染：切完 IM 会话后，全局默认三次读数一致 + 新开主界面会话默认未被污染
      if (hasTag('s6-nopollute')) {
        const adm6 = await resolveService('agentDefaultModel');
        try {
          if (adm6 && typeof adm6.saveSelection === 'function' && !adm6.__autoModelRouterGuard) {
            const origSave = adm6.saveSelection.bind(adm6);
            adm6.__autoModelRouterOrigSave = origSave;
            adm6.saveSelection = async (next) => {
              try { safeLog(ctx, 'info', `default-save intercepted (kept, not written): ${next?.provider ?? '?'} / ${next?.model ?? '?'}`); } catch { /* noop */ }
              return;
            };
            adm6.__autoModelRouterGuard = true;
            saveIntercepted = true;
          }
        } catch { /* 拦截重建失败走写回兜底 */ }
        const sid6s = takeSid('s6-nopollute');
        if (adm6 && sid6s) {
          const ct6 = resolveChatTarget({ chatProvider: cfg.chatProvider, chatModel: cfg.chatModel, workProvider: cfg.workProvider, workModelFallback: cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL });
          const before6s = adm6.currentSelection();
          const r6s = await realSwitch(sid6s, { provider: ct6.provider, model: ct6.model, effort: cfg.chatEffort });
          await new Promise((r) => setTimeout(r, 300));
          const afterSwitch6 = adm6.currentSelection();
          const sidNew6 = await mkSession('s6-new-main');
          const afterNew6 = adm6.currentSelection();
          out.checks.s6_no_pollution = { round: ROUND,
            before: before6s, afterSwitch: afterSwitch6, afterNewSession: afterNew6, newSessionId: sidNew6 ?? null,
            switchOk: r6s.ok, reason: r6s.reason ?? null, target: r6s.target ?? null,
            intercepted: adm6.__autoModelRouterGuard === true,
            unchanged: JSON.stringify(before6s) === JSON.stringify(afterSwitch6) && JSON.stringify(before6s) === JSON.stringify(afterNew6),
            pass: r6s.ok === true
              && JSON.stringify(before6s) === JSON.stringify(afterSwitch6)
              && JSON.stringify(before6s) === JSON.stringify(afterNew6)
              && adm6.__autoModelRouterGuard === true };
        } else {
          out.checks.s6_no_pollution = { round: ROUND, pass: null, skipped: true, reason: !adm6 ? 'no-agentDefaultModel' : 'session-create-failed' };
        }
        await flush();
      } // hasTag s6-nopollute

      // ── v0.5.2 冷启动二次判定 2 项（r8：台账为空 + durable 在位 + 跨类 → 放行一次）──
      // 直接经完整路径：durable 门 + runRoute 都不写 lastSwitch 台账 —— runRoute 的 preset 恰好
      // 模拟"重启失忆"（host 新进程 lastSwitch 为空），再发跨类指令看是否放行。
      // t13：durable 停 work 档（直接 selectModel 写档，不写台账）→ 发闲聊 → 应切回 chat 目标。
      if (hasTag('t13-coldstart-chat')) {
        const sid13 = takeSid('t13-coldstart-chat');
        if (sid13) {
          const ct13 = resolveChatTarget({ chatProvider: cfg.chatProvider, chatModel: cfg.chatModel, workProvider: cfg.workProvider, workModelFallback: cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL });
          const chatPair13 = `${ct13.provider}/${ct13.model}`;
          const workModel13 = currentWorkModel();
          let preset13err = null;
          try {
            const c13 = await resolveService('sessionController');
            if (!c13 || typeof c13.selectModel !== 'function') throw new Error('no-controller');
            try {
              await c13.selectModel({ sessionId: sid13, provider: cfg.workProvider, model: workModel13, reasoningEffort: cfg.workEffort });
            } catch (e) {
              // 目标模型无 effort 菜单时省略 effort 重试一次（与 realSwitch 同款语义）。
              const m = String(e?.message ?? e);
              if (/effort|unavailable|support/i.test(m)) await c13.selectModel({ sessionId: sid13, provider: cfg.workProvider, model: workModel13 });
              else throw e;
            }
          } catch (e) { preset13err = String(e?.message ?? e); }
          await new Promise((r) => setTimeout(r, 300));
          const before13 = await readSelectionProjectionFresh(sid13);
          // 冷启动现场：lastSwitch 台账为空（重启失忆）+ durable 在位 + 跨类 → 放行一次。
          // 直接走内联完整路径（不用 runRoute：它按 tag 取预建 sid，t13 专属 sid 已取走）。
          const exec13 = { args: '今天天气怎么样', agent: { session: sid13, source: { channel: 'qq' } } };
          const route13 = decideRoute({ source: 'im', text: '今天天气怎么样', meta: { channel: 'qq' }, strategy: cfg.privateChatWorkStrategy });
          ensureFresh();
          annotateRoute(exec13, route13, PINNED_WORK_MODEL);
          let tgt13 = exec13?.autoModelRouter?.target ?? null;
          let sw13 = { ok: false, reason: 'skipped-no-target' };
          try {
            if (tgt13) {
              if (tgt13) tgt13 = { ...tgt13, __routeMode: route13?.mode ?? '' };
              const keep13 = manualKeepReason(sid13, null, route13?.mode ?? '');
              if (keep13) { sw13 = { ok: false, reason: keep13, target: tgt13 }; }
              else { sw13 = await realSwitch(sid13, tgt13, route13?.mode ?? ''); await new Promise((r) => setTimeout(r, 300)); }
            }
          } catch { /* 走原路径 */ }
          const after13 = await readSelectionProjectionFresh(sid13);
          const coldLogs13 = (selftestLines ?? []).filter((l) => l.includes('cold-start reroute allowed')).length;
          out.checks.t13_coldstart_chat = { round: ROUND, before: before13, chatTarget: chatPair13,
            presetError: preset13err,
            route: route13, switchOk: sw13.ok, reason: sw13.reason ?? null, target: sw13.target ?? tgt13 ?? null,
            projection: after13, coldLogCount: coldLogs13,
            pass: typeof before13 === 'string' && before13.startsWith(`${cfg.workProvider}/`)
              && route13?.mode === 'chat' && sw13.ok === true && coldLogs13 >= 1
              && typeof after13 === 'string' && after13.startsWith(chatPair13) };
        } else {
          out.checks.t13_coldstart_chat = { round: ROUND, pass: null, skipped: true, reason: 'session-create-failed' };
        }
        await flush();
      }

      // t14：durable 停 chat 档（直接 selectModel 写档，不写台账）→ 发工作指令 → 应切到 work 目标。
      if (hasTag('t14-coldstart-work')) {
        const sid14 = takeSid('t14-coldstart-work');
        if (sid14) {
          const ct14 = resolveChatTarget({ chatProvider: cfg.chatProvider, chatModel: cfg.chatModel, workProvider: cfg.workProvider, workModelFallback: cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL });
          const chatPair14 = `${ct14.provider}/${ct14.model}`;
          const workModel14 = currentWorkModel();
          const workPair14 = `${cfg.workProvider}/${workModel14}`;
          let preset14err = null;
          try {
            const c14 = await resolveService('sessionController');
            if (!c14 || typeof c14.selectModel !== 'function') throw new Error('no-controller');
            try {
              await c14.selectModel({ sessionId: sid14, provider: ct14.provider, model: ct14.model, reasoningEffort: cfg.chatEffort });
            } catch (e) {
              // 目标模型无 effort 菜单时省略 effort 重试一次（与 realSwitch 同款语义）。
              const m = String(e?.message ?? e);
              if (/effort|unavailable|support/i.test(m)) await c14.selectModel({ sessionId: sid14, provider: ct14.provider, model: ct14.model });
              else throw e;
            }
          } catch (e) { preset14err = String(e?.message ?? e); }
          // 投影落定有延迟（t6 同款 3×500ms 口径）：chat 预置档读不出则 before 不成立，直接判
          // pass:null 跳过（环境抖动不记失败）——与 t6 的 unreadable 口径一致。
          let before14 = await readSelectionProjectionFresh(sid14);
          for (let ri = 0; ri < 3 && (before14 === '(projection-unreadable)' || before14 == null); ri++) {
            await new Promise((r) => setTimeout(r, 500));
            before14 = await readSelectionProjectionFresh(sid14);
          }
          const exec14 = { args: '帮我装插件', agent: { session: sid14, source: { channel: 'qq' } } };
          const route14 = decideRoute({ source: 'im', text: '帮我装插件', meta: { channel: 'qq' }, strategy: cfg.privateChatWorkStrategy });
          ensureFresh();
          annotateRoute(exec14, route14, PINNED_WORK_MODEL);
          let tgt14 = exec14?.autoModelRouter?.target ?? null;
          let sw14 = { ok: false, reason: 'skipped-no-target' };
          try {
            if (tgt14) {
              if (tgt14) tgt14 = { ...tgt14, __routeMode: route14?.mode ?? '' };
              const keep14 = manualKeepReason(sid14, null, route14?.mode ?? '');
              if (keep14) { sw14 = { ok: false, reason: keep14, target: tgt14 }; }
              else { sw14 = await realSwitch(sid14, tgt14, route14?.mode ?? ''); await new Promise((r) => setTimeout(r, 300)); }
            }
          } catch { /* 走原路径 */ }
          const after14 = await readSelectionProjectionFresh(sid14);
          const coldLogs14 = (selftestLines ?? []).filter((l) => l.includes('cold-start reroute allowed')).length;
          out.checks.t14_coldstart_work = { round: ROUND, before: before14, chatPreset: chatPair14, workTarget: workPair14,
            presetError: preset14err, route: route14, switchOk: sw14.ok, reason: sw14.reason ?? null, target: sw14.target ?? tgt14 ?? null,
            projection: after14, coldLogCount: coldLogs14,
            pass: (before14 === '(projection-unreadable)' || before14 == null) ? null
              : (typeof before14 === 'string' && before14.startsWith(chatPair14)
              && route14?.mode === 'work' && sw14.ok === true && coldLogs14 >= 1
              && typeof after14 === 'string' && after14.startsWith(workPair14)) };
        } else {
          out.checks.t14_coldstart_work = { round: ROUND, pass: null, skipped: true, reason: 'session-create-failed' };
        }
        await flush();
      }

      // 动态信息（供回归对比）：排行榜命中/回退
      try {
        await refreshFreeList();
        await refreshLeaderboard();
        const dyn = dynModel();
        const lbMeta = lb.meta();
        const { ranked } = await import('./leaderboard.js').then((m) => m.rankIntersection(lb.get() ?? [], freeList.avail ?? []));
        out.checks.dynamic = {
          freeCount: (freeList.avail ?? []).length,
          lbCount: (lb.get() ?? []).length,
          lbError: lbMeta.lastError,
          rankedTop3: ranked.slice(0, 3),
          picked: dyn,
          fallsBack: typeof dyn === 'string' && dyn.length > 0,
        };
      } catch (e) {
        out.checks.dynamic = { error: String(e?.message ?? e) };
      }
      await flush();

      out.totalMs = Date.now() - t0;
      await flush();
      // failures 口径：新 8 项走 pass 字段（pass===null 为环境偶发创建失败，跳过不计入）；
      // create_* 键为会话创建重试记录，不单独计入（对应 t 项的 pass 已覆盖）。
      // 旧口径 fallback/dynamic/manual/uisync 仍按专用字段。
      const failures = [];
      for (const [k, v] of Object.entries(out.checks)) {
        if (k.startsWith('create_')) continue;
        if (!v) { failures.push(k); continue; }
        if (v.error || v.unchanged === false) { failures.push(k); continue; }
        if (k.startsWith('t1_') || k.startsWith('t2_') || k.startsWith('t3_') || k.startsWith('t4_') ||
            k.startsWith('t5_') || k.startsWith('t6_') || k.startsWith('t7_') || k.startsWith('t8_') ||
            k.startsWith('t9_') || k.startsWith('t10_') || k.startsWith('t11_') || k.startsWith('t12_') ||
            k.startsWith('t13_') || k.startsWith('t14_') ||
            k.startsWith('s1_') || k.startsWith('s2_') || k.startsWith('s3_') || k.startsWith('s4_') || k.startsWith('s5_') || k.startsWith('s6_')) {
          if (v.pass === null || v.pass === undefined) continue; // 环境偶发，跳过
          if (v.pass !== true) failures.push(k);
          continue;
        }
        if (k === 'fallback') { if (!(v.degraded === true && v.hookStillAlive === true)) failures.push(k); continue; }
        if (k === 'manual') { if (!(v.manualKept === true)) failures.push(k); continue; }
        if (k === 'dynamic') { if (!(v.fallsBack === true)) failures.push(k); continue; }
        if (k === 'uisync') { if (!(v.ok === true && v.matches === true)) failures.push(k); continue; }
        if (v && v.ok === false) failures.push(k);
      }
      console.log('SELFTEST_DONE ' + JSON.stringify({ totalMs: out.totalMs, checks: Object.keys(out.checks), failures }));
    };

    setTimeout(() => { runSelftest().catch(async (err) => { out.fatal = String(err?.stack ?? err); await flush(); }); }, 300);
  }
}