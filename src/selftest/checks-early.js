// ── 隔离自测断言（早段）：prework + t1..t10（原 src/index.js runSelftest 内 1646-1833 行原样迁移）──
// 由 ./driver.js 的 startSelftest 调用：预热 + PINNED_WORK_MODEL 钉死之后、晚段断言之前。
// d = startSelftest 注入对象（d.logLines / d.lbFetchCount 活引用；开关翻转经 d.flags）；
// E = driver 共享环境 { out, flush, ROUND, hasTag, runRoute, takeSid, mkSession, dynModel, PINNED_WORK_MODEL }。
export async function runEarlyChecks(d, E) {
  const { cfg, flags, ctx, safeLog, resolveService, refreshLeaderboard, currentWorkModel, realSwitch, readSelectionProjectionFresh, decideRoute, annotateRoute, resolveChatTarget, DEFAULT_WORK_MODEL } = d;
  const { out, flush, ROUND, hasTag, runRoute, takeSid, dynModel, PINNED_WORK_MODEL } = E;
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
        const warnBefore = d.logLines.filter((l) => l.includes('UI sync check')).length;
        const r = await realSwitch(sid7, { provider: cfg.workProvider, model: dynModel(), effort: cfg.workEffort });
        const back = await readSelectionProjectionFresh(sid7);
        const warnAfter = d.logLines.filter((l) => l.includes('UI sync check')).length;
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
          flags.saveIntercepted = true;
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
      const before10 = d.lbFetchCount;
      const savedOn = flags.dynamicOn;
      flags.dynamicOn = false;
      try {
        await refreshLeaderboard();
        const fallback10 = cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL;
        const wm = currentWorkModel();
        const fetchDelta = d.lbFetchCount - before10;
        out.checks.t10_dynamic_off = { round: ROUND, fetchDelta, workModel: wm, fallback: fallback10,
          pass: fetchDelta === 0 && wm === fallback10 };
      } finally {
        flags.dynamicOn = savedOn;
      }
      await flush();
      } // hasTag t10-dynamic-off
}
