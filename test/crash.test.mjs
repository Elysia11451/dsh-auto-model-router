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

// 真切：IM 闲聊切 chat 档，sessionId 直传 + effort 归一化
// 注意：拦截后 adm.saveSelection 是 report-only，写回断言改为"真实写入 0 次"
await t('real switch passes sessionId through with normalized effort', async () => {
  const { ctx, handlers, calls } = makeCtx();
  apply(ctx, {});
  const exec = { args: '今天天气怎么样', agent: { session: 'session-aaa', source: { channel: 'weixin' } } };
  await runPre(handlers, exec);
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
  const exec = { args: 'hi', agent: { session: 'session-ccc', source: { channel: 'qq' } } };
  await runPre(handlers, exec);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].reasoningEffort, undefined);
});

// 真切失败降级：controller 抛错也放行，不阻断
await t('switch failure still passes through', async () => {
  const { ctx, handlers } = makeCtx({ selectImpl: async () => { throw new Error('controller down'); } });
  apply(ctx, {});
  const exec = { args: 'hi', agent: { session: 'session-ddd', source: { channel: 'qq' } } };
  const res = await runPre(handlers, exec);
  assert.equal(res?.kind, 'allow');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(exec.autoModelRouter?.switched, false);
});

// 节流：同一会话 60s 内不重复切
await t('same-session switch throttled', async () => {
  const { ctx, handlers, calls } = makeCtx();
  apply(ctx, {});
  for (let i = 0; i < 3; i++) {
    await runPre(handlers, { args: 'hi', agent: { session: 'session-eee', source: { channel: 'qq' } } });
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 1);
});

// 精确同类：投影恰为当前动态目标（回退值 mimo）-> 工作指令不重复切
await t('exact same model kept, not re-switched', async () => {
  const { ctx, handlers, calls } = makeCtx();
  // 伪造投影：当前已是动态目标 mimo（精确同类）
  ctx.sessionProjections = {
    stateOf: () => ({ pending: { provider: 'our-free-model', model: 'mimo-v2.6-flash-free', reasoningEffort: 'deep' } }),
  };
  ctx.sessions = { get: () => ({}) };
  apply(ctx, {});
  const exec = { args: '帮我装插件', agent: { session: 'session-manual', source: {} } };
  const res = await runPre(handlers, exec);
  assert.equal(res?.kind, 'allow');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 0, 'exact same-kind must not call selectModel');
  assert.equal(exec.autoModelRouter?.target, null);
  assert.match(exec.autoModelRouter?.kept ?? '', /our-free-model/);
});

// v0.5.1 语义改写：手动 1.3 在位（durable pending）+ 工作指令目标动态最强 -> 绝不覆盖
await t('durable manual selection never overridden (cross-model)', async () => {
  const { ctx, handlers, calls } = makeCtx();
  ctx.sessionProjections = {
    stateOf: () => ({ lastUsed: null, pending: { provider: 'our-free-model', model: 'muse-spark-1.3-contributor-free', reasoningEffort: 'deep' } }),
  };
  ctx.sessions = { get: () => ({}) };
  apply(ctx, { reclaimUnknownModel: false }); // v0.5.3：守关闭纠偏时的手动优先（默认开启时未知1.3会被纠偏）
  const exec = { args: '帮我装插件', agent: { session: 'session-crossmodel', source: {} } };
  const res = await runPre(handlers, exec);
  assert.equal(res?.kind, 'allow');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 0, 'durable selection must block any switch');
  assert.equal(exec.autoModelRouter?.target, null);
  assert.equal(exec.autoModelRouter?.keepReason, 'user-manual-selection-kept');
});

// v0.5.2 语义更新：台账为空 + durable 停 chat 档 + 工作指令 → 跨类放行（不再保持）。
// 原“durable chat kept”断言已过时（v0.5.1 语义），由“cold-start same lane”承接保守语义。
await t('durable chat selection rerouted under work command when ledger empty (cross-type, v0.5.2)', async () => {
  const { ctx, handlers, calls } = makeCtx();
  ctx.sessionProjections = {
    stateOf: () => ({ lastUsed: null, pending: { provider: 'zai-coding-cn', model: 'glm-5.3-flash', reasoningEffort: 'light' } }),
  };
  ctx.sessions = { get: () => ({}) };
  apply(ctx, {});
  const exec = { args: '帮我装插件', agent: { session: 'session-cross', source: {} } };
  await runPre(handlers, exec);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 1, 'cold-start cross-kind work must reroute from chat lane');
  assert.equal(calls[0].provider, 'our-free-model');
  assert.notEqual(exec.autoModelRouter?.keepReason, 'user-manual-selection-kept');
});

// 同类 chat 保持：投影已在 chat 档 -> 闲聊不重复切
await t('same-kind chat kept', async () => {
  const { ctx, handlers, calls } = makeCtx();
  ctx.sessionProjections = {
    stateOf: () => ({ pending: { provider: 'zai-coding-cn', model: 'glm-5.3-flash', reasoningEffort: 'light' } }),
  };
  ctx.sessions = { get: () => ({}) };
  apply(ctx, {});
  const exec = { args: '今天天气怎么样', agent: { session: 'session-chatkeep', source: { channel: 'weixin' } } };
  await runPre(handlers, exec);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 0, 'already on chat must not re-switch');
  assert.match(exec.autoModelRouter?.kept ?? '', /zai-coding-cn/);
});

// ── v0.5.0 新增 ──

// chatModel 为空（Config 描述承诺的回退）：真切必须落到 workProvider/workModelFallback，绝不传空 model
await t('empty chatModel falls back to work fallback on real switch', async () => {
  const { ctx, handlers, calls } = makeCtx();
  apply(ctx, { chatModel: '' });
  const exec = { args: '今天天气怎么样', agent: { session: 'session-emptychat', source: { channel: 'weixin' } } };
  await runPre(handlers, exec);
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
  const exec = { args: '你好', agent: { session: 'session-provmod', source: { channel: 'qq' } } };
  await runPre(handlers, exec);
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
    const exec = { args: '帮我装插件', agent: { session: 'session-dynoff', source: {} } };
    await runPre(handlers, exec);
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
  const { ctx, handlers, calls } = makeCtx();
  ctx.sessionProjections = { stateOf: () => ({ lastUsed: null, pending: null }) };
  ctx.sessions = { get: () => ({ requestHeader: () => ({ config: { provider: 'our-free-model', model: 'muse-spark-1.3-contributor-free', reasoningEffort: 'deep' } }) }) };
  apply(ctx, { reclaimUnknownModel: false });
  const exec = { args: '帮我装插件', agent: { session: 'session-hdr', source: {} } };
  await runPre(handlers, exec);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 0, 'durable header must block any switch');
  assert.equal(exec.autoModelRouter?.target, null);
  assert.equal(exec.autoModelRouter?.keepReason, 'user-manual-selection-kept');
});

// 状态读不出（sessions.get 返回 null）=> 保守保留，绝不赌手动选择
await t('unreadable selection state keeps conservatively', async () => {
  const { ctx, handlers, calls } = makeCtx();
  ctx.sessions = { get: () => null };
  apply(ctx, {});
  const exec = { args: '帮我装插件', agent: { session: 'session-unreadable', source: {} } };
  await runPre(handlers, exec);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 0, 'unknown state must not switch');
  assert.equal(exec.autoModelRouter?.keepReason, 'selection-state-unreadable');
});

// 功能二：锁开 -> 工作真切落手动 pair（故意 ≠ 回退值，证明压过动态/回退）
await t('manual work-model lock forces manual target', async () => {
  const { ctx, handlers, calls } = makeCtx();
  apply(ctx, { manualWorkModelLocked: true, manualWorkModel: 'our-free-model/muse-spark-1.3-contributor-free' });
  const exec = { args: '帮我装插件', agent: { session: 'session-lockon', source: {} } };
  await runPre(handlers, exec);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'our-free-model');
  assert.equal(calls[0].model, 'muse-spark-1.3-contributor-free');
  assert.equal(exec.autoModelRouter?.target?.model, 'muse-spark-1.3-contributor-free');
});

// 功能二：锁关（配了值也不生效）-> 走动态/回退
await t('manual lock disabled falls back to dynamic/fallback', async () => {
  const { ctx, handlers, calls } = makeCtx();
  apply(ctx, { manualWorkModelLocked: false, manualWorkModel: 'our-free-model/muse-spark-1.3-contributor-free' });
  const exec = { args: '帮我装插件', agent: { session: 'session-lockoff', source: {} } };
  await runPre(handlers, exec);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'mimo-v2.6-flash-free', 'disabled lock must use dynamic/fallback, not manual value');
});

// 功能二：锁开但值为空 -> 不构成锁（规格：manualWorkModel 默认空即回退动态）
await t('lock enabled with empty manualWorkModel is inert', async () => {
  const { ctx, handlers, calls } = makeCtx();
  apply(ctx, { manualWorkModelLocked: true, manualWorkModel: '' });
  const exec = { args: '帮我装插件', agent: { session: 'session-lockempty', source: {} } };
  await runPre(handlers, exec);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'mimo-v2.6-flash-free', 'empty manual value must fall back to dynamic/fallback');
});

// v0.5.1 来源判定（lastSwitch 台账）：路由自己切出的 durable 态 → 允许继续四象限路由
await t('router-made selection allows re-routing (ledger match)', async () => {
  const { ctx, handlers, calls } = makeCtx();
  const proj = { pending: null };
  ctx.sessionProjections = { stateOf: () => ({ lastUsed: null, pending: proj.pending }) };
  apply(ctx, {});
  const sid = 'session-ledger-match';
  // 1) 全新会话闲聊 → 切 chat 成功（realSwitch 成功即写 lastSwitch 台账）
  await runPre(handlers, { args: '今天天气怎么样', agent: { session: sid, source: { channel: 'qq' } } });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'zai-coding-cn');
  // 2) 宿主把本次切换落成 durable 投影（与台账一致）
  proj.pending = { provider: 'zai-coding-cn', model: 'glm-5.3-flash', reasoningEffort: 'light' };
  // 3) 工作指令 → 来源判定应放行（不报 user-manual），目标注解保留
  const exec3 = { args: '帮我装插件', agent: { session: sid, source: { channel: 'qq' } } };
  await runPre(handlers, exec3);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(exec3.autoModelRouter?.target, 'ledger-matched state must not be treated as manual keep');
  assert.notEqual(exec3.autoModelRouter?.keepReason, 'user-manual-selection-kept');
});

// 来源判定反例：台账存在但 durable 态是外来值（用户改过）→ 仍绝对优先保持
// v0.5.3：此用例守"关闭纠偏"语义（reclaimUnknownModel:false）；默认开启时未知外来值会被纠偏。
await t('foreign selection kept even when ledger exists', async () => {
  const { ctx, handlers, calls } = makeCtx();
  const proj = { pending: null };
  ctx.sessionProjections = { stateOf: () => ({ lastUsed: null, pending: proj.pending }) };
  apply(ctx, { reclaimUnknownModel: false });
  const sid = 'session-ledger-foreign';
  await runPre(handlers, { args: '今天天气怎么样', agent: { session: sid, source: { channel: 'qq' } } });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 1); // 台账已写（路由自有 chat 切换）
  proj.pending = { provider: 'our-free-model', model: 'muse-spark-1.3-contributor-free', reasoningEffort: 'deep' };
  const exec3 = { args: '帮我装插件', agent: { session: sid, source: { channel: 'qq' } } };
  await runPre(handlers, exec3);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(exec3.autoModelRouter?.keepReason, 'user-manual-selection-kept');
  assert.equal(exec3.autoModelRouter?.target, null);
  assert.equal(calls.length, 1, 'foreign selection must block any switch');
});

// v0.5.2 冷启动跨类放行：台账为空（重启失忆）+ durable 停 work 档 → 闲聊必须真切回 chat
await t('cold-start empty ledger reroutes chat from work lane (not kept)', async () => {
  const { ctx, handlers, calls } = makeCtx();
  ctx.sessionProjections = {
    stateOf: () => ({ lastUsed: null, pending: { provider: 'our-free-model', model: 'muse-spark-1.2-contributor-free', reasoningEffort: 'deep' } }),
  };
  ctx.sessions = { get: () => ({}) };
  apply(ctx, {});
  const exec = { args: '你现在的模型是？', agent: { session: 'session-cold-chat', source: { channel: 'qq' } } };
  await runPre(handlers, exec);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 1, 'cold-start cross-kind chat must switch, not keep');
  assert.equal(calls[0].provider, 'zai-coding-cn');
  assert.equal(calls[0].model, 'glm-5.3-flash');
  assert.notEqual(exec.autoModelRouter?.keepReason, 'user-manual-selection-kept');
});

// v0.5.2 冷启动跨类放行：台账为空 + durable 停 chat 档 → 工作指令必须真切到 work
await t('cold-start empty ledger reroutes work from chat lane (not kept)', async () => {
  const { ctx, handlers, calls } = makeCtx();
  ctx.sessionProjections = {
    stateOf: () => ({ lastUsed: null, pending: { provider: 'zai-coding-cn', model: 'glm-5.3-flash', reasoningEffort: 'light' } }),
  };
  ctx.sessions = { get: () => ({}) };
  apply(ctx, {});
  const exec = { args: '帮我装插件', agent: { session: 'session-cold-work', source: { channel: 'qq' } } };
  await runPre(handlers, exec);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 1, 'cold-start cross-kind work must switch, not keep');
  assert.equal(calls[0].provider, 'our-free-model');
  assert.equal(exec.autoModelRouter?.route, 'work');
  assert.notEqual(exec.autoModelRouter?.keepReason, 'user-manual-selection-kept');
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
  const exec = { args: '帮我装插件', agent: { session: 'session-cold-same', source: { channel: 'qq' } } };
  await runPre(handlers, exec);
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
  // 1) 工作指令建立路由自有台账（lastSwitch）
  await runPre(handlers, { args: '帮我装插件', agent: { session: sid, source: { channel: 'qq' } } });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 1, 'ledger-prime work switch expected');
  // 2) 外部漂移：durable 投影被拽到未知模型（台账外来）
  proj.pending = { provider: 'our-free-model', model: 'muse-spark-1.2-contributor-free', reasoningEffort: 'balanced' };
  // 3) 时移 61s 绕开 60s 切换节流（本用例只测纠偏门，节流语义另有覆盖）
  const realNow = Date.now;
  Date.now = () => realNow() + 61000;
  try {
    const exec = { args: '你现在的模型是？', agent: { session: sid, source: { channel: 'qq' } } };
    await runPre(handlers, exec);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 2, 'reclaim must issue the switch');
    assert.equal(calls[1].provider, 'zai-coding-cn');
    assert.equal(calls[1].model, 'glm-5.3-flash');
    assert.notEqual(exec.autoModelRouter?.keepReason, 'user-manual-selection-kept');
  } finally {
    Date.now = realNow;
  }
});

// 纠偏关（reclaimUnknownModel=false）：维持保守"不认识就不动"，绝不切换
await t('reclaim unknown model=false keeps conservatively (no switch)', async () => {
  const { ctx, handlers, calls } = makeCtx();
  const proj = { pending: null };
  ctx.sessionProjections = { stateOf: () => ({ lastUsed: null, pending: proj.pending }) };
  apply(ctx, { reclaimUnknownModel: false });
  const sid = 'session-reclaim-off';
  await runPre(handlers, { args: '帮我装插件', agent: { session: sid, source: { channel: 'qq' } } });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 1, 'ledger-prime work switch expected');
  proj.pending = { provider: 'our-free-model', model: 'muse-spark-1.2-contributor-free', reasoningEffort: 'balanced' };
  const realNow = Date.now;
  Date.now = () => realNow() + 61000; // 时移证明不切是纠偏门拒绝，而非节流
  try {
    const exec = { args: '你现在的模型是？', agent: { session: sid, source: { channel: 'qq' } } };
    await runPre(handlers, exec);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 1, 'reclaim off must not switch');
    assert.equal(exec.autoModelRouter?.keepReason, 'user-manual-selection-kept');
    assert.equal(exec.autoModelRouter?.target, null);
  } finally {
    Date.now = realNow;
  }
});

console.log('crash tests done');
