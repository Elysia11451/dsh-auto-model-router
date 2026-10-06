import assert from 'node:assert/strict';
import { normalizeId, rankIntersection, pickTop, fetchRankOrder, createLeaderboardCache, OR_URL, CACHE_TTL_MS, DEFAULT_WORK_MODEL } from '../src/leaderboard.js';

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
