/**
 * dsh-auto-model-router / work 模型解析（v0.7.0）。
 *
 * v0.7.0 组成（三层，全纯函数/全异步，绝不阻塞主线程）：
 *   1. 模型名归一化 normalizeId —— 配置链与可用清单对名用；
 *   2. work 模型静态降级链 pickWorkModelFromChain —— Config.workModelPriority
 *      （FreeTierError 后的策略：动态榜只是加分项，链才是底线）；
 *   3. OpenRouter 公开排行榜（fetchRankOrder + createLeaderboardCache +
 *      rankIntersection/pickTop）—— 数据源 https://openrouter.ai/api/v1/models
 *      ?sort=agentic-high-to-low（免 Key），5 秒超时（FETCH_TIMEOUT_MS），
 *      内存 1h 缓存 + 本地文件缓存 .cache/rankings.json（loadRankCache/saveRankCache，1h TTL）。
 *
 * 降级语义（fail-closed）：
 *   排行榜抓取失败 / 超时 / 缓存过期 → 调用方直接走 workModelPriority 链
 *   （pickWorkModelFromChain，链头优先、清单未就绪回退 fallback），绝不抛、绝不阻塞。
 *
 * 设计约束（移动端规范）：
 *  - 纯函数：链解析与交集可离线单测；文件 IO 只在 load/save 函数内且全 try 包裹。
 *  - 不抛出：任何输入/网络/文件异常都兜底为 null/fallback。
 */

// 静态降级链默认（v0.7.0 策略调整：our-free-model 免费层 403 FreeTierError，
// 不再依赖免费池实测，链作为静态配置保留，等上游风控放开再恢复动态实测）。
export const DEFAULT_WORK_MODEL = 'mimo-v2.6-flash-free';
export const DEFAULT_WORK_MODEL_PRIORITY = Object.freeze([
  'mimo-v2.6-flash-free',
  'glm-5.3-flash',
  'deepseek-v4.1-flash',
]);

// OpenRouter 公开榜单（agentic 能力降序；免 Key）。
export const OR_URL = 'https://openrouter.ai/api/v1/models?sort=agentic-high-to-low';
// 缓存 1 小时（内存 + 文件同一 TTL）。
export const CACHE_TTL_MS = 3600_000;
// 单次抓取 5 秒硬超时：上游挂起也绝不拖住调用方。
export const FETCH_TIMEOUT_MS = 5000;

/**
 * 模型名归一化：抹掉机构前缀与发行后缀，让 "muse-spark-1.3-contributor-free"
 * 与 "meta/muse-spark-1.3" 能对上。
 *   org/muse-spark-1.3-contributor-free  ->  muse.spark.1.3
 *   nvidia/nemotron-3-ultra:free         ->  nemotron.3.ultra
 */
export function normalizeId(id) {
  let s = String(id ?? '').toLowerCase();
  s = s.replace(/^[a-z0-9._-]+(?=\/)/, ''); // 机构前缀（含最后一个 /）
  s = s.replace(/:free$/, '');              // OpenRouter 的 :free 变体
  s = s.replace(/-free$/, '');              // 我方发行后缀
  s = s.replace(/-contributor$/, '');       // 贡献者发行后缀
  s = s.replace(/[^a-z0-9.]/g, '');         // 其余分隔符统一剔除
  return s;
}

// 两级归一化对名：等值或一端为另一端前缀（发行变体抹平，如
// space-bunny-alpha ↔ space-bunny、nemotron-3-ultra-550b-a55b ↔ nemotron-3-ultra、
// deepseek-v4-flash-0731 ↔ deepseek-v4-flash）。deepseek-v4.1-flash ≠
// deepseek-v4-flash：第 11 位 '.' vs 'f' 分叉，前缀不成立，不会误配。
function matchesNorm(a, b) {
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * OpenRouter 榜单 × 可用清单求交：交集按榜单名次排序，另报清单里没进榜的。
 * 名次 = 该模型在 order 中最小命中下标；两个清单模型命中同一下标时先到先得。
 * @returns {{ranked: string[], unmatched: string[]}}
 */
export function rankIntersection(orderIds, availableIds) {
  try {
    const order = Array.isArray(orderIds) ? orderIds : [];
    const free = Array.isArray(availableIds) ? availableIds : [];
    const orderNorms = order.map((m) => normalizeId(m));
    const used = new Set();
    const hit = [];
    for (const m of free) {
      const n = normalizeId(m);
      if (!n) continue;
      let best = -1;
      for (let i = 0; i < orderNorms.length; i++) {
        if (used.has(i)) continue;
        if (matchesNorm(orderNorms[i], n)) { best = i; break; }
      }
      if (best >= 0) { used.add(best); hit.push({ id: m, idx: best }); }
    }
    hit.sort((x, y) => x.idx - y.idx);
    const ranked = hit.map((x) => x.id);
    const rankedSet = new Set(ranked);
    const unmatched = free.filter((m) => !rankedSet.has(m));
    return { ranked, unmatched };
  } catch {
    return { ranked: [], unmatched: [] };
  }
}

/**
 * 交集里挑名次最高且仍可用者；交集空返回 null（调用方走降级链）。
 */
export function pickTop(rankedIds, availableIds) {
  try {
    const ranked = Array.isArray(rankedIds) ? rankedIds : [];
    if (ranked.length === 0) return null;
    if (!Array.isArray(availableIds)) return ranked[0] ?? null;
    if (availableIds.length === 0) return null;
    const availNorm = new Set(availableIds.map((m) => normalizeId(m)).filter(Boolean));
    for (const id of ranked) {
      if (availNorm.has(normalizeId(id))) return id;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 异步抓取 OpenRouter 榜单（5 秒硬超时，失败/超时/结构异常一律 null，不抛）。
 * 调用方只在后台刷新链里用它，热路径（currentWorkModel）永远同步读内存。
 *
 * @param {Object} [p]
 * @param {string} [p.url]         榜单地址（默认 OR_URL）
 * @param {Function} [p.fetchImpl] 注入的 fetch（单测离线用；缺省用全局 fetch）
 * @param {number} [p.timeoutMs]   超时（默认 FETCH_TIMEOUT_MS = 5000）
 * @returns {Promise<string[]|null>} 有序 id 列表；失败 null
 */
export async function fetchRankOrder({ url = OR_URL, fetchImpl = null, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  let timer = null;
  try {
    const f = fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
    if (!f) return null;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => {
        try { ctrl?.abort(); } catch { /* noop */ }
        rej(new Error(`fetch timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const work = (async () => {
      const res = await f(url, ctrl ? { signal: ctrl.signal } : undefined);
      if (!res || !res.ok) return null;
      const body = await res.json?.();
      const list = Array.isArray(body?.data) ? body.data : null;
      if (!list || list.length === 0) return null;
      const ids = list
        .map((m) => (m && typeof m.id === 'string' && m.id.trim() ? m.id.trim() : null))
        .filter(Boolean);
      return ids.length > 0 ? ids : null;
    })();
    const guarded = Promise.race([work, timeout]);
    // 挂起的 work 即使超时后才拒绝也不产生 unhandledRejection。
    guarded.catch(() => {});
    const ids = await guarded;
    return Array.isArray(ids) ? ids : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 内存缓存：1h TTL + inflight 守卫 + 最近一次错误记录（全同步，热路径可读）。
 */
export function createLeaderboardCache({ now = () => Date.now() } = {}) {
  let ids = null;
  let at = 0;
  let inflight = false;
  let lastError = null;
  return {
    isStale() { return !ids || now() - at > CACHE_TTL_MS; },
    get() { return ids; },
    set(next) {
      if (!Array.isArray(next) || next.length === 0) return false; // 空结果不覆盖旧数据
      ids = next;
      at = now();
      return true;
    },
    begin() { if (inflight) return false; inflight = true; return true; },
    end() { inflight = false; },
    setError(e) { lastError = e instanceof Error ? e.message : String(e); },
    meta() { return { at, inflight, lastError, count: ids?.length ?? 0, ttl: CACHE_TTL_MS }; },
  };
}

/**
 * 本地文件缓存（.cache/rankings.json，1h TTL）：写入成功供下次启动直接热读，
 * 让"上游抽风"只影响一次刷新。全失败静默 —— 文件缓存缺失必须等于没缓存，
 * 绝不能让 IO 异常传到调用方。
 *
 * @returns {Promise<string[]|null>} 新鲜榜单 id；缺失/过期/损坏 → null
 */
export async function loadRankCache(cachePath) {
  try {
    if (!cachePath) return null;
    const { readFile } = await import('node:fs/promises');
    const raw = JSON.parse(await readFile(cachePath, 'utf8'));
    if (!raw || typeof raw.ts !== 'number') return null;
    if (Date.now() - raw.ts > CACHE_TTL_MS) return null; // 过期 = 没有
    if (!Array.isArray(raw.ids) || raw.ids.length === 0) return null;
    return raw.ids;
  } catch {
    return null;
  }
}

/**
 * 落盘榜单（{ ts, ids }）。成功 true；任何失败 false（调用方只当没缓存）。
 */
export async function saveRankCache(cachePath, ids) {
  try {
    if (!cachePath || !Array.isArray(ids) || ids.length === 0) return false;
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify({ ts: Date.now(), ids }), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 按优先降级链挑 work 模型：链头优先，命中可用清单即返回；全不中回退 fallback。
 * 两级匹配统一走 normalizeId（配置写全名/裸名/带前缀都能对上清单里的 id）。
 *
 * @param {Object} p
 * @param {string[]|null} p.chain         Config.workModelPriority（有序）
 * @param {string[]|null} p.availableIds  our-free-model 当前可用清单（未就绪传 null/[]）
 * @param {string} [p.fallback]           workModelFallback（缺省 DEFAULT_WORK_MODEL）
 * @returns {string} 命中的模型 id（返回链上的原写法，供 selectModel 使用）
 */
export function pickWorkModelFromChain({ chain, availableIds, fallback = DEFAULT_WORK_MODEL } = {}) {
  try {
    const list = Array.isArray(chain) ? chain.filter((m) => typeof m === 'string' && m.trim().length > 0) : [];
    const fb = typeof fallback === 'string' && fallback.trim() ? fallback : DEFAULT_WORK_MODEL;
    if (list.length === 0) return fb;
    const avail = Array.isArray(availableIds) ? availableIds : [];
    // 清单未就绪或全不可用：不阻塞，直接回退（调用方已同步触发后台补拉）。
    if (avail.length === 0) return fb;
    // 两级匹配：归一化后等值或一端为另一端前缀（与 rankIntersection 同一套 matchesNorm），
    // 配置写全名/裸名/带前缀（如 deepseek-v4-flash ↔ 清单里的 deepseek-v4-flash-0731）都能对上。
    const availNorms = avail.map((m) => normalizeId(m)).filter((m) => m.length > 0);
    for (const want of list) {
      const n = normalizeId(want);
      if (n && availNorms.some((a) => matchesNorm(a, n))) return want.trim();
    }
    return fb;
  } catch {
    return DEFAULT_WORK_MODEL;
  }
}
