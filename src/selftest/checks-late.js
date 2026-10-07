// ── 隔离自测断言（晚段）：t11..t14 + s1..s6 + dynamic（原 src/index.js runSelftest 内 1835-2212 行原样迁移）──
// 由 ./driver.js 的 startSelftest 在早段断言之后顺序调用。
// d = startSelftest 注入对象（d.logLines / d.lbFetchCount / d.manualLock 活引用；开关翻转经 d.flags）；
// E = driver 共享环境 { out, flush, ROUND, hasTag, runRoute, takeSid, mkSession, dynModel, PINNED_WORK_MODEL }。
export async function runLateChecks(d, E) {
  const { cfg, flags, ctx, safeLog, resolveService, syncManualLock, refreshFreeList, refreshLeaderboard, currentWorkModel, realSwitch, readSelectionProjectionFresh, decideRoute, ensureFresh, annotateRoute, manualKeepReason, resolveChatTarget, DEFAULT_WORK_MODEL, switchState, maybeGroupHint, lb, freeList } = d;
  const { out, flush, ROUND, hasTag, runRoute, takeSid, mkSession, dynModel, PINNED_WORK_MODEL } = E;
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
          const beforeFetch11 = d.lbFetchCount;
          await refreshLeaderboard(); // 锁下必须 0 请求（d.lbFetchCount 不动）
          const fetchDelta11 = d.lbFetchCount - beforeFetch11;
          const t11 = await runRoute('t11-manual-lock', { text: '帮我装插件', meta: { channel: 'qq' }, strategy: 'free' });
          const lockLogs11 = (d.logLines ?? []).filter((l) => l.includes('manual-work-model-locked')).length;
          out.checks.t11_manual_lock = { round: ROUND, manualPair: MANUAL_PAIR, lock: { on: d.manualLock.on, provider: d.manualLock.provider, model: d.manualLock.model, reason: d.manualLock.reason ?? null },
            fetchDelta: fetchDelta11, lockLogCount: lockLogs11, route: t11.route,
            switchOk: t11.switch?.ok ?? null, reason: t11.switch?.reason ?? null, target: t11.switch?.target ?? t11.target ?? null,
            projection: t11.projection,
            pass: t11.pass !== null && d.manualLock.on === true && fetchDelta11 === 0 && lockLogs11 >= 1
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
          const offWhenDisabled = d.manualLock.on === false;
          cfg.manualWorkModelLocked = true;
          cfg.manualWorkModel = '';
          syncManualLock();
          const offWhenEmpty = d.manualLock.on === false;
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
          const cnt = () => d.logLines.filter((l) => l.includes(hintKey)).length;
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
            flags.saveIntercepted = true;
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
          const coldLogs13 = (d.logLines ?? []).filter((l) => l.includes('cold-start reroute allowed')).length;
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
          const coldLogs14 = (d.logLines ?? []).filter((l) => l.includes('cold-start reroute allowed')).length;
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
        const { ranked } = await import('../leaderboard/leaderboard.js').then((m) => m.rankIntersection(lb.get() ?? [], freeList.avail ?? []));
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
}
