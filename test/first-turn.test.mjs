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

const runStep = (handlers, { text, sid, meta = { channel: 'qq' }, turn = 1 }) =>
  handlers['agent/pre-step']({
    agent: { session: sid, source: meta },
    turn, step: 1,
    messages: [{ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'x-human-1' } }],
  }, async () => ({ kind: 'allow' }));

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

console.log('first-turn tests done');
