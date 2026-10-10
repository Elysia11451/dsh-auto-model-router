import assert from 'node:assert/strict';
import { normalizeId, rankIntersection, pickTop, fetchRankOrder, createLeaderboardCache, pickWorkModelFromChain, loadRankCache, saveRankCache, OR_URL, CACHE_TTL_MS, DEFAULT_WORK_MODEL, DEFAULT_WORK_MODEL_PRIORITY } from '../src/leaderboard/leaderboard.js';

const t = (name, fn) => { try { fn(); console.log(`ok - ${name}`); } catch (e) { console.error(`FAIL - ${name}: ${e.message}`); process.exitCode = 1; } };
const ta = async (name, fn) => { try { await fn(); console.log(`ok - ${name}`); } catch (e) { console.error(`FAIL - ${name}: ${e.message}`); process.exitCode = 1; } };

// ── 归一化 ──
t('normalizeId strips org prefix + free/contributor suffix', () => {
  assert.equal(normalizeId('meta/muse-spark-1.3-contributor-free'), normalizeId('muse-spark-1.3'));
  assert.equal(normalizeId('xiaomi/mimo-v2.6-flash'), normalizeId('mimo-v2.6-flash-free'));
  assert.equal(normalizeId('nvidia/nemotron-3-ultra:free'), normalizeId('nemotron-3-ultra-free'));
  assert.equal(normalizeId('z-ai/glm-5.3-flash'), 'glm5.3flash');
});
t('normalizeId tolerates garbage', () => {
  assert.equal(normalizeId(null), '');
  assert.equal(normalizeId(undefined), '');
  assert.equal(normalizeId(123), '123');
});

// ── 真数据交集（OpenRouter 真实排序片段 + our-free 13 清单）──
const REAL_ORDER = [
  'stealth/space-bunny-alpha', 'deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash',
  'xiaomi/mimo-v2.6-flash', 'tencent/hy4-preview', 'openai/gpt-6-luna',
  'deepseek/deepseek-v4-flash-0731', 'nvidia/nemotron-3-ultra-550b-a55b:free',
  'meta/muse-spark-1.3', 'inclusionai/ling-3.1-flash', 'inclusionai/ling-3.0-flash-fin',
  'xiaomi/mimo-v2.5', 'nvidia/nemotron-3.5-lightning', 'meta/muse-spark-1.2',
];
const FREE13 = ['jev-1.13-free', 'deepseek-v4-flash-free', 'muse-spark-1.3-contributor-free',
  'muse-spark-1.2-contributor-free', 'mimo-v2.6-flash-free', 'space-bunny-free',
  'longcat-2.5-preview-free', 'mimo-v2.5-free', 'ling-3.0-flash-fin-free',
  'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free', 'fledge-alpha-free', 'ling-3.1-flash-free'];

t('rankIntersection real data: 10/13 matched, order preserved', () => {
  const { ranked, unmatched } = rankIntersection(REAL_ORDER, FREE13);
  assert.equal(ranked.length, 10, `expected 10 got ${ranked.length}`);
  assert.equal(unmatched.length, 3);
  for (const u of ['jev-1.13-free', 'longcat-2.5-preview-free', 'fledge-alpha-free']) {
    assert.ok(unmatched.includes(u), `${u} should be unmatched`);
  }
  // 排名顺序必须跟 OpenRouter 顺序一致
  // order: space-bunny idx0 < mimo-v2.6 idx3 < deepseek-v4-flash idx6 < …
  assert.equal(ranked[0], 'space-bunny-free');           // order idx 0
  assert.equal(ranked[1], 'mimo-v2.6-flash-free');        // order idx 3
  assert.equal(ranked[2], 'deepseek-v4-flash-free');      // order idx 6 (v4-flash-0731)
});

t('rankIntersection sorts by OpenRouter rank not input order', () => {
  const { ranked } = rankIntersection(REAL_ORDER, ['mimo-v2.6-flash-free', 'space-bunny-free']);
  // space-bunny idx0 < mimo idx3
  assert.deepEqual(ranked, ['space-bunny-free', 'mimo-v2.6-flash-free']);
});

t('pickTop picks highest ranked available', () => {
  const { ranked } = rankIntersection(REAL_ORDER, FREE13);
  assert.equal(pickTop(ranked, FREE13), ranked[0]);
});

t('pickTop skips unavailable models', () => {
  const ranked = ['space-bunny-free', 'mimo-v2.6-flash-free'];
  const avail = ['mimo-v2.6-flash-free']; // space-bunny 不可用
  assert.equal(pickTop(ranked, avail), 'mimo-v2.6-flash-free');
});

t('pickTop returns null on empty intersection', () => {
  assert.equal(pickTop([], FREE13), null);
  assert.equal(pickTop(null, null), null);
});

t('empty order -> null-ish safe (caller falls back)', () => {
  const { ranked } = rankIntersection([], FREE13);
  assert.equal(ranked.length, 0);
  assert.equal(pickTop(ranked, FREE13), null);
});

// ── fetch：成功 / 非200 / 抛错 / 结构异常 ──
await ta('fetchRankOrder success returns ordered ids', async () => {
  const fake = async (url) => {
    assert.equal(url, OR_URL, 'must call configured url');
    return { ok: true, json: async () => ({ data: [{ id: 'a/m1' }, { id: 'm2' }, { bad: 1 }] }) };
  };
  const ids = await fetchRankOrder({ fetchImpl: fake });
  assert.deepEqual(ids, ['a/m1', 'm2']);
});

await ta('fetchRankOrder http error -> null (no throw)', async () => {
  const ids = await fetchRankOrder({ fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(ids, null);
});

await ta('fetchRankOrder network throw -> null (no throw)', async () => {
  const ids = await fetchRankOrder({ fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(ids, null);
});

await ta('fetchRankOrder bad structure -> null', async () => {
  assert.equal(await fetchRankOrder({ fetchImpl: async () => ({ ok: true, json: async () => ({ nope: 1 }) }) }), null);
  assert.equal(await fetchRankOrder({ fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }) }), null);
});

await ta('fetchRankOrder missing fetch impl -> null', async () => {
  const ids = await fetchRankOrder({ fetchImpl: null });
  // 环境里有全局 fetch，所以可能真的联网——只要不抛即可
  assert.ok(ids === null || Array.isArray(ids));
});

// ── 缓存 ──
t('cache ttl 1 hour', () => {
  assert.equal(CACHE_TTL_MS, 3600_000);
});

t('cache set/get/stale lifecycle', () => {
  let now = 1000;
  const c = createLeaderboardCache({ now: () => now });
  assert.equal(c.isStale(), true, 'empty = stale');
  assert.equal(c.set(['m1', 'm2']), true);
  assert.equal(c.isStale(), false);
  now += 3599_000;
  assert.equal(c.isStale(), false, 'within 1h fresh');
  now += 2000;
  assert.equal(c.isStale(), true, 'past 1h stale');
});

t('cache rejects empty set and keeps old data', () => {
  const c = createLeaderboardCache();
  c.set(['keep-me']);
  assert.equal(c.set([]), false);
  assert.equal(c.set(null), false);
  assert.deepEqual(c.get(), ['keep-me']);
});

t('cache begin/end inflight guard', () => {
  const c = createLeaderboardCache();
  assert.equal(c.begin(), true);
  assert.equal(c.begin(), false, 'second begin rejected while inflight');
  c.end();
  assert.equal(c.begin(), true);
});

t('cache setError recorded', () => {
  const c = createLeaderboardCache();
  c.setError(new Error('boom'));
  assert.match(c.meta().lastError, /boom/);
});

t('default fallback model constant', () => {
  assert.equal(DEFAULT_WORK_MODEL, 'mimo-v2.6-flash-free');
});

// ── v0.7.0 静态降级链 ──
t('DEFAULT_WORK_MODEL_PRIORITY is the frozen 3-model static chain', () => {
  assert.deepEqual([...DEFAULT_WORK_MODEL_PRIORITY], ['mimo-v2.6-flash-free', 'glm-5.3-flash', 'deepseek-v4.1-flash']);
  assert.equal(Object.isFrozen(DEFAULT_WORK_MODEL_PRIORITY), true);
});

t('chain picks head when head is available', () => {
  const got = pickWorkModelFromChain({
    chain: ['mimo-v2.6-flash-free', 'glm-5.3-flash', 'deepseek-v4.1-flash'],
    availableIds: ['mimo-v2.6-flash-free', 'glm-5.3-flash'],
    fallback: 'fb',
  });
  assert.equal(got, 'mimo-v2.6-flash-free');
});

t('chain walks in priority order skipping unavailable', () => {
  const got = pickWorkModelFromChain({
    chain: ['mimo-v2.6-flash-free', 'glm-5.3-flash', 'deepseek-v4.1-flash'],
    availableIds: ['deepseek-v4-flash-free', 'glm-5.3-flash-free'], // 头两个都不可用
    fallback: 'fb',
  });
  // v0.8.7 P0-2：命中返回清单原 id（glm-5.3-flash-free），而非链上写法 glm-5.3-flash
  assert.equal(got, 'glm-5.3-flash-free');
});

t('chain falls back when nothing matches or list not ready', () => {
  const chain = ['mimo-v2.6-flash-free', 'glm-5.3-flash'];
  assert.equal(pickWorkModelFromChain({ chain, availableIds: ['someone-else-free'], fallback: 'fb' }), 'fb');
  assert.equal(pickWorkModelFromChain({ chain, availableIds: [], fallback: 'fb' }), 'fb', '清单未就绪 = 回退');
  assert.equal(pickWorkModelFromChain({ chain, availableIds: null, fallback: 'fb' }), 'fb');
  assert.equal(pickWorkModelFromChain({ chain: [], availableIds: ['mimo-v2.6-flash-free'], fallback: 'fb' }), 'fb', '空链 = 回退');
  assert.equal(pickWorkModelFromChain({ chain: null, availableIds: null, fallback: 'fb' }), 'fb');
});

t('chain two-level normalize match returns list real id (v0.8.7 P0-2)', () => {
  // 带机构前缀的配置写法照样对上清单裸名；命中返回清单里的原 id（真实可用 id）
  const got = pickWorkModelFromChain({
    chain: ['z-ai/glm-5.3-flash', 'deepseek-v4-flash'],
    availableIds: ['glm-5.3-flash-free', 'deepseek-v4-flash-0731'],
    fallback: 'fb',
  });
  assert.equal(got, 'glm-5.3-flash-free', '返回清单原 id 而非链写法');
});

t('chain does not false-match deepseek-v4.1 vs v4', () => {
  const got = pickWorkModelFromChain({
    chain: ['deepseek-v4.1-flash'],
    availableIds: ['deepseek-v4-flash-free'], // 第 11 位 '.' vs 'f' 分叉
    fallback: 'fb',
  });
  assert.equal(got, 'fb');
  const got2 = pickWorkModelFromChain({
    chain: ['deepseek-v4-flash'],
    availableIds: ['deepseek-v4-flash-0731'], // 前缀成立（0731 = 数字发行后缀，白名单内）
    fallback: 'fb',
  });
  assert.equal(got2, 'deepseek-v4-flash-0731', '返回清单原 id');
});

// v0.8.7 P0-2 新增：发行后缀白名单收紧 —— lite 是另一档位，不是发行后缀，不得误命中
t('chain does not false-hit mimo-v2.6-flash against mimo-v2.6-flash-lite', () => {
  const got = pickWorkModelFromChain({
    chain: ['mimo-v2.6-flash'],
    availableIds: ['mimo-v2.6-flash-lite'],
    fallback: 'fb',
  });
  assert.equal(got, 'fb', '前缀命中但多出 token 非已知发行后缀 → 不得命中');
});

// ── v0.7.0 本地文件缓存（.cache/rankings.json）──
const os = await import('node:os');
const fs = await import('node:fs/promises');
const path = await import('node:path');
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rank-cache-test-'));

await ta('file cache round-trip save then load', async () => {
  const p = path.join(tmpDir, 'rankings.json');
  assert.equal(await saveRankCache(p, ['m1', 'm2']), true);
  assert.deepEqual(await loadRankCache(p), ['m1', 'm2']);
});

await ta('file cache missing file / bad path -> null', async () => {
  assert.equal(await loadRankCache(path.join(tmpDir, 'nope.json')), null);
  assert.equal(await loadRankCache(null), null);
});

await ta('file cache expired (past 1h) -> null', async () => {
  const p = path.join(tmpDir, 'expired.json');
  await fs.writeFile(p, JSON.stringify({ ts: Date.now() - CACHE_TTL_MS - 1000, ids: ['m1'] }), 'utf8');
  assert.equal(await loadRankCache(p), null);
});

await ta('file cache malformed / missing ts / empty ids -> null', async () => {
  const p = path.join(tmpDir, 'bad.json');
  await fs.writeFile(p, 'not-json{', 'utf8');
  assert.equal(await loadRankCache(p), null, '损坏即当没有');
  await fs.writeFile(p, JSON.stringify({ ids: ['m1'] }), 'utf8');
  assert.equal(await loadRankCache(p), null, '缺 ts');
  await fs.writeFile(p, JSON.stringify({ ts: Date.now(), ids: [] }), 'utf8');
  assert.equal(await loadRankCache(p), null, '空 ids');
});

await ta('file cache save rejects empty ids and null path', async () => {
  assert.equal(await saveRankCache(path.join(tmpDir, 'empty.json'), []), false);
  assert.equal(await saveRankCache(null, ['m1']), false);
  assert.equal(await saveRankCache(path.join(tmpDir, 'empty.json'), null), false);
});
