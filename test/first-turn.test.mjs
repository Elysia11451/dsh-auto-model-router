import assert from 'node:assert/strict';
import { apply } from '../src/index.js';

// v0.8.0 首轮弹窗 6 用例：mock ctx.get('userQuestions')，走 agent/pre-step 驱动器。
function makeCtxUQ({ askImpl = null, hasProvider = true } = {}) {
  const handlers = {};
  const calls = [];
  let askCalls = 0;
  const uq = hasProvider ? {
    async ask(req) {
      askCalls += 1;
      if (askImpl) return askImpl(req, () => askCalls);
      throw Object.assign(new Error('no impl'), { code: 'NO_PROVIDER' });
    },
  } : null;
  const ctx = {
    llm: {},
    get(name) { if (name === 'userQuestions') return uq; return null; },
    sessionController: {
      async selectModel(payload) { calls.push(payload); return { selected: { ...payload } }; },
    },
    agentDefaultModel: {
      _saved: [],
      currentSelection() { return { provider: 'our-free-model', model: 'muse-spark-1.3-contributor-free', reasoningEffort: 'deep' }; },
      async saveSelection(next) { this._saved.push(next); },
    },
    sessionProjections: { stateOf: () => ({ lastUsed: null, pending: null }) },
    sessions: { get: (id) => ({ id, requestHeader: () => undefined }) },
    logger: () => ({ info() {}, warn() {}, error() {} }),
    effect(fn) { try { const g = fn(); if (g && typeof g.next === 'function') g.next(); } catch {} },
    on(evt, handler) { handlers[evt] = handler; return () => { delete handlers[evt]; }; },
  };
  return { ctx, handlers, calls, askCount: () => askCalls };
}

const runStep = (handlers, { text, sid, meta = {}, turn = 1 }) =>
  handlers['agent/pre-step']({
    agent: { session: sid, source: meta },
    turn, step: 1,
    messages: [{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'x-human-1' } }],
  }, async () => ({ kind: 'allow' }));
// IM 通道专用（v0.8.6.1 起 IM 首轮走关键词同步定档，不经过 ask）
const runStepIM = (handlers, { text, sid, turn = 1 }) =>
  runStep(handlers, { text, sid, meta: { channel: 'qq' }, turn });

const withTmpLog = async (fn) => {
  const fsP = await import('node:fs/promises');
  const osP = await import('node:os');
  const pathP = await import('node:path');
  const home = await fsP.mkdtemp(pathP.join(osP.tmpdir(), 'router-ft-'));
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. 有 provider 答 Work → 异步纠正为 work（第二轮走 work 路由 + mode-changed 事件）
await t('first-turn answers Work -> corrects to work', async () => {
  await withTmpLog(async (readLines) => {
    const m = makeCtxUQ({ askImpl: async () => ({ answers: [{ selected: ['Work 档（能力模式）'] }] }) });
    apply(m.ctx, { enableDynamicRanking: false });
    await runStep(m.handlers, { text: '你好', sid: 'session-ft-work', turn: 1 });
    await sleep(80); // 等 ask().then() 纠正落地
    assert.equal(m.askCount(), 1);
    await runStep(m.handlers, { text: '你好', sid: 'session-ft-work', turn: 2 });
    await sleep(80);
    const lines = await readLines();
    const ev = lines.find((l) => l.tool === 'auto-model-router/mode-changed' && l.sid === 'session-ft-work' && l.keepReason === 'first-turn-prompt');
    assert.ok(ev, 'mode-changed first-turn-prompt event must exist');
    assert.equal(ev.mode, 'work');
    const d2 = lines.find((l) => l.tool === 'agent/pre-step/decision' && l.sid === 'session-ft-work' && l.turn === 2);
    assert.ok(d2, 'turn2 decision must exist');
    assert.equal(d2.route, 'work');
  });
});

// 2. 有 provider 答 Chat → 保持 chat
await t('first-turn answers Chat -> stays chat', async () => {
  await withTmpLog(async (readLines) => {
    const m = makeCtxUQ({ askImpl: async () => ({ answers: [{ selected: ['Chat 档（省钱模式）'] }] }) });
    apply(m.ctx, { enableDynamicRanking: false });
    await runStep(m.handlers, { text: '你好', sid: 'session-ft-chat', turn: 1 });
    await sleep(80);
    assert.equal(m.askCount(), 1);
    await runStep(m.handlers, { text: '你好', sid: 'session-ft-chat', turn: 2 });
    await sleep(50);
    const lines = await readLines();
    const d2 = lines.find((l) => l.tool === 'agent/pre-step/decision' && l.sid === 'session-ft-chat' && l.turn === 2);
    assert.ok(d2, 'turn2 decision must exist');
    assert.equal(d2.route, 'chat');
  });
});

// 3. 无 provider → 不抛，保持 chat
await t('first-turn no provider -> stays chat without throw', async () => {
  await withTmpLog(async (readLines) => {
    const m = makeCtxUQ({ hasProvider: false });
    apply(m.ctx, { enableDynamicRanking: false });
    await runStep(m.handlers, { text: '你好', sid: 'session-ft-nop', turn: 1 });
    await sleep(50);
    await runStep(m.handlers, { text: '你好', sid: 'session-ft-nop', turn: 2 });
    await sleep(50);
    const lines = await readLines();
    const d2 = lines.find((l) => l.tool === 'agent/pre-step/decision' && l.sid === 'session-ft-nop' && l.turn === 2);
    assert.ok(d2, 'turn2 decision must exist');
    assert.equal(d2.route, 'chat');
  });
});

// 4. 超时 reject ASK_TIMED_OUT → 保持 chat
await t('first-turn timeout -> stays chat', async () => {
  await withTmpLog(async (readLines) => {
    const m = makeCtxUQ({ askImpl: async () => { throw Object.assign(new Error('timed out'), { code: 'ASK_TIMED_OUT' }); } });
    apply(m.ctx, { enableDynamicRanking: false });
    await runStep(m.handlers, { text: '你好', sid: 'session-ft-timeout', turn: 1 });
    await sleep(80);
    await runStep(m.handlers, { text: '你好', sid: 'session-ft-timeout', turn: 2 });
    await sleep(50);
    const lines = await readLines();
    const d2 = lines.find((l) => l.tool === 'agent/pre-step/decision' && l.sid === 'session-ft-timeout' && l.turn === 2);
    assert.ok(d2, 'turn2 decision must exist');
    assert.equal(d2.route, 'chat');
  });
});

// 5. 群聊不弹窗
await t('first-turn group -> no prompt, stays chat', async () => {
  await withTmpLog(async (readLines) => {
    const m = makeCtxUQ({ askImpl: async () => ({ answers: [{ selected: ['Work 档（能力模式）'] }] }) });
    apply(m.ctx, { enableDynamicRanking: false });
    await runStep(m.handlers, { text: '你好', sid: 'session-ft-group', meta: { channel: 'qq', chatType: 'group' }, turn: 1 });
    await sleep(80);
    assert.equal(m.askCount(), 0, 'group must not trigger ask');
    const lines = await readLines();
    const d1 = lines.find((l) => l.tool === 'agent/pre-step/decision' && l.sid === 'session-ft-group');
    assert.ok(d1, 'decision must exist');
    assert.equal(d1.route, 'chat');
  });
});

// 6. firstTurnPrompt=false 不弹窗
await t('first-turn disabled -> no prompt, stays chat', async () => {
  await withTmpLog(async (readLines) => {
    const m = makeCtxUQ({ askImpl: async () => ({ answers: [{ selected: ['Work 档（能力模式）'] }] }) });
    apply(m.ctx, { enableDynamicRanking: false, firstTurnPrompt: false });
    await runStep(m.handlers, { text: '你好', sid: 'session-ft-off', turn: 1 });
    await sleep(80);
    assert.equal(m.askCount(), 0, 'disabled must not trigger ask');
    const lines = await readLines();
    const d1 = lines.find((l) => l.tool === 'agent/pre-step/decision' && l.sid === 'session-ft-off');
    assert.ok(d1, 'decision must exist');
    assert.equal(d1.route, 'chat');
  });
});

// 7. v0.8.6 issues NTR 1: ask 已派出答案未回 → 首轮只注解不真切（keepReason=first-turn-pending，不调 selectModel）
await t('v0.8.6 issues NTR 1: first-turn pending -> annotate-only (no switch)', async () => {
  await withTmpLog(async (readLines) => {
    // ask 永不 settle：模拟 IM 桥吞掉后悬挂
    const m = makeCtxUQ({ askImpl: () => new Promise(() => {}) });
    apply(m.ctx, { enableDynamicRanking: false });
    await runStep(m.handlers, { text: '你好', sid: 'session-ft-w1-pending', turn: 1 });
    await sleep(80);
    assert.equal(m.askCount(), 1, 'ask must have been dispatched');
    assert.equal(m.calls.length, 0, 'pending round must not call selectModel');
    const lines = await readLines();
    const d1 = lines.find((l) => l.tool === 'agent/pre-step/decision' && l.sid === 'session-ft-w1-pending');
    assert.ok(d1, 'turn1 decision must exist');
    assert.equal(d1.keepReason, 'first-turn-pending', 'pending round keepReason must be first-turn-pending');
    assert.equal(d1.switched ?? null, null, 'pending round must not switch');
  });
});

// 8. v0.8.6 issues NTR 2: probe + asked 双落盘（sessionReady 诊断二选一）；无 provider 时 settled 落盘
await t('v0.8.6 issues NTR 2: probe/asked jsonl present + no-provider settled', async () => {
  await withTmpLog(async (readLines) => {
    const m = makeCtxUQ({ hasProvider: false });
    apply(m.ctx, { enableDynamicRanking: false });
    await runStep(m.handlers, { text: '今天天气怎么样', sid: 'session-ft-t9b-probe', turn: 1 });
    await sleep(80);
    const lines = await readLines();
    const settled = lines.find((l) => l.tool === 'first-turn/prompt-settled' && l.sid === 'session-ft-t9b-probe');
    assert.ok(settled, 'no-provider must log prompt-settled');
    assert.equal(settled.reason, 'first-turn-no-provider');
    // 有 provider 时 probe + asked 必须落盘
    const m2 = makeCtxUQ({ askImpl: () => new Promise(() => {}) });
    apply(m2.ctx, { enableDynamicRanking: false });
    await runStep(m2.handlers, { text: '你好', sid: 'session-ft-t9b-asked', turn: 1 });
    await sleep(80);
    const lines2 = await readLines();
    const probe = lines2.find((l) => l.tool === 'first-turn/probe' && l.sid === 'session-ft-t9b-asked');
    assert.ok(probe, 'probe line must exist');
    assert.ok('sessionReady' in probe, 'probe must carry sessionReady');
    const asked = lines2.find((l) => l.tool === 'first-turn/prompt-asked' && l.sid === 'session-ft-t9b-asked');
    assert.ok(asked, 'prompt-asked line must exist');
    assert.ok(Number.isFinite(asked.timeoutMs), 'prompt-asked must carry timeoutMs');
  });
});

// 9. v0.8.7 审计 P0-6：IM 首轮干活词 → 按关键词定 work 初始档，不经过 ask（askCalls=0）
//    旧行为（v0.8.6.1 无条件 chat）已废：干活指令首轮被忽略，要等第二轮才纠回。
await t('v0.8.7 P0-6: IM first-turn keyword work -> work mode, no ask', async () => {
  await withTmpLog(async (readLines) => {
    const m = makeCtxUQ({ askImpl: () => new Promise(() => {}) });
    apply(m.ctx, { enableDynamicRanking: false });
    await runStepIM(m.handlers, { text: '帮我查一下日志', sid: 'session-ft-im-work', turn: 1 });
    await sleep(80);
    assert.equal(m.askCount(), 0, 'IM must not trigger ask');
    const lines = await readLines();
    const kw = lines.find((l) => l.tool === 'first-turn/im-keyword' && l.sid === 'session-ft-im-work');
    assert.ok(kw, 'im-keyword line must exist');
    assert.equal(kw.mode, 'work', 'v0.8.7: IM first-turn keyword text must seed work mode');
    assert.equal(kw.reason, 'first-turn-im-keyword-work');
    const d1 = lines.find((l) => l.tool === 'agent/pre-step/decision' && l.sid === 'session-ft-im-work');
    assert.ok(d1, 'turn1 decision must exist');
    assert.equal(d1.route, 'work');
  });
});

// 10. v0.8.7 审计 P0-6 任务指定用例：IM 首轮「帮我写个脚本」→ 断言 mode=work
await t('v0.8.7 P0-6: IM first-turn 帮我写个脚本 -> mode=work', async () => {
  await withTmpLog(async (readLines) => {
    const m = makeCtxUQ({ askImpl: () => new Promise(() => {}) });
    apply(m.ctx, { enableDynamicRanking: false });
    await runStepIM(m.handlers, { text: '帮我写个脚本', sid: 'session-ft-im-script', turn: 1 });
    await sleep(80);
    assert.equal(m.askCount(), 0, 'IM must not trigger ask');
    const lines = await readLines();
    const kw = lines.find((l) => l.tool === 'first-turn/im-keyword' && l.sid === 'session-ft-im-script');
    assert.ok(kw, 'im-keyword line must exist');
    assert.equal(kw.mode, 'work', 'task-specified: 帮我写个脚本 -> mode=work');
  });
});

// 10. v0.8.6.1: IM 首轮闲聊 → 同步 chat，不经过 ask
await t('v0.8.6.1: IM first-turn chat -> sync chat, no ask', async () => {
  await withTmpLog(async (readLines) => {
    const m = makeCtxUQ({ askImpl: () => new Promise(() => {}) });
    apply(m.ctx, { enableDynamicRanking: false });
    await runStepIM(m.handlers, { text: '今天天气怎么样', sid: 'session-ft-im-chat', turn: 1 });
    await sleep(80);
    assert.equal(m.askCount(), 0, 'IM must not trigger ask');
    const lines = await readLines();
    const kw = lines.find((l) => l.tool === 'first-turn/im-keyword' && l.sid === 'session-ft-im-chat');
    assert.ok(kw, 'im-keyword line must exist');
    assert.equal(kw.mode, 'chat');
    const d1 = lines.find((l) => l.tool === 'agent/pre-step/decision' && l.sid === 'session-ft-im-chat');
    assert.ok(d1, 'turn1 decision must exist');
    assert.equal(d1.route, 'chat');
  });
});

console.log('first-turn tests done');
