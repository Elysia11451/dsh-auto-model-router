// leaderboard / impl / refresh —— 动态工作模型的「取数 + 过期 + 选模」。
// 回答的问题：现在干活该用哪个模型？榜单/清单新鲜吗？该刷新了吗？
// 纯算法（交集/挑榜/降级链）在本目录 leaderboard.js；本文件只管联网节拍与状态。
//
// 拆分铁律：本文件不 import 本域 interface.js（用 JSDoc typedef 描述形状）；
// 跨域依赖（cfg/flags/manualLock/safeLog/文件读写）由装配根经 deps 注入。
import {
  createLeaderboardCache,
  fetchRankOrder,
  loadRankCache,
  saveRankCache,
  pickWorkModelFromChain,
  rankIntersection,
  pickTop,
  OR_URL,
  CACHE_TTL_MS,
  DEFAULT_WORK_MODEL,
} from '../leaderboard.js';

/**
 * @typedef {object} LeaderboardRefreshDeps
 * @property {object} ctx             —— 插件上下文（safeLog 第一参）
 * @property {object} cfg             —— 稳定配置对象（原地更新，引用永不换）
 * @property {{dynamicOn: boolean}} flags —— 可变开关（dynamicOn 被自测 t10 翻转）
 * @property {object} manualLock      —— 手动锁（原地更新）
 * @property {(ctx: object, level: string, msg: string) => void} safeLog
 * @property {(homeDir?: string) => Promise<string>} getDshHomeDir
 * @property {(p: string) => Promise<string>} readTextFile
 */

export function createLeaderboardRefresh(d) {
  const { ctx, cfg, flags, manualLock, safeLog, getDshHomeDir, readTextFile, fetchImpl = null } = d;

  // ── 动态工作模型（联网排行榜，1h 缓存；同步读、后台刷，绝不阻塞工具链）──
  // 数据源：OpenRouter ?sort=most-popular；交集 = our-free-model 当前可用清单。
  const lb = createLeaderboardCache();
  // v0.7.5：rankingRefreshSeconds 驱动刷新节拍（默认 3600s = CACHE_TTL_MS，行为与旧版一致）。
  // clamp 30–3600 与 schema min/max 对齐；文件缓存仍走 1h（loadRankCache 内部 TTL）。
  const rankTtlMs = () => {
    try {
      const s = Number(cfg?.rankingRefreshSeconds);
      const clamped = Number.isFinite(s) ? Math.min(3600, Math.max(30, s)) : 3600;
      return clamped * 1000;
    } catch { return CACHE_TTL_MS; }
  };
  const lbStale = () => {
    try {
      if (!lb.get()) return true;
      return Date.now() - lb.meta().at > rankTtlMs();
    } catch { try { return lb.isStale(); } catch { return false; } }
  };
  const freeList = { ids: null, avail: null, at: 0 }; // 我方清单（内存缓存）
  const FREE_LIST_TTL_MS = 60 * 1000;                 // 可用清单 60s 刷新（上游会变）
  let lbErrLoggedAt = 0;                              // 降级日志限频（避免刷屏/限流）
  // v0.5.0 可观测：OpenRouter 实际发起的请求次数（自测 t10 断言 enableDynamicRanking=false 时为 0）。
  let lbFetchCount = 0;

  // 后台刷新我方可用清单（catalog + availability）。失败只记日志，不抛。
  async function refreshFreeList() {
    try {
      const home = await getDshHomeDir();
      const { join } = await import('node:path');
      const catRaw = await readTextFile(join(home, 'our-free-model', 'catalog.json'));
      const avRaw = await readTextFile(join(home, 'our-free-model', 'availability.json'));
      const entries = JSON.parse(catRaw)?.entries;
      const results = JSON.parse(avRaw)?.results;
      if (Array.isArray(entries) && entries.length > 0) {
        freeList.ids = entries;
        // v0.8.7 步骤7（千问审计）：results 为数组时按 state==='available' 过滤——
        // 旧版直接给 []，使 avail 回落整份 entries，availability 判定被短路（下游拿全量当全可用）。
        // 元素 id 取 id/model/key（夹具两形态都见过）；对象形态保持旧逻辑不变。
        const ok = Array.isArray(results)
          ? results.filter((r) => r?.state === 'available')
              .map((r) => r?.id ?? r?.model ?? r?.key).filter(Boolean)
          : Object.entries(results || {})
              .filter(([, v]) => v?.state === 'available').map(([k]) => k);
        // 可用优先；上游全挂/无一条可用时退回整份清单（交集仍可能命中）
        freeList.avail = ok.length > 0 ? ok : entries;
        freeList.at = Date.now();
      }
    } catch (err) {
      safeLog(ctx, 'debug', `free-list refresh failed (${String(err?.message ?? err)}); keeping ${freeList.ids ? 'previous' : 'empty'} list.`);
    }
  }

  // 本地文件缓存路径（.cache/rankings.json，相对 DSH_HOME；解析失败 = 不用文件缓存）。
  async function rankCachePath() {
    try {
      const home = await getDshHomeDir();
      const { join } = await import('node:path');
      return join(home, '.cache', 'rankings.json');
    } catch { return null; }
  }

  // 后台刷新排行榜（1h TTL）。失败：记录 + 限频日志，缓存保持原样（旧数据仍可用）。
  // v0.5.0: enableDynamicRanking=false 时直接跳过（不 fetch），调用方走回退值。
  async function refreshLeaderboard() {
    if (!flags.dynamicOn) return;
    if (manualLock.on) return; // 功能二：锁定时不发起 OpenRouter 请求（lbFetchCount 保持 0）
    if (!lb.begin()) return;
    lbFetchCount++; // 只统计真正发起的请求（guard/inflight 短路不计）
    try {
      // v0.8.7 步骤5：fetchImpl 注入（单测离线确定性）；生产 null = 全局 fetch（行为零变化）。
      const ids = await fetchRankOrder({ url: OR_URL, fetchImpl });
      if (ids) {
        lb.set(ids);
        safeLog(ctx, 'info', `leaderboard refreshed: ${ids.length} ranked models (ttl ${Math.round(rankTtlMs() / 60000)}min).`);
        // v0.7.0: 落盘 1h 文件缓存，供下次启动热读（失败静默，绝不影响主流程）。
        rankCachePath().then((p) => saveRankCache(p, ids)).catch(() => {});
      } else {
        lb.setError('fetch returned null');
        const now = Date.now();
        if (now - lbErrLoggedAt > 10 * 60 * 1000) { // 限频：10 分钟最多一条降级日志
          lbErrLoggedAt = now;
          const chain = Array.isArray(cfg.workModelPriority) ? cfg.workModelPriority : [];
          safeLog(ctx, 'warn', `leaderboard fetch failed; work model falls back to workModelPriority chain (head ${chain[0] || (cfg.workModelFallback || cfg.workModel)}).`);
        }
      }
    } catch (err) {
      lb.setError(err);
    } finally {
      lb.end();
    }
  }

  // v0.7.0: 启动时先读本地文件缓存（1h 内的新鲜榜单直接进内存，上游抽风只影响一次刷新）。
  async function warmRankCache() {
    try {
      const ids = await loadRankCache(await rankCachePath());
      if (ids && lb.set(ids)) {
        safeLog(ctx, 'info', `leaderboard file cache loaded: ${ids.length} ranked models.`);
      }
    } catch { /* 文件缓存缺失/损坏 = 没缓存 */ }
  }

  // 同步选模：排行榜 + 可用清单交集取排名最高者；任一缺失 -> 静态降级链
  // pickWorkModelFromChain（cfg.workModelPriority 按序对可用清单挑，链头优先），
  // 链全不中/清单未就绪 -> 回退模型（cfg.workModelFallback > cfg.workModel > 内置默认）。
  // v0.5.0: enableDynamicRanking=false 时直接走链，不读榜单。
  function currentWorkModel() {
    if (manualLock.on) return manualLock.model; // 功能二：手动锁定绝对优先，不读榜单/清单
    const fallback = cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL;
    const chain = Array.isArray(cfg.workModelPriority) ? cfg.workModelPriority : [];
    const viaChain = () => pickWorkModelFromChain({ chain, availableIds: freeList.avail, fallback });
    if (!flags.dynamicOn) return viaChain();
    try {
      const order = lb.get();
      const avail = freeList.avail;
      if (!order || !avail || avail.length === 0) return viaChain();
      const { ranked } = rankIntersection(order, avail);
      const top = pickTop(ranked, avail);
      if (top) return top;
      return viaChain();
    } catch {
      return viaChain();
    }
  }

  // 过期检查（fire-and-forget）：清单 60s / 排行榜 1h。
  function ensureFresh() {
    if (manualLock.on) return; // 功能二：锁定时连过期检查都跳过（动态信息无人消费）
    try {
      const now = Date.now();
      if (now - freeList.at > FREE_LIST_TTL_MS) refreshFreeList().catch(() => {});
      if (lbStale() && !lb.meta().inflight) refreshLeaderboard().catch(() => {});
    } catch { /* noop */ }
  }

  return {
    lb,
    freeList,
    rankTtlMs,
    lbStale,
    refreshFreeList,
    rankCachePath,
    refreshLeaderboard,
    warmRankCache,
    currentWorkModel,
    ensureFresh,
    get lbFetchCount() { return lbFetchCount; },
  };
}
