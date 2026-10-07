import { apply } from './src/index.js';

const handlers = {};
const ctx = {
  llm: {},
  get(name) { if (name === 'userQuestions') return { async ask() { throw Object.assign(new Error('x'), { code: 'NO_PROVIDER' }); } }; return null; },
  sessionController: { async selectModel() { return {}; } },
  agentDefaultModel: { _saved: [], currentSelection() { return { provider: 'p', model: 'm' }; }, async saveSelection(n) { this._saved.push(n); } },
  sessionProjections: { stateOf: () => ({ lastUsed: null, pending: null }) },
  sessions: { get: (id) => ({ id, requestHeader: () => undefined }) },
  logger: (n) => ({ info(m) { console.log('INFO', m); }, warn(m) { console.log('WARN', m); }, error(m) { console.log('ERR', m); } }),
  effect(fn) { try { const g = fn(); if (g && typeof g.next === 'function') g.next(); } catch (e) { console.log('EFFECT ERR', e); } },
  on(evt, handler) { handlers[evt] = handler; return () => { delete handlers[evt]; }; },
};
apply(ctx, { enableDynamicRanking: false });
console.log('handlers:', Object.keys(handlers));
const r = await handlers['agent/pre-step']({
  agent: { session: 's1', source: { channel: 'qq' } },
  turn: 1, step: 1,
  messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user', rpcId: 'x' } }],
}, async () => ({ kind: 'allow' }));
console.log('done', JSON.stringify(r));
