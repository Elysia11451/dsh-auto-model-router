import assert from 'node:assert/strict';
import { apply, name, inject } from '../src/index.js';

// 最小 ctx 仿真：复刻官方 auto-review 的 tools/pre-execute + effect 语义
// 含 sessionController + agentDefaultModel：验证真切与污染回写
function makeCtx({ llm = {}, failRegister = false, selectImpl = null, admImpl = null } = {}) {
  const handlers = {};
  const calls = [];
  return {
    ctx: {
      llm,
      sessionController: {
        async selectModel(payload) {
          calls.push(payload);
          if (selectImpl) return selectImpl(payload);
          return { selected: { ...payload } };
        },
      },
      agentDefaultModel: admImpl || {
        _saved: [],
        currentSelection() { return { provider: 'our-free-model', model: 'muse-spark-1.3-contributor-free', reasoningEffort: 'deep' }; },
        async saveSelection(next) { this._saved.push(next); },
      },
      // v0.5.1：durable 门需要的最小投影/会话服务。默认 pristine：无 pending、无请求头
      // （真实语义：新建会话未发消息时无 durable 选择，路由可作用）。
      sessionProjections: { stateOf: (sess) => ({ lastUsed: null, pending: sess?.__pending ?? null }) },
      sessions: { get: (id) => ({ id, requestHeader: () => undefined }) },
      logger: () => ({ info() {}, warn() {}, error() {} }),
      effect(fn, _tag) { try { const g = fn(); if (g && typeof g.next === 'function') g.next(); } catch {} },
      on(evt, handler) {
        if (failRegister) throw new Error('register boom');
        handlers[evt] = handler;
        return () => { delete handlers[evt]; };
      },
    },
    handlers,
    calls,
  };
}
const runPre = (handlers, exec) => handlers['tools/pre-execute'](exec, async () => ({ kind: 'allow' }));

// ── v0.7.2 阶段三：真切路径从 pre-execute 迁到 pre-step（状态机决策）──
// 统一驱动器：以真人消息形状走 agent/pre-step（isHumanInput + 状态机 + 真切全链路）。
const runStep = (handlers, { text, sid = 'session-s3', meta = { channel: 'qq' }, turn = 1 }) =>
  handlers['agent/pre-step']({
    agent: { session: sid, source: meta },
    turn, step: 1,
    messages: [{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'x-human-1' } }],
  }, async () => ({ kind: 'allow' }));

// 隔离 DSH_HOME + 读 JSONL（keepReason/switched/actualSel 等真切结果经 decision 行断言——
// pre-step 的注解落在内部 holder 上，测试不可见，JSONL 是权威出口）。
const withTmpLog = async (fn) => {
  const fsP = await import('node:fs/promises');
  const osP = await import('node:os');
  const pathP = await import('node:path');
  const home = await fsP.mkdtemp(pathP.join(osP.tmpdir(), 'router-s3-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const readLines = async () => {
    try {
      const raw = await fsP.readFile(pathP.join(home, 'logs', 'auto-router.jsonl'), 'utf8');
      return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  };
  try { return await fn(readLines, home); }
  finally { if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev; }
};

const t = async (n, fn) => { try { await fn(); console.log(`ok - ${n}`); } catch (e) { console.error(`FAIL - ${n}: ${e.message}`); process.exitCode = 1; } };

// 导出形态：具名 name/inject/apply（移动端强制 ['tools','llm']，多写即 PENDING）
await t('named exports + inject', () => {
  assert.equal(name, 'dsh-auto-model-router');
  assert.deepEqual(inject, ['tools', 'llm']);
});

// apply 永不抛（含注册失败）
await t('apply never throws on register failure', () => {
  const { ctx } = makeCtx({ failRegister: true });
  assert.doesNotThrow(() => apply(ctx, {}));
});

// 异常 exec（undefined 字段 / kind 未定义注入）不崩溃且放行
await t('malformed exec still passes through', async () => {
  const { ctx, handlers } = makeCtx();
  apply(ctx, {});
  for (const bad of [{}, { args: null }, { agent: null }, { args: { kind: undefined } }, null]) {
    const res = await runPre(handlers, bad || {});
    assert.equal(res?.kind, 'allow');
  }
});

// next 本身抛错也不向上传播
await t('next throwing does not propagate', async () => {
  const { ctx, handlers } = makeCtx();
  apply(ctx, {});
  const h = handlers['tools/pre-execute'];
  const res = await h({ args: 'x' }, async () => { throw new Error('downstream boom'); });
  assert.equal(res?.kind, 'allow');
});

// free-model 缺失降级：llm 为空时 apply 不抛，钩子照常放行
await t('missing free-model degrades, never crashes', async () => {
  const { ctx, handlers } = makeCtx({ llm: null });
  assert.doesNotThrow(() => apply(ctx, {}));
  const res = await runPre(handlers, { args: 'hello' });
  assert.equal(res?.kind, 'allow');
});

// 注解不污染原字段
await t('annotation is namespaced', async () => {
  const { ctx, handlers } = makeCtx();
  apply(ctx, {});
  const exec = { args: '帮我装插件', agent: {} };
  await runPre(handlers, exec);
  assert.equal(exec.autoModelRouter?.route, 'work');
  assert.equal(typeof exec.args, 'string');
});

// 真切（v0.7.2 阶段三：走 pre-step 状态机路径）：IM 闲聊切 chat 档，sessionId 直传 + effort 归一化
await t('real switch passes sessionId through with normalized effort', async () => {
  const { ctx, handlers, calls } = makeCtx();
  apply(ctx, {});
  await runStep(handlers, { text: '今天天气怎么样', sid: 'session-aaa', meta: { channel: 'weixin' } });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, 'session-aaa');
  assert.equal(calls[0].provider, 'zai-coding-cn');
  assert.equal(calls[0].model, 'glm-5.3-flash');
  assert.equal(calls[0].reasoningEffort, 'light');
});

// 污染拦截：apply 后 saveSelection 被替换为 report-only（真实写入 0 次）
await t('saveSelection intercepted to report-only', async () => {
  const writes = [];
  const adm = {
    currentSelection() { return { provider: 'x', model: 'y' }; },
    async saveSelection(next) { writes.push(next); },
  };
  const { ctx } = makeCtx({ admImpl: adm });
  apply(ctx, {});
  await adm.saveSelection({ provider: 'zai-coding-cn', model: 'glm-5.3-flash' });
  assert.equal(writes.length, 0);
  assert.equal(adm.__autoModelRouterGuard, true);
});

// 污染回写：拦截生效时真实写入 0 次（维持切前默认）
await t('global default untouched when intercept active (no pollution)', async () => {
  const saved = [];
  const adm = {
    currentSelection() { return { provider: 'our-free-model', model: 'muse-spark-1.3-contributor-free', reasoningEffort: 'deep' }; },
    async saveSelection(next) { saved.push(next); },
  };
  const { ctx, handlers } = makeCtx({ admImpl: adm });
  apply(ctx, {});
  const exec = { args: 'hi', agent: { session: 'session-bbb', source: { channel: 'qq' } } };
  await runPre(handlers, exec);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(saved.length, 0);
});

// 无 effort 菜单重试：首次 model-unavailable -> 去 effort 重试
await t('no-menu model retries without effort', async () => {
  let n = 0;
  const { ctx, handlers, calls } = makeCtx({
    selectImpl: async (p) => { n++; if (n === 1 && p.reasoningEffort) { const e = new Error('unsupported effort'); e.code = 'session/model-unavailable'; throw e; } return { selected: { ...p } }; },
  });
  apply(ctx, {});
  await runStep(handlers, { text: 'hi', sid: 'session-ccc' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].reasoningEffort, undefined);
});

// 真切失败降级：controller 抛错也放行，不阻断
await t('switch failure still passes through', async () => {
  await withTmpLog(async (readLines) => {
    const { ctx, handlers } = makeCtx({ selectImpl: async () => { throw new Error('controller down'); } });
    apply(ctx, {});
    const res = await runStep(handlers, { text: 'hi', sid: 'session-ddd' });
    assert.equal(res?.kind, 'allow');
    await new Promise((r) => setTimeout(r, 50));
    const lines = await readLines();
    const decision = lines.find((l) => l.tool === 'agent/pre-step/decision' && l.sid === 'session-ddd');
    assert.ok(decision, 'decision line must exist');
    assert.equal(decision.switched, false, 'failed switch must record switched=false');
  });
});

// 节流：同一会话 60s 内不重复切
await t('same-session switch throttled', async () => {
  const { ctx, handlers, calls } = makeCtx();
  apply(ctx, {});
  for (let i = 1; i <= 3; i++) {
    await runStep(handlers, { text: 'hi', sid: 'session-eee', turn: i });
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 1);
});

// 精确同类：投影恰为当前动态目标（回退值 mimo）-> 工作指令不重复切
await t('exact same model kept, not re-switched', async () => {
  await withTmpLog(async (readLines) => {
    const { ctx, handlers, calls } = makeCtx();
    // 伪造投影：当前已是动态目标 mimo（精确同类）
    ctx.sessionProjections = {
      stateOf: () => ({ pending: { provider: 'our-free-model', model: 'mimo-v2.6-flash-free', reasoningEffort: 'deep' } }),
    };
    ctx.sessions = { get: () => ({}) };
    apply(ctx, {});
    const res = await runStep(handlers, { text: '帮我装插件', sid: 'session-manual', meta: {} });
    assert.equal(res?.kind, 'allow');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 0, 'exact same-kind must not call selectModel');
    const decision = (await readLines()).find((l) => l.tool === 'agent/pre-step/decision' && l.sid === 'session-manual');
    assert.ok(decision, 'decision line must exist');
    assert.ok(decision.keepReason, 'must record a keep reason');
    assert.match(String(decision.actualSel ?? ''), /our-free-model/);
    assert.equal(decision.switched, null, 'no switch issued');
  });
});

// v0.5.1 语义改写：手动 1.3 在位（durable pending）+ 工作指令目标动态最强 -> 绝不覆盖
await t('durable manual selection never overridden (cross-model)', async () => {
  await withTmpLog(async (readLines) => {
    const { ctx, handlers, calls } = makeCtx();
    ctx.sessionProjections = {
      stateOf: () => ({ lastUsed: null, pending: { provider: 'our-free-model', model: 'muse-spark-1.3-contributor-free', reasoningEffort: 'deep' } }),
    };
    ctx.sessions = { get: () => ({}) };
    apply(ctx, { reclaimUnknownModel: false }); // v0.5.3：守关闭纠偏时的手动优先（默认开启时未知1.3会被纠偏）
    const res = await runStep(handlers, { text: '帮我装插件', sid: 'session-crossmodel', meta: {} });
    assert.equal(res?.kind, 'allow');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 0, 'durable selection must block any switch');
    const decision = (await readLines()).find((l) => l.tool === 'agent/pre-step/decision' && l.sid === 'session-crossmodel');
    assert.ok(decision, 'decision line must exist');
    assert.equal(decision.keepReason, 'user-manual-selection-kept');
    assert.notEqual(decision.switched, true, 'must not switch');
  });
});

// v0.5.2 语义更新：台账为空 + durable 停 chat 档 + 工作指令 → 跨类放行（不再保持）。
// 原“durable chat kept”断言已过时（v0.5.1 语义），由“cold-start same lane”承接保守语义。
await t('durable chat selection rerouted under work command when ledger empty (cross-type, v0.5.2)', async () => {
  await withTmpLog(async (readLines) => {
    const { ctx, handlers, calls } = makeCtx();
    ctx.sessionProjections = {
      stateOf: () => ({ lastUsed: null, pending: { provider: 'zai-coding-cn', model: 'glm-5.3-flash', reasoningEffort: 'light' } }),
    };
    ctx.sessions = { get: () => ({}) };
    apply(ctx, {});
    await runStep(handlers, { text: '帮我装插件', sid: 'session-cross', meta: {} });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 1, 'cold-start cross-kind work must reroute from chat lane');
    assert.equal(calls[0].provider, 'our-free-model');
    const decision = (await readLines()).find((l) => l.tool === 'agent/pre-step/decision' && l.sid === 'session-cross');
    assert.ok(decision, 'decision line must exist');
    assert.notEqual(decision.keepReason, 'user-manual-selection-kept');
    assert.equal(decision.switched, true, 'cross-kind reroute must switch');
  });
});

// 同类 chat 保持：投影已在 chat 档 -> 闲聊不重复切
await t('same-kind chat kept', async () => {
  await withTmpLog(async (readLines) => {
    const { ctx, handlers, calls } = makeCtx();
    ctx.sessionProjections = {
      stateOf: () => ({ pending: { provider: 'zai-coding-cn', model: 'glm-5.3-flash', reasoningEffort: 'light' } }),
    };
    ctx.sessions = { get: () => ({}) };
    apply(ctx, {});
    await runStep(handlers, { text: '今天天气怎么样', sid: 'session-chatkeep', meta: { channel: 'weixin' } });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 0, 'already on chat must not re-switch');
    const decision = (await readLines()).find((l) => l.tool === 'agent/pre-step/decision' && l.sid === 'session-chatkeep');
    assert.ok(decision, 'decision line must exist');
    assert.match(String(decision.actualSel ?? ''), /zai-coding-cn/);
    assert.ok(decision.keepReason, 'must record a keep reason');
  });
});

// ── v0.5.0 新增 ──

// chatModel 为空（Config 描述承诺的回退）：真切必须落到 workProvider/workModelFallback，绝不传空 model
await t('empty chatModel falls back to work fallback on real switch', async () => {
  const { ctx, handlers, calls } = makeCtx();
  apply(ctx, { chatModel: '' });
  await runStep(handlers, { text: '今天天气怎么样', sid: 'session-emptychat', meta: { channel: 'weixin' } });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'our-free-model');
  assert.equal(calls[0].model, 'mimo-v2.6-flash-free');
  assert.ok(calls[0].model, 'model must never be empty');
  assert.equal(calls[0].reasoningEffort, 'light'); // 聊天仍走省 token 档
});

// 表单只暴露 chatModel 键：用户填 prov/mod 必须拆开走，不能整体当模型名
await t('chatModel prov/mod format splits into provider+model', async () => {
  const { ctx, handlers, calls } = makeCtx();
  apply(ctx, { chatModel: 'my-api/glm-x' });
  await runStep(handlers, { text: '你好', sid: 'session-provmod' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'my-api');
  assert.equal(calls[0].model, 'glm-x');
});

// enableDynamicRanking=false：全程 0 次 OpenRouter 请求，工作目标直接回退配置值
await t('enableDynamicRanking=false never fetches OpenRouter', async () => {
  const origFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url, ...rest) => { urls.push(String(url)); return origFetch(url, ...rest); };
  try {
    const { ctx, handlers, calls } = makeCtx();
    apply(ctx, { enableDynamicRanking: false });
    await new Promise((r) => setTimeout(r, 80)); // 等 apply 预热链跑完
    await runStep(handlers, { text: '帮我装插件', sid: 'session-dynoff', meta: {} });
    await new Promise((r) => setTimeout(r, 80)); // 等 ensureFresh 后台链跑完
    assert.equal(urls.filter((u) => u.includes('openrouter.ai')).length, 0, `must not fetch OpenRouter, got: ${urls.join(', ')}`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'mimo-v2.6-flash-free'); // 回退配置值而非动态榜
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── v0.5.1 新增：手动绝对优先 + 手动锁 ──

// durable request header（首条消息后即存在）同样构成手动优先，路由绝不覆盖
// v0.5.3：关闭纠偏门（reclaimUnknownModel:false）守此语义 —— 默认开启时未知外来值会被纠偏收编。
await t('durable request header blocks switching', async () => {
  await withTmpLog(async (readLines) => {
    const { ctx, handlers, calls } = makeCtx();
    ctx.sessionProjections = { stateOf: () => ({ lastUsed: null, pending: null }) };
    ctx.sessions = { get: () => ({ requestHeader: () => ({ config: { provider: 'our-free-model', model: 'muse-spark-1.3-contributor-free', reasoningEffort: 'deep' } }) }) };
    apply(ctx, { reclaimUnknownModel: false });
    await runStep(handlers, { text: '帮我装插件', sid: 'session-hdr', meta: {} });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 0, 'durable header must block any switch');
    const decision = (await readLines()).find((l) => l.tool === 'agent/pre-step/decision' && l.sid === 'session-hdr');
    assert.ok(decision, 'decision line must exist');
    assert.equal(decision.keepReason, 'user-manual-selection-kept');
    assert.notEqual(decision.switched, true, 'must not switch');
  });
});

// 状态读不出（sessions.get 返回 null）=> 保守保留，绝不赌手动选择
await t('unreadable selection state keeps conservatively', async () => {
  await withTmpLog(async (readLines) => {
    const { ctx, handlers, calls } = makeCtx();
    ctx.sessions = { get: () => null };
    apply(ctx, {});
    await runStep(handlers, { text: '帮我装插件', sid: 'session-unreadable', meta: {} });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 0, 'unknown state must not switch');
    const decision = (await readLines()).find((l) => l.tool === 'agent/pre-step/decision' && l.sid === 'session-unreadable');
    assert.ok(decision, 'decision line must exist');
    assert.equal(decision.keepReason, 'selection-state-unreadable');
  });
});

// 功能二：锁开 -> 工作真切落手动 pair（故意 ≠ 回退值，证明压过动态/回退）
await t('manual work-model lock forces manual target', async () => {
  const { ctx, handlers, calls } = makeCtx();
  apply(ctx, { manualWorkModelLocked: true, manualWorkModel: 'our-free-model/muse-spark-1.3-contributor-free' });
  await withTmpLog(async (readLines) => {
    await runStep(handlers, { text: '帮我装插件', sid: 'session-lockon', meta: {} });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].provider, 'our-free-model');
    assert.equal(calls[0].model, 'muse-spark-1.3-contributor-free');
    const decision = (await readLines()).find((l) => l.tool === 'agent/pre-step/decision' && l.sid === 'session-lockon');
    assert.ok(decision, 'decision line must exist');
    assert.match(String(decision.target ?? ''), /muse-spark-1\.3-contributor-free/);
  });
});

// 功能二：锁关（配了值也不生效）-> 走动态/回退
await t('manual lock disabled falls back to dynamic/fallback', async () => {
  const { ctx, handlers, calls } = makeCtx();
  apply(ctx, { manualWorkModelLocked: false, manualWorkModel: 'our-free-model/muse-spark-1.3-contributor-free' });
  await runStep(handlers, { text: '帮我装插件', sid: 'session-lockoff', meta: {} });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'mimo-v2.6-flash-free', 'disabled lock must use dynamic/fallback, not manual value');
});

// 功能二：锁开但值为空 -> 不构成锁（规格：manualWorkModel 默认空即回退动态）
await t('lock enabled with empty manualWorkModel is inert', async () => {
  const { ctx, handlers, calls } = makeCtx();
  apply(ctx, { manualWorkModelLocked: true, manualWorkModel: '' });
  await runStep(handlers, { text: '帮我装插件', sid: 'session-lockempty', meta: {} });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'mimo-v2.6-flash-free', 'empty manual value must fall back to dynamic/fallback');
});

// v0.7.0 静态降级链接线：enableDynamicRanking=false + 隔离 DSH_HOME 清单夹具 ——
// 链头不可用时必须走链第二位（证明 currentWorkModel → pickWorkModelFromChain 接线，而非单值回退）。
await t('static chain walks to second entry when head unavailable (v0.7.0 wiring)', async () => {
  const fsP = await import('node:fs/promises');
  const osP = await import('node:os');
  const pathP = await import('node:path');
  const home = await fsP.mkdtemp(pathP.join(osP.tmpdir(), 'router-chain-fixture-'));
  await fsP.mkdir(pathP.join(home, 'our-free-model'), { recursive: true });
  // 夹具清单：链头 mimo 不在可用列表，第二位 glm 可用
  await fsP.writeFile(pathP.join(home, 'our-free-model', 'catalog.json'),
    JSON.stringify({ entries: ['glm-5.3-flash-free', 'deepseek-v4-flash-free'] }));
  await fsP.writeFile(pathP.join(home, 'our-free-model', 'availability.json'),
    JSON.stringify({ results: { 'glm-5.3-flash-free': { state: 'available' }, 'deepseek-v4-flash-free': { state: 'available' } } }));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const { ctx, handlers, calls } = makeCtx();
    apply(ctx, {
      enableDynamicRanking: false,
      workModelPriority: ['mimo-v2.6-flash-free', 'glm-5.3-flash', 'deepseek-v4.1-flash'],
    });
    // 清单加载是 apply 内 fire-and-forget：等它读完夹具文件
    await new Promise((r) => setTimeout(r, 300));
    await runStep(handlers, { text: '帮我装插件', sid: 'session-chain-v070', meta: {} });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].provider, 'our-free-model');
    assert.equal(calls[0].model, 'glm-5.3-flash', 'head unavailable → chain entry #2, not single fallback');
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
  }
});

// v0.5.1 来源判定（lastSwitch 台账）：路由自己切出的 durable 态 → 允许继续四象限路由
await t('router-made selection allows re-routing (ledger match)', async () => {
  const { ctx, handlers, calls } = makeCtx();
  const proj = { pending: null };
  ctx.sessionProjections = { stateOf: () => ({ lastUsed: null, pending: proj.pending }) };
  apply(ctx, {});
  const sid = 'session-ledger-match';
  await withTmpLog(async (readLines) => {
    // 1) 全新会话闲聊 → 切 chat 成功（realSwitch 成功即写 lastSwitch 台账）
    await runStep(handlers, { text: '今天天气怎么样', sid, turn: 1 });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].provider, 'zai-coding-cn');
    // 2) 宿主把本次切换落成 durable 投影（与台账一致）
    proj.pending = { provider: 'zai-coding-cn', model: 'glm-5.3-flash', reasoningEffort: 'light' };
    // 3) 状态机保持 chat 态 → 来源判定应放行（不报 user-manual），目标注解保留
    await runStep(handlers, { text: '帮我装插件', sid, turn: 2 });
    await new Promise((r) => setTimeout(r, 50));
    const decision = (await readLines()).find((l) => l.tool === 'agent/pre-step/decision' && l.sid === sid && l.turn === 2);
    assert.ok(decision, 'decision line must exist');
    assert.ok(decision.target, 'ledger-matched state must not be treated as manual keep');
    assert.notEqual(decision.keepReason, 'user-manual-selection-kept');
  });
});

// 来源判定反例：台账存在但 durable 态是外来值（用户改过）→ 仍绝对优先保持
// v0.5.3：此用例守"关闭纠偏"语义（reclaimUnknownModel:false）；默认开启时未知外来值会被纠偏。
await t('foreign selection kept even when ledger exists', async () => {
  const { ctx, handlers, calls } = makeCtx();
  const proj = { pending: null };
  ctx.sessionProjections = { stateOf: () => ({ lastUsed: null, pending: proj.pending }) };
  apply(ctx, { reclaimUnknownModel: false });
  const sid = 'session-ledger-foreign';
  await withTmpLog(async (readLines) => {
    await runStep(handlers, { text: '今天天气怎么样', sid, turn: 1 });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 1); // 台账已写（路由自有 chat 切换）
    proj.pending = { provider: 'our-free-model', model: 'muse-spark-1.3-contributor-free', reasoningEffort: 'deep' };
    await runStep(handlers, { text: '帮我装插件', sid, turn: 2 });
    await new Promise((r) => setTimeout(r, 50));
    const decision = (await readLines()).find((l) => l.tool === 'agent/pre-step/decision' && l.sid === sid && l.turn === 2);
    assert.ok(decision, 'decision line must exist');
    assert.equal(decision.keepReason, 'user-manual-selection-kept');
    assert.notEqual(decision.switched, true, 'must not switch');
    assert.equal(calls.length, 1, 'foreign selection must block any switch');
  });
});

// v0.5.2 冷启动跨类放行：台账为空（重启失忆）+ durable 停 work 档 → 闲聊必须真切回 chat
await t('cold-start empty ledger reroutes chat from work lane (not kept)', async () => {
  const { ctx, handlers, calls } = makeCtx();
  ctx.sessionProjections = {
    stateOf: () => ({ lastUsed: null, pending: { provider: 'our-free-model', model: 'muse-spark-1.2-contributor-free', reasoningEffort: 'deep' } }),
  };
  ctx.sessions = { get: () => ({}) };
  apply(ctx, {});
  await withTmpLog(async (readLines) => {
    await runStep(handlers, { text: '你现在的模型是？', sid: 'session-cold-chat' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 1, 'cold-start cross-kind chat must switch, not keep');
    assert.equal(calls[0].provider, 'zai-coding-cn');
    assert.equal(calls[0].model, 'glm-5.3-flash');
    const decision = (await readLines()).find((l) => l.tool === 'agent/pre-step/decision' && l.sid === 'session-cold-chat');
    assert.ok(decision, 'decision line must exist');
    assert.notEqual(decision.keepReason, 'user-manual-selection-kept');
  });
});

// v0.5.2 冷启动跨类放行：台账为空 + durable 停 chat 档 → 工作指令必须真切到 work
await t('cold-start empty ledger reroutes work from chat lane (not kept)', async () => {
  const { ctx, handlers, calls } = makeCtx();
  ctx.sessionProjections = {
    stateOf: () => ({ lastUsed: null, pending: { provider: 'zai-coding-cn', model: 'glm-5.3-flash', reasoningEffort: 'light' } }),
  };
  ctx.sessions = { get: () => ({}) };
  apply(ctx, {});
  await withTmpLog(async (readLines) => {
    await runStep(handlers, { text: '帮我装插件', sid: 'session-cold-work' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 1, 'cold-start cross-kind work must switch, not keep');
    assert.equal(calls[0].provider, 'our-free-model');
    const decision = (await readLines()).find((l) => l.tool === 'agent/pre-step/decision' && l.sid === 'session-cold-work');
    assert.ok(decision, 'decision line must exist');
    assert.equal(decision.route, 'work');
    assert.notEqual(decision.keepReason, 'user-manual-selection-kept');
  });
});

// v0.5.2 冷启动同类保守：台账为空 + durable 已在目标同类档 → 不重复切（保持手动优先纪律）
// v0.5.3：此用例守关闭纠偏时的保守语义（默认开启时 1.2 对 work 路由是未知值会被纠偏）。
await t('cold-start same lane stays kept (not rerouted)', async () => {
  const { ctx, handlers, calls } = makeCtx();
  ctx.sessionProjections = {
    stateOf: () => ({ lastUsed: null, pending: { provider: 'our-free-model', model: 'muse-spark-1.2-contributor-free', reasoningEffort: 'deep' } }),
  };
  ctx.sessions = { get: () => ({}) };
  apply(ctx, { reclaimUnknownModel: false });
  await runStep(handlers, { text: '帮我装插件', sid: 'session-cold-same' });
  await new Promise((r) => setTimeout(r, 50));
  // 工作指令目标同 provider → 同类保持（shouldSwitch 精确同类，或 manual 门保守），绝不真切
  assert.equal(calls.length, 0, 'same-lane cold start must not switch');
});

// ── v0.5.3：未知漂移纠偏（reclaimUnknownModel）──
// 现场复刻：外部/宿主把会话拽到 our-free-model/muse-spark-1.2-contributor-free/balanced
// （非聊天目标、非配置 workModel、台账外来），再发闲聊。

// 纠偏开（默认 true）：必须真切回 chat 目标 glm-5.3-flash
await t('reclaim unknown model=true forces switch back to chat target', async () => {
  const { ctx, handlers, calls } = makeCtx();
  const proj = { pending: null };
  ctx.sessionProjections = { stateOf: () => ({ lastUsed: null, pending: proj.pending }) };
  apply(ctx, {});
  const sid = 'session-reclaim-on';
  await withTmpLog(async (readLines) => {
    // 1) 闲聊建立路由自有台账（lastSwitch）+ chat 状态（状态机下 step2 才路由 chat）
    await runStep(handlers, { text: '今天天气怎么样', sid, turn: 1 });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 1, 'ledger-prime chat switch expected');
    assert.equal(calls[0].provider, 'zai-coding-cn');
    // 2) 外部漂移：durable 投影被拽到未知模型（台账外来）
    proj.pending = { provider: 'our-free-model', model: 'muse-spark-1.2-contributor-free', reasoningEffort: 'balanced' };
    // 3) 时移 61s 绕开 60s 切换节流（本用例只测纠偏门，节流语义另有覆盖）
    const realNow = Date.now;
    Date.now = () => realNow() + 61000;
    try {
      await runStep(handlers, { text: '你现在的模型是？', sid, turn: 2 });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(calls.length, 2, 'reclaim must issue the switch');
      assert.equal(calls[1].provider, 'zai-coding-cn');
      assert.equal(calls[1].model, 'glm-5.3-flash');
      const decision = (await readLines()).find((l) => l.tool === 'agent/pre-step/decision' && l.sid === sid && l.turn === 2);
      assert.ok(decision, 'decision line must exist');
      assert.notEqual(decision.keepReason, 'user-manual-selection-kept');
    } finally {
      Date.now = realNow;
    }
  });
});

// 纠偏关（reclaimUnknownModel=false）：维持保守"不认识就不动"，绝不切换
await t('reclaim unknown model=false keeps conservatively (no switch)', async () => {
  const { ctx, handlers, calls } = makeCtx();
  const proj = { pending: null };
  ctx.sessionProjections = { stateOf: () => ({ lastUsed: null, pending: proj.pending }) };
  apply(ctx, { reclaimUnknownModel: false });
  const sid = 'session-reclaim-off';
  await withTmpLog(async (readLines) => {
    await runStep(handlers, { text: '今天天气怎么样', sid, turn: 1 });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 1, 'ledger-prime chat switch expected');
    proj.pending = { provider: 'our-free-model', model: 'muse-spark-1.2-contributor-free', reasoningEffort: 'balanced' };
    const realNow = Date.now;
    Date.now = () => realNow() + 61000; // 时移证明不切是纠偏门拒绝，而非节流
    try {
      await runStep(handlers, { text: '你现在的模型是？', sid, turn: 2 });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(calls.length, 1, 'reclaim off must not switch');
      const decision = (await readLines()).find((l) => l.tool === 'agent/pre-step/decision' && l.sid === sid && l.turn === 2);
      assert.ok(decision, 'decision line must exist');
      assert.equal(decision.keepReason, 'user-manual-selection-kept');
      assert.notEqual(decision.switched, true, 'must not switch');
    } finally {
      Date.now = realNow;
    }
  });
});

// ── v0.7.1 来源过滤（system-retry-skipped）────────────────────────────────
// bug 复刻：auto-continue 的重试注入把 kind 伪造成 "user"（producer/form 署名真机实测），
// 旧逻辑取到最后一条 user 形消息 → classifyTask 误判 chat → 切回 GLM 中断 Work。
// 新逻辑：末条 user 形消息非真人输入 → 不路由、不切换，落 reason=system-retry-skipped。

// 用例 1：真机形状的 auto-continue 重试通知（kind=user + producer + form=notice）
await t('auto-continue retry notice skipped (system-retry-skipped, no switch)', async () => {
  const fsP = await import('node:fs/promises');
  const osP = await import('node:os');
  const pathP = await import('node:path');
  const home = await fsP.mkdtemp(pathP.join(osP.tmpdir(), 'router-srcfilter-'));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const { ctx, handlers, calls } = makeCtx();
    apply(ctx, { enableDynamicRanking: false });
    const h = handlers['agent/pre-step'];
    assert.equal(typeof h, 'function', 'pre-step hook must be registered');
    const sid = 'session-srcfilter-notice';
    let nextCalled = 0;
    const payload = {
      agent: { session: sid, source: { channel: 'main' } },
      turn: 25, step: 1,
      messages: [
        { role: 'user', content: [{ type: 'text', text: '帮我建个 test.txt' }], source: { kind: 'user', rpcId: 'x-human-1' } },
        {
          role: 'user',
          content: [{ type: 'text', text: '继续：muse-spark-1.3-contributor-free 模型运行失败，14 秒后自动重试（1/1）' }],
          source: { kind: 'user', producer: 'dsh-auto-continue', form: 'notice', summary: '继续' },
        },
      ],
    };
    await h(payload, async () => { nextCalled += 1; return 'ALLOWED'; });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(nextCalled, 1, 'step must pass through');
    assert.equal(calls.length, 0, 'system retry notice must not trigger any model switch');
    const log = await fsP.readFile(pathP.join(home, 'logs', 'auto-router.jsonl'), 'utf8');
    const lines = log.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const skip = lines.find((l) => l.tool === 'agent/pre-step/skip');
    assert.ok(skip, 'skip log line must be written');
    assert.equal(skip.reason, 'system-retry-skipped');
    assert.equal(skip.keepReason, 'system-retry-skipped');
    assert.equal(skip.sid, sid);
    assert.ok(String(skip.extractText).includes('模型运行失败'), 'rejected text kept for forensics');
    assert.equal(lines.some((l) => l.tool === 'agent/pre-step/decision'), false, 'no route decision for non-human input');
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
  }
});

// 用例 2：字面口径 —— source.kind !== 'user' 的系统消息（runtime-context 快照形）
await t('non-user kind message skipped (system-retry-skipped, no switch)', async () => {
  const fsP = await import('node:fs/promises');
  const osP = await import('node:os');
  const pathP = await import('node:path');
  const home = await fsP.mkdtemp(pathP.join(osP.tmpdir(), 'router-srcfilter2-'));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const { ctx, handlers, calls } = makeCtx();
    apply(ctx, { enableDynamicRanking: false });
    const h = handlers['agent/pre-step'];
    const sid = 'session-srcfilter-sys';
    let nextCalled = 0;
    await h({
      agent: { session: sid, source: {} },
      turn: 7, step: 1,
      messages: [
        { role: 'user', content: '今天天气怎么样', source: { kind: 'runtime-context', form: 'snapshot' } },
      ],
    }, async () => { nextCalled += 1; return 'ALLOWED'; });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(nextCalled, 1, 'step must pass through');
    assert.equal(calls.length, 0, 'non-user kind must not trigger routing/switch');
    const log = await fsP.readFile(pathP.join(home, 'logs', 'auto-router.jsonl'), 'utf8');
    const lines = log.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const skip = lines.find((l) => l.tool === 'agent/pre-step/skip');
    assert.ok(skip, 'skip log line must be written');
    assert.equal(skip.reason, 'system-retry-skipped');
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
  }
});

// 用例 3：真人消息（kind=user + rpcId，真机 QQ 形状）→ 正常触发路由并真切 chat
await t('human message routes normally (kind=user, switch issued)', async () => {
  const fsP = await import('node:fs/promises');
  const osP = await import('node:os');
  const pathP = await import('node:path');
  const home = await fsP.mkdtemp(pathP.join(osP.tmpdir(), 'router-srcfilter3-'));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const { ctx, handlers, calls } = makeCtx();
    apply(ctx, { enableDynamicRanking: false });
    const h = handlers['agent/pre-step'];
    const sid = 'session-srcfilter-human';
    let nextCalled = 0;
    await h({
      agent: { session: sid, source: { channel: 'qq' } },
      turn: 3, step: 1,
      messages: [
        { role: 'user', content: [{ type: 'text', text: '今天天气怎么样' }], source: { kind: 'user', rpcId: 'qq-abc-123', clientTimeZone: 'Asia/Shanghai' } },
      ],
    }, async () => { nextCalled += 1; return 'ALLOWED'; });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(nextCalled, 1, 'step must pass through');
    assert.equal(calls.length, 1, 'human chat message must trigger the chat switch');
    assert.equal(calls[0].provider, 'zai-coding-cn');
    assert.equal(calls[0].model, 'glm-5.3-flash');
    const log = await fsP.readFile(pathP.join(home, 'logs', 'auto-router.jsonl'), 'utf8');
    const lines = log.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const decision = lines.find((l) => l.tool === 'agent/pre-step/decision');
    assert.ok(decision, 'decision log must exist for human input');
    assert.equal(decision.task, 'chat');
    assert.equal(decision.route, 'chat');
    assert.equal(lines.some((l) => l.tool === 'agent/pre-step/skip'), false, 'human input must not be skipped');
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
  }
});

// ── v0.7.2 阶段三：JSONL mode/chatTurns 真值 + 升档 mode-changed 事件 ──
// pre-step 首轮预判落 mode=chat；pre-execute 真实工具调用升档 → mode-changed 事件 + pre-execute 行 mode=work。
await t('JSONL mode/chatTurns + mode-changed event on upgrade (stage-3)', async () => {
  await withTmpLog(async (readLines) => {
    const { ctx, handlers } = makeCtx();
    apply(ctx, { enableDynamicRanking: false });
    const sid = 'session-stage3-log';
    // 1) pre-step 首条真人消息：无关键词 → 首轮预判落 chat
    await runStep(handlers, { text: '今天天气怎么样', sid, meta: { channel: 'main' }, turn: 1 });
    await new Promise((r) => setTimeout(r, 80));
    let lines = await readLines();
    const preStep = lines.find((l) => l.tool === 'agent/pre-step' && l.sid === sid);
    const decision = lines.find((l) => l.tool === 'agent/pre-step/decision' && l.sid === sid);
    assert.ok(preStep, 'pre-step line exists');
    assert.ok(decision, 'decision line exists');
    for (const [name, line] of [['pre-step', preStep], ['decision', decision]]) {
      assert.ok(Object.hasOwn(line, 'mode'), name + ' must carry mode field');
      assert.ok(Object.hasOwn(line, 'chatTurns'), name + ' must carry chatTurns field');
    }
    assert.equal(preStep.mode, 'chat', 'first round stateless chat predict must be recorded');
    assert.equal(preStep.chatTurns, 0);
    assert.equal(decision.mode, 'chat');
    // 2) 真实工具调用（write）→ pre-execute 升档：mode-changed 事件 + 行内 mode=work
    await runPre(handlers, { name: 'write', args: { file_path: 'x.txt', content: 'hi' }, agent: { session: sid } });
    await new Promise((r) => setTimeout(r, 80));
    lines = await readLines();
    const ev = lines.find((l) => l.tool === 'auto-model-router/mode-changed' && l.sid === sid);
    assert.ok(ev, 'mode-changed event must fire on tool upgrade');
    assert.equal(ev.prevMode, 'chat', 'upgrade from chat');
    assert.equal(ev.mode, 'work');
    assert.equal(ev.chatTurns, 0, 'upgrade resets chatTurns');
    const preExec = lines.find((l) => l.sid === sid && l.tool === 'write');
    assert.ok(preExec, 'pre-execute line exists');
    assert.ok(Object.hasOwn(preExec, 'mode'), 'pre-execute must carry mode field');
    assert.ok(Object.hasOwn(preExec, 'chatTurns'), 'pre-execute must carry chatTurns field');
    assert.equal(preExec.mode, 'work', 'state upgraded before the entry was written');
    assert.equal(preExec.chatTurns, 0);
    // 3) 档位已 work：下一轮 pre-step 读出的状态必须是 work（状态机输入）
    await runStep(handlers, { text: '继续刚才的活', sid, turn: 2 });
    await new Promise((r) => setTimeout(r, 50));
    lines = await readLines();
    const step2 = lines.find((l) => l.tool === 'agent/pre-step' && l.sid === sid && l.turn === 2);
    assert.ok(step2, 'second pre-step line exists');
    assert.equal(step2.mode, 'work', 'state persisted across turns');
  });
});

// ── v0.7.5 Step4：行为分支门控 ──────────────────────────────────────────────

// 分支一：enabled=false 总开关 ⇒ 只记日志不切换模型（decision 行 carry keepReason=enabled-off）
await t('v0.7.5 enabled=false logs only, never switches', async () => {
  await withTmpLog(async (readLines) => {
    const { ctx, handlers, calls } = makeCtx();
    apply(ctx, { enabled: false });
    await runStep(handlers, { text: '帮我装插件', sid: 'session-disabled', meta: {} });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 0, 'disabled plugin must not switch any model');
    const decision = (await readLines()).find((l) => l.tool === 'agent/pre-step/decision' && l.sid === 'session-disabled');
    assert.ok(decision, 'decision line must still be written (log-only mode)');
    assert.equal(decision.keepReason, 'enabled-off');
    assert.notEqual(decision.switched, true, 'must not switch');
    assert.ok(Object.hasOwn(decision, 'branch'), 'decision must carry branch field');
  });
});

// 分支二：priorityMode=auto ⇒ 路由规则压过"user-manual-selection-kept"（保守理由仍不放行）
await t('v0.7.5 priorityMode=auto overrides manual keep (routing wins)', async () => {
  await withTmpLog(async (readLines) => {
    const { ctx, handlers, calls } = makeCtx();
    ctx.sessionProjections = {
      stateOf: () => ({ lastUsed: null, pending: { provider: 'our-free-model', model: 'muse-spark-1.3-contributor-free', reasoningEffort: 'deep' } }),
    };
    ctx.sessions = { get: () => ({}) };
    apply(ctx, { reclaimUnknownModel: false, priorityMode: 'auto' });
    await runStep(handlers, { text: '帮我装插件', sid: 'session-pmode-auto', meta: {} });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 1, 'auto priority must let routing override the manual keep');
    const decision = (await readLines()).find((l) => l.tool === 'agent/pre-step/decision' && l.sid === 'session-pmode-auto');
    assert.ok(decision, 'decision line must exist');
    assert.notEqual(decision.keepReason, 'user-manual-selection-kept');
    assert.equal(decision.switched, true, 'routing must actually switch');
  });
});

// 分支二对照：priorityMode=manual（默认语义显式声明）⇒ 手动保持原样生效
await t('v0.7.5 priorityMode=manual keeps manual selection', async () => {
  await withTmpLog(async (readLines) => {
    const { ctx, handlers, calls } = makeCtx();
    ctx.sessionProjections = {
      stateOf: () => ({ lastUsed: null, pending: { provider: 'our-free-model', model: 'muse-spark-1.3-contributor-free', reasoningEffort: 'deep' } }),
    };
    ctx.sessions = { get: () => ({}) };
    apply(ctx, { reclaimUnknownModel: false, priorityMode: 'manual' });
    await runStep(handlers, { text: '帮我装插件', sid: 'session-pmode-manual', meta: {} });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 0, 'manual priority must block the switch');
    const decision = (await readLines()).find((l) => l.tool === 'agent/pre-step/decision' && l.sid === 'session-pmode-manual');
    assert.ok(decision, 'decision line must exist');
    assert.equal(decision.keepReason, 'user-manual-selection-kept');
  });
});

// 分支三：enableGroupHint=false（默认）不弹；true 弹一次，第二轮进冷却不再弹
await t('v0.7.5 enableGroupHint gate: off = silent, on = hint once with cooldown', async () => {
  const groupProj = () => ({
    stateOf: () => ({ lastUsed: null, pending: { provider: 'our-free-model', model: 'mimo-v2.6-flash-free', reasoningEffort: 'light' } }),
  });
  // 关（默认语义）：全程 0 条 group hint 日志
  await withTmpLog(async () => {
    const { ctx, handlers } = makeCtx();
    const logs = [];
    ctx.logger = () => ({ info: (m) => logs.push(String(m)), warn: () => {}, error: () => {} });
    ctx.sessionProjections = groupProj();
    ctx.sessions = { get: () => ({}) };
    apply(ctx, { enableGroupHint: false, enableDynamicRanking: false });
    await runStep(handlers, { text: '哈哈哈', sid: 'session-hint-off', meta: { channel: 'qq', chatType: 'group' }, turn: 1 });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(logs.filter((m) => m.includes('group hint for session')).length, 0, 'disabled hint must stay silent');
  });
  // 开：第一轮弹 1 条，第二轮冷却内不再弹
  await withTmpLog(async () => {
    const { ctx, handlers } = makeCtx();
    const logs = [];
    ctx.logger = () => ({ info: (m) => logs.push(String(m)), warn: () => {}, error: () => {} });
    ctx.sessionProjections = groupProj();
    ctx.sessions = { get: () => ({}) };
    apply(ctx, { enableGroupHint: true, enableDynamicRanking: false });
    const hintCount = () => logs.filter((m) => m.includes('group hint for session')).length;
    await runStep(handlers, { text: '哈哈哈', sid: 'session-hint-on', meta: { channel: 'qq', chatType: 'group' }, turn: 1 });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(hintCount(), 1, 'enabled hint must fire exactly once');
    await runStep(handlers, { text: '在吗', sid: 'session-hint-on', meta: { channel: 'qq', chatType: 'group' }, turn: 2 });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(hintCount(), 1, 'second round must be inside cooldown');
  });
});

// 分支四 chat：chatMode=manual ⇒ 固定 manualChatModel（prov/mod 拆开），branch=chat-manual-locked
await t('v0.7.5 chatMode=manual pins manualChatModel', async () => {
  await withTmpLog(async (readLines) => {
    const { ctx, handlers, calls } = makeCtx();
    apply(ctx, { chatMode: 'manual', manualChatModel: 'my-api/glm-x' });
    await runStep(handlers, { text: '你好', sid: 'session-chatmanual', meta: { channel: 'weixin' } });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].provider, 'my-api');
    assert.equal(calls[0].model, 'glm-x');
    const decision = (await readLines()).find((l) => l.tool === 'agent/pre-step/decision' && l.sid === 'session-chatmanual');
    assert.ok(decision, 'decision line must exist');
    assert.equal(decision.branch, 'chat-manual-locked');
  });
});

// 分支四 chat：chatMode=auto ⇒ 忽略 manualChatModel，走 chatModelPriority 链头，branch=chat-auto-chain
await t('v0.7.5 chatMode=auto ignores manualChatModel (priority chain head)', async () => {
  await withTmpLog(async (readLines) => {
    const { ctx, handlers, calls } = makeCtx();
    apply(ctx, { chatMode: 'auto', manualChatModel: 'my-api/glm-x' });
    await runStep(handlers, { text: '你好', sid: 'session-chatauto', meta: { channel: 'weixin' } });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].provider, 'zai-coding-cn');
    assert.equal(calls[0].model, 'glm-5.3-flash');
    const decision = (await readLines()).find((l) => l.tool === 'agent/pre-step/decision' && l.sid === 'session-chatauto');
    assert.ok(decision, 'decision line must exist');
    assert.equal(decision.branch, 'chat-auto-chain');
  });
});

// 分支四 work：workMode=manual ⇒ 固定 manualWorkModel，branch=work-manual-locked（新字段路径，非 legacy 键）
await t('v0.7.5 workMode=manual pins manualWorkModel', async () => {
  await withTmpLog(async (readLines) => {
    const { ctx, handlers, calls } = makeCtx();
    apply(ctx, { workMode: 'manual', manualWorkModel: 'our-free-model/muse-spark-1.3-contributor-free' });
    await runStep(handlers, { text: '帮我装插件', sid: 'session-workmanual', meta: {} });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'muse-spark-1.3-contributor-free');
    const decision = (await readLines()).find((l) => l.tool === 'agent/pre-step/decision' && l.sid === 'session-workmanual');
    assert.ok(decision, 'decision line must exist');
    assert.equal(decision.branch, 'work-manual-locked');
  });
});

// 分支四 work：workMode=auto ⇒ 忽略 manualWorkModel，走静态链/回退（动态榜关=确定性），branch=work-auto-chain
await t('v0.7.5 workMode=auto ignores manualWorkModel (chain/fallback)', async () => {
  await withTmpLog(async (readLines) => {
    const { ctx, handlers, calls } = makeCtx();
    apply(ctx, { workMode: 'auto', manualWorkModel: 'our-free-model/muse-spark-1.3-contributor-free', enableDynamicRanking: false });
    await runStep(handlers, { text: '帮我装插件', sid: 'session-workauto', meta: {} });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 1);
    assert.notEqual(calls[0].model, 'muse-spark-1.3-contributor-free', 'auto mode must not honour the manual value');
    assert.equal(calls[0].model, 'mimo-v2.6-flash-free', 'chain/fallback value expected');
    const decision = (await readLines()).find((l) => l.tool === 'agent/pre-step/decision' && l.sid === 'session-workauto');
    assert.ok(decision, 'decision line must exist');
    assert.equal(decision.branch, 'work-auto-chain');
  });
});

console.log('crash tests done');
