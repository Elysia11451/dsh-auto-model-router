// ── v0.7.2 阶段二：会话状态存储层离线单测（隔离 = 临时目录，零生产改动）──
// 验证：①模拟升档→侧车文件写入 ②模拟冷启动→Map 从侧车恢复 ③mode-changed 事件语义
//       ④无侧车/损坏侧车冷启动默认 chat ⑤有界 >500 清最旧 ⑥非法 sid / peek 同步读
import assert from 'node:assert/strict';
import { createSessionModeStore, SESSION_MODE_CAP, SESSION_MODE_SIDECAR, MODE_CHANGED_EVENT } from '../src/routing-policy/impl/session-mode.js';

const fsP = await import('node:fs/promises');
const osP = await import('node:os');
const pathP = await import('node:path');

const t = async (n, fn) => { try { await fn(); console.log('ok - ' + n); } catch (e) { console.error('FAIL - ' + n + ': ' + e.message); process.exitCode = 1; } };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
// 轮询等待 fire-and-forget 落盘（set 后 save 是异步的）
async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await tick(20); }
  return false;
}
const mkHome = async (pfx) => fsP.mkdtemp(pathP.join(osP.tmpdir(), pfx));

// ① 模拟升档 → 侧车文件写入成功（fire-and-forget 最终落盘）
await t('set work writes sidecar (upgrade -> persist)', async () => {
  const home = await mkHome('sm-write-');
  const store = createSessionModeStore({ homeDir: home });
  const entry = store.set('session-a', { mode: 'work', chatTurns: 0, reason: 'tool-call' });
  assert.equal(entry.mode, 'work');
  const p = pathP.join(home, 'plugin-state', SESSION_MODE_SIDECAR);
  assert.ok(await waitFor(() => fsP.access(p).then(() => true, () => false)), 'sidecar file must appear');
  const raw = JSON.parse(await fsP.readFile(p, 'utf8'));
  assert.equal(raw['session-a'].mode, 'work');
  assert.equal(raw['session-a'].chatTurns, 0);
  assert.ok(raw['session-a'].updatedAt > 0, 'updatedAt is a timestamp');
});

// ② 模拟冷启动 → 新 store 实例 hydrate 后 Map 正确恢复
await t('cold start hydrates Map from sidecar', async () => {
  const home = await mkHome('sm-restore-');
  const w = createSessionModeStore({ homeDir: home });
  w.set('session-a', { mode: 'work', chatTurns: 2, reason: 'tool-call' });
  assert.ok(await waitFor(() => fsP.access(pathP.join(home, 'plugin-state', SESSION_MODE_SIDECAR)).then(() => true, () => false)), 'sidecar written');
  // 冷启动：全新实例（模拟进程重启）
  const cold = createSessionModeStore({ homeDir: home });
  assert.equal(cold.peek('session-a'), null, 'peek before hydrate = empty (no IO in peek)');
  const added = await cold.hydrate();
  assert.equal(added, 1, 'hydrate restores exactly one session');
  const st = cold.peek('session-a');
  assert.equal(st.mode, 'work');
  assert.equal(st.chatTurns, 2, 'chatTurns counter survives restart');
  assert.equal(await cold.hydrate(), 0, 'hydrate is idempotent (second call = 0)');
  const rd = await cold.read('session-a'); // 阶段三 pre-step 的读口
  assert.equal(rd.mode, 'work');
});

// ③ mode-changed 事件语义：新会话写 chat 不触发（初始化）；升/降档触发；chatTurns 更新不触发
await t('mode-changed fires only on real transitions', async () => {
  const home = await mkHome('sm-event-');
  const events = [];
  const store = createSessionModeStore({ homeDir: home, onEvent: (ev) => events.push(ev) });
  store.set('session-b', { mode: 'chat', chatTurns: 0 });       // 新会话初始化 → 不触发
  assert.equal(events.length, 0, 'first write as chat is init, not a change');
  store.set('session-b', { mode: 'work', chatTurns: 0, reason: 'tool-call' }); // 升档 → 触发
  assert.equal(events.length, 1, 'chat->work fires');
  assert.deepEqual({ sid: events[0].sid, prevMode: events[0].prevMode, mode: events[0].mode }, { sid: 'session-b', prevMode: 'chat', mode: 'work' });
  assert.equal(events[0].reason, 'tool-call');
  store.set('session-b', { mode: 'work', chatTurns: 1 });       // 计数更新（同模式）→ 不触发
  assert.equal(events.length, 1, 'chatTurns update is not a mode change');
  store.set('session-b', { mode: 'chat', chatTurns: 0, reason: 'idle-3-turns' }); // 降档 → 触发
  assert.equal(events.length, 2, 'work->chat fires');
  assert.equal(events[1].prevMode, 'work');
  assert.equal(events[1].mode, 'chat');
});

// ④ 无侧车 / 损坏侧车 → 冷启动默认 chat，不抛
await t('missing or corrupt sidecar degrades to default chat', async () => {
  const home = await mkHome('sm-empty-');
  const s1 = createSessionModeStore({ homeDir: home });
  assert.equal(await s1.hydrate(), 0, 'no file = 0, no throw');
  assert.equal(s1.peek('session-x'), null, 'unknown session has no state (defaults to chat upstream)');
  const p = pathP.join(home, 'plugin-state', SESSION_MODE_SIDECAR);
  await fsP.mkdir(pathP.dirname(p), { recursive: true });
  await fsP.writeFile(p, 'not-json{{{', 'utf8');
  const s2 = createSessionModeStore({ homeDir: home });
  assert.equal(await s2.hydrate(), 0, 'corrupt file = 0, no throw');
  assert.equal(s2.peek('session-x'), null);
  const rd = await s2.read('session-x');
  assert.equal(rd, null, 'read on miss after hydrate = null (upstream defaults chat)');
});

// ⑤ 有界：插入 501 个 sid → map 不超 CAP，最旧被清
await t('bounded store evicts oldest beyond cap', async () => {
  const home = await mkHome('sm-cap-');
  const store = createSessionModeStore({ homeDir: home });
  for (let i = 0; i < SESSION_MODE_CAP + 1; i++) store.set('s' + i, { mode: 'work', chatTurns: 0 });
  assert.equal(store.size(), SESSION_MODE_CAP, 'size stays at cap');
  assert.equal(store.peek('s0'), null, 'oldest evicted');
  assert.ok(store.peek('s1'), 'oldest survivor retained');
  assert.ok(store.peek('s' + SESSION_MODE_CAP), 'newest present');
});

// ⑥ 非法 sid / peek 同步读 / 侧车路径
await t('invalid sid rejected, peek is sync and side-effect free', async () => {
  const home = await mkHome('sm-sid-');
  const store = createSessionModeStore({ homeDir: home });
  assert.equal(store.set('unknown', { mode: 'work' }), null, 'sid unknown rejected');
  assert.equal(store.set('', { mode: 'work' }), null, 'empty sid rejected');
  assert.equal(store.set(null, { mode: 'work' }), null, 'null sid rejected');
  assert.equal(store.peek('unknown'), null);
  const p = await store.sidecarPath();
  assert.equal(p, pathP.join(home, 'plugin-state', SESSION_MODE_SIDECAR), 'sidecar path shape');
  assert.equal(MODE_CHANGED_EVENT, 'auto-model-router/mode-changed', 'event name contract');
});

// ⑦ homeDir 缺省（冷存储关闭）→ 仅热 Map，set 不抛、hydrate 不抛
await t('no homeDir keeps hot Map only (cold store off)', async () => {
  const store = createSessionModeStore({});
  const e = store.set('session-y', { mode: 'work', chatTurns: 0 });
  assert.equal(e.mode, 'work');
  assert.equal(await store.hydrate(), 0);
  assert.equal(await store.save(), false, 'save without home = false, no throw');
  await tick(20); // 等 set 内部 fire-and-forget 落盘失败路径消化
});

console.log(process.exitCode ? 'session-mode tests FAILED' : 'session-mode tests all passed');
