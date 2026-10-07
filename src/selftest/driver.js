import { runEarlyChecks } from './checks-early.js';
import { runLateChecks } from './checks-late.js';

// ── 隔离自测驱动（仅 cfg.selftest 时执行；生产 patch 不配置该键 = 完全不运行）──
// 方案B多轮常驻：cfg.selftest=true 跑全量；cfg.selftest='r1'..'r4' 或 cfg.selftestRound
// 只跑该回合 2 项。每个回合独立启动（headless 新进程），启动即重取服务并记录 ready。
// 迁移自 src/index.js apply() 闭包内 if (cfg.selftest) { ... } 整块（原 1505-2243 行）：
// 本文件 = 驱动（轮次/输出/服务探测/会话/预热/runRoute/failures/SELFTEST_DONE/启动），
// 断言本体在 ./checks-early.js（原 1)-10) 段）与 ./checks-late.js（原 11)-14)、s1..s6、dynamic 段）。
export function startSelftest(d) {
  const { cfg, ctx, getService, safeLog, writeTextFile, resolveService, refreshFreeList, refreshLeaderboard, currentWorkModel, lb, freeList, decideRoute, sourceFromMeta, ensureFresh, annotateRoute, applyPriorityMode, manualKeepReason, shouldSwitch, realSwitch, readSelectionProjectionFresh, switchState } = d;
  // 原 `if (cfg.selftest) { ... }` 整块门控 → 等价早退（index.js 接线处仍可再套同款门控）。
  if (!cfg.selftest) return;
    if (Array.isArray(d.logLines)) d.logLines.length = 0; // 原 `selftestLines = []`：原地清空，保持数组身份不变（safeLog 持续推同一数组）
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
        out.logs = d.logLines ? d.logLines.slice(-40) : [];
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

      // 共享环境：runSelftest 局部量原名传入两个断言文件（原闭包变量，名字不变）。
      const E = { out, flush, ROUND, hasTag, runRoute, takeSid, mkSession, dynModel, PINNED_WORK_MODEL };
      await runEarlyChecks(d, E); // 原 1)-10) 段（prework/t1..t10）
      await runLateChecks(d, E);  // 原 11)-14)、s1..s6、dynamic 段

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
