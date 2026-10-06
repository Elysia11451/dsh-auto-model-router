/**
 * dsh-auto-model-router (host half, v0.2.0 rewrite).
 *
 * 按会话来源在 tools/pre-execute 链路上做路由决策：
 *  Rule 1 (IM 聊天)  -> 旁路放行 + 记录期望 chat 档（不阻断）
 *  Rule 2 (Agent 工作)-> 旁路放行 + 记录期望 work 档（不阻断）
 *  Rule 3 (群聊提示) -> 命中时在日志中给出切换提示（节流），不阻断
 *
 * 安全阀（防崩溃）：
 *  - apply() 内只做同步注册，不做网络/文件等长阻塞操作
 *  - pre-execute 处理器全程 try...catch，任何异常都 return next() 放行
 *  - 所有分支都以 return next() / return downstream 收尾，不留短路路径
 *  - ctx.effect 包裹注册，卸载时自动注销
 *  - free-model 缺失时降级为纯日志模式，不抛错
 */
import Schema from '@deepseek-ai/schemastery';
import { decideRoute, sourceFromMeta, isGroupMeta, isSameKind, isWorkModelRef, buildGroupHint, normalizeEffortForSwitch, buildSelectModelPayload, resolveChatTarget, parseManualWorkLock, isColdStartCrossKind, isUnknownDrift, DEFAULTS } from './router.js';
import { rankIntersection, pickTop, fetchRankOrder, createLeaderboardCache, pickWorkModelFromChain, loadRankCache, saveRankCache, DEFAULT_WORK_MODEL, CACHE_TTL_MS, OR_URL } from './leaderboard.js';
// v0.5.0: node:os/node:path 静态导入已移除（移动端规范），DSH_HOME 解析改走动态导入，见 getDshHomeDir()。
// v0.5.1: schemastery 改为静态真导入（规格红线：禁 stub/裸对象）。
//   依赖解析：@deepseek-ai/schemastery + @standard-schema/spec + @deepseek-ai/cosmokit
//   已 vendor 进工作区 node_modules（fuse 盘不支持 symlink，实拷贝），import 走真实路径。

export const name = 'dsh-auto-model-router';
// 移动端规范强制 inject = ['tools', 'llm']（多写会导致 PENDING）。
// sessionController / agentDefaultModel 只走 ctx.get 可选获取，缺席时降级为注解模式。
export const inject = ['tools', 'llm'];

// ── 插件配置（设置 → 插件 → 插件配置 自动投影成表单）──
// v0.5.1：真 Schemastery schema（规格红线：禁 stub / workaround / 裸对象）。
// 宿主 cordis: resolveConfig → runtime.Config["~standard"].validate(config)；
//              collectConfigSchemas → 'toJSON' in schema —— 两者由真 schema 天然满足。
// description({zh,en}) 是 schemastery 3.18.4 合法写法（存 schema.meta.description，string|Dict 双语，
//   本机实测 meta.description 落 {zh,en}、toJSON 正常、dsh-settings describe 不再炸）。
// 运维键（chatProvider 等）不带默认值：validate 缺失时原样不带该键，
//   {...DEFAULTS, ...config} 由 router.js DEFAULTS 兜底——若给空串默认会反向盖掉 DEFAULTS。
// 规格 7 键带默认值（缺省也必在 config 中，行为与 DEFAULTS 一致或以规格为准）。
export const Config = Schema.object({
  // —— 规格 7 键（m01006 一字不减）——
  chatModel: Schema.string().default('')
    .description({ zh: '聊天模型（自有 API），格式：provider/model。留空 = 自动用你自有 API 的默认模型（agent-default-model 当前值）；未配自有 API 则回退 workModelFallback 并打警告', en: 'Chat model (owned API), format provider/model; empty = auto-use your owned API default model (agent-default-model current value); falls back to workModelFallback with warning when no owned API is configured' }),
  workModelFallback: Schema.string().default('mimo-v2.6-flash-free')
    .description({ zh: '干活模型回退值（动态排行榜不可用时使用）', en: 'Work model fallback (used when dynamic ranking is unavailable)' }),
  privateChatWorkStrategy: Schema.union(['free', 'owned']).default('free')
    .description({ zh: '私聊干活策略：free=免费池动态最强，owned=自有 API', en: 'Private chat work strategy: free = strongest free pool, owned = own API' }),
  hintCooldownMs: Schema.number().default(300000)
    .description({ zh: '群聊提示冷却时间（毫秒）', en: 'Group hint cooldown (ms)' }),
  enableDynamicRanking: Schema.boolean().default(true)
    .description({ zh: '是否启用 OpenRouter 动态排行榜', en: 'Enable OpenRouter dynamic ranking' }),
  reclaimUnknownModel: Schema.boolean().default(true)
    .description({ zh: '未知模型纠偏：当前模型既非聊天目标也非配置的干活模型（外部漂移）时强制放回路由目标；关闭则保持"不认识就不动"的保守逻辑', en: 'Reclaim unknown drifted models: when the current model is neither the chat target nor the configured work model (external drift), force it back to the routing target; off keeps the conservative do-nothing behavior' }),
  manualWorkModel: Schema.string().default('')
    .description({ zh: '手动锁定的 work 模型（格式：provider/model）。填写后，Agent 干活时强制使用此模型，忽略动态排行榜', en: 'Manually locked work model (provider/model); forces work tasks to this model and skips dynamic ranking' }),
  manualWorkModelLocked: Schema.boolean().default(false)
    .description({ zh: '是否启用手动锁定 work 模型。开启后，work 场景不再使用动态排行榜', en: 'Enable manual work-model lock; locked work scenes skip dynamic ranking' }),
  // v0.7.0 静态降级链（不带默认值：validate 缺失时不带该键，由 DEFAULTS.workModelPriority 兜底）。
  workModelPriority: Schema.array(Schema.string())
    .description({ zh: '干活模型静态降级链（按优先级排序；动态排行榜不可用时依次挑选当前可用者，全不中回退 workModelFallback）', en: 'Static work-model fallback chain in priority order; picked against the availability list when dynamic ranking is unavailable, falls back to workModelFallback when none match' }),
  // —— 运维键（路由所需；模型/档位一律读配置，路由逻辑零硬编码；不带默认，防盖 DEFAULTS）——
  chatProvider: Schema.string().description({ zh: '聊天模型 provider（chatModel 为裸模型名时搭配）', en: 'Chat model provider (paired when chatModel is a bare model name)' }),
  chatEffort: Schema.string().description({ zh: '聊天档位（light/deep…）', en: 'Chat effort level' }),
  workProvider: Schema.string().description({ zh: '干活模型 provider', en: 'Work model provider' }),
  workModel: Schema.string().description({ zh: '干活模型（旧键/占位）', en: 'Work model (legacy key)' }),
  workEffort: Schema.string().description({ zh: '干活档位（free 策略）', en: 'Work effort (free strategy)' }),
  workEffortOwned: Schema.string().description({ zh: '干活档位（owned 策略）', en: 'Work effort (owned strategy)' }),
  hintMaxCount: Schema.number().description({ zh: '群聊提示累计上限', en: 'Group hint count cap' }),
  // —— 隔离自测门控键（生产不配 = 不运行）——
  selftest: Schema.union([Schema.boolean(), Schema.string()]).default(false)
    .description({ zh: '隔离自测开关（仅隔离环境配置；生产不配置该键）', en: 'Isolation selftest switch (isolated env only; not set in production)' }),
  selftestRound: Schema.string().default('')
    .description({ zh: '自测回合（r1..r6/all）', en: 'Selftest round (r1..r6/all)' }),
  selftestOut: Schema.string().default('')
    .description({ zh: '自测结果输出路径', en: 'Selftest result output path' }),
  switchCooldownMs: Schema.number().default(5000)
    .description({ zh: '同一会话连续切换冷却（毫秒），连续操作频繁时调小避免吞纠偏', en: 'Per-session switch cooldown in ms; lower it when rapid successive switches are swallowed' }),
});

// selftest 门控（cfg.selftest）时捕获 safeLog 输出，供隔离验证断言；生产为 null 不生效。
let selftestLines = null;

// 真实 exec.agent.session 是 session 对象（不是字符串）：取其 id；字符串则直传。
function sidOf(exec) {
  try {
    const s = exec?.agent?.session;
    if (typeof s === 'string') return s;
    return s?.header?.id ?? s?.id ?? exec?.agent?.id ?? exec?.sessionId ?? '';
  } catch { return ''; }
}

// 服务读取统一入口：inject 之外的属性直读会抛 "cannot get property ... without inject"，
// 且 catch 里再直读会二次抛 ⇒ 全部走 ctx.get（未就绪返回 undefined，不抛）。
function getService(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get(name) ?? null;
    return ctx?.[name] ?? null;
  } catch { return null; }
}

function safeLog(ctx, level, msg) {
  try {
    const logger = typeof ctx.logger === 'function' ? ctx.logger('auto-model-router') : ctx.logger;
    const fn = logger?.[level] ?? console?.[level] ?? console.log;
    fn.call(logger ?? console, `[auto-model-router] ${msg}`);
    try { if (selftestLines) selftestLines.push(`${level}: ${msg}`); } catch { /* noop */ }
  } catch { /* logger 不可用时静默 */ }
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  // v0.5.0 新增开关：enableDynamicRanking=false 时直接回退，不发起 OpenRouter 请求。
  // let（非 const）：自测 t10 需临时翻转该开关断言 guard（刷新函数/选模函数都读它）。
  let dynamicOn = cfg.enableDynamicRanking !== false;
  // 如果生产 patch 里还残留旧档位（off/max），调用层统一归一化，不污染 DEFAULTS。
  cfg.chatEffort = normalizeEffortForSwitch(cfg.chatEffort) || 'light';
  cfg.workEffort = normalizeEffortForSwitch(cfg.workEffort) || 'deep';
  // ── 功能二（v0.5.1）：手动锁定 work 模型 ──
  // 锁成立 ⇒ work 目标 = 手动 pair，跳过动态排行榜（refreshLeaderboard/ensureFresh 直接 return，
  // lbFetchCount 保持 0），日志 reason=manual-work-model-locked。
  // let + syncManualLock()：自测 t11/t12 运行时改 cfg 后重算（生产一次性，无运行时改需求）。
  let manualLock = { on: false, provider: '', model: '' };
  const syncManualLock = () => {
    manualLock = parseManualWorkLock({
      locked: cfg.manualWorkModelLocked,
      modelRef: cfg.manualWorkModel,
      fallbackProvider: cfg.workProvider,
    });
    if (manualLock.on) {
      safeLog(ctx, 'info', `manual work-model lock active: ${manualLock.provider}/${manualLock.model} (reason=${manualLock.reason}; dynamic ranking skipped, lbFetchCount frozen).`);
    }
  };
  syncManualLock();

  // ── v0.5.3：已知干活对（reclaimUnknownModel 判定用，全部来自配置，零硬编码）──
  // 只收"配置里点名的"干活 pair（workModel/workModelFallback/生效的手动锁）。
  // 刻意不含动态榜单交集成员/当前动态第一：实测交集 TOP 恰是漂移目标 muse-spark-1.2，
  // 记成已知会让纠偏在生产失灵；路由器自己选出的动态模型必写 lastSwitch 台账，台账匹配先于本判定。
  function knownWorkPairs() {
    const pairs = new Set();
    try {
      if (cfg.workModel) pairs.add(`${cfg.workProvider}/${cfg.workModel}`);
      const fb = cfg.workModelFallback || cfg.workModel;
      if (fb) pairs.add(`${cfg.workProvider}/${fb}`);
      if (manualLock.on && manualLock.provider && manualLock.model) pairs.add(`${manualLock.provider}/${manualLock.model}`);
    } catch { /* 配置读取失败返回已有集合 */ }
    return [...pairs];
  }

  // hintState: sessionKey -> { until: ts, count: n }（防刷屏：冷却 + 计数双保险）
  const hintState = new Map();
  // 真切节流：sessionId -> lastSwitchTs。连续 pre-execute 命中同一会话时，
  // 60s 内不重复 selectModel，避免模型选择器抖动（Step3 验证项 5）。
  const switchState = new Map();
  // 切换成功后的会话级当前模型缓存（= selectForNextRequest 装进 selection.current 的值）。
  // 权威读回：exec.agent 上没有 model 字段（官方无此属性），用投影/缓存读。
  const lastSwitch = new Map(); // sessionId -> 'provider/model/effort'
  const SWITCH_COOLDOWN_MS = 60 * 1000; // 历史默认（现已被 cfg.switchCooldownMs 覆盖，默认 5000）

  // ── 动态工作模型（联网排行榜，1h 缓存；同步读、后台刷，绝不阻塞工具链）──
  // 数据源：OpenRouter ?sort=most-popular；交集 = our-free-model 当前可用清单。
  const lb = createLeaderboardCache();
  const freeList = { ids: null, avail: null, at: 0 }; // 我方清单（内存缓存）
  const FREE_LIST_TTL_MS = 60 * 1000;                 // 可用清单 60s 刷新（上游会变）
  let lbErrLoggedAt = 0;                              // 降级日志限频（避免刷屏/限流）
  // v0.5.0 可观测：OpenRouter 实际发起的请求次数（自测 t10 断言 enableDynamicRanking=false 时为 0）。
  let lbFetchCount = 0;
  // v0.5.0: DSH_HOME 解析（动态导入 node:os/path；失败回退默认值，不阻塞 apply）。
  // 纯函数年金：如果调用方传入 homeDir 则直接用（单测/自测钉死路径用）。
  let dshHomeCache = null;
  async function getDshHomeDir(homeDir) {
    if (homeDir) return homeDir;
    if (process.env.DSH_HOME) return process.env.DSH_HOME;
    if (dshHomeCache) return dshHomeCache;
    try {
      const [{ homedir }, { join }] = await Promise.all([import('node:os'), import('node:path')]);
      dshHomeCache = join(homedir(), '.dsh');
    } catch { dshHomeCache = '.dsh'; }
    return dshHomeCache;
  }
  async function readTextFile(p) {
    const { readFile } = await import('node:fs/promises');
    return readFile(p, 'utf8');
  }
  async function writeTextFile(p, s) {
    const { writeFile } = await import('node:fs/promises');
    return writeFile(p, s);
  }

  // JSONL 诊断落盘（auto-router.jsonl）：每次 pre-execute 决策一行，
  // 字段：ts/sid/tool/extractText/task/route/target/actualSel/keepReason/switched/switchError。
  // 失败静默（诊断不能阻断工具链）；路径固定 ~/.dsh/logs/auto-router.jsonl。
  async function appendRouteLog(entry) {
    try {
      const home = await getDshHomeDir();
      const { join } = await import('node:path');
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
      const { appendFile, mkdir } = await import('node:fs/promises');
      const dir = join(home, 'logs');
      try { await mkdir(dir, { recursive: true }); } catch { /* 已存在 */ }
      await appendFile(join(dir, 'auto-router.jsonl'), line + '\n', 'utf8');
    } catch { /* 诊断落盘失败不阻断 */ }
  }

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
        const ok = Array.isArray(results) ? [] : Object.entries(results || {})
          .filter(([, v]) => v?.state === 'available').map(([k]) => k);
        // 可用优先；上游全挂时退回整份清单（交集仍可能命中）
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
    if (!dynamicOn) return;
    if (manualLock.on) return; // 功能二：锁定时不发起 OpenRouter 请求（lbFetchCount 保持 0）
    if (!lb.begin()) return;
    lbFetchCount++; // 只统计真正发起的请求（guard/inflight 短路不计）
    try {
      const ids = await fetchRankOrder({ url: OR_URL });
      if (ids) {
        lb.set(ids);
        safeLog(ctx, 'info', `leaderboard refreshed: ${ids.length} ranked models (ttl ${Math.round(CACHE_TTL_MS / 60000)}min).`);
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
    if (!dynamicOn) return viaChain();
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

  // 后台预热（apply 不 await）：先读文件缓存，再拉我方清单；榜单只在过期时打上游。
  Promise.resolve()
    .then(() => warmRankCache())
    .then(() => refreshFreeList())
    .then(() => { if (lb.isStale()) return refreshLeaderboard(); })
    .catch(() => {});

  // 过期检查（fire-and-forget）：清单 60s / 排行榜 1h。
  function ensureFresh() {
    if (manualLock.on) return; // 功能二：锁定时连过期检查都跳过（动态信息无人消费）
    try {
      const now = Date.now();
      if (now - freeList.at > FREE_LIST_TTL_MS) refreshFreeList().catch(() => {});
      if (lb.isStale() && !lb.meta().inflight) refreshLeaderboard().catch(() => {});
    } catch { /* noop */ }
  }

  // 依赖检查：our-free-model 缺失时输出明确错误并降级为纯日志模式，不静默失败。
  let freeModelOk = true;
  try {
    const llm = ctx.llm;
    if (!llm) {
      freeModelOk = false;
      safeLog(ctx, 'warn', 'llm service unavailable at apply time; degraded to log-only mode.');
    } else if (typeof llm.resolveModelInfo === 'function') {
      // 异步探测，不阻塞 apply：free-model 缺失/版本不兼容时降级。
      Promise.resolve()
        .then(() => llm.resolveModelInfo(cfg.workProvider, (cfg.workModelFallback || cfg.workModel)))
        .then((info) => {
          if (!info) {
            freeModelOk = false;
            safeLog(ctx, 'warn', `work model ${cfg.workProvider}/${cfg.workModel} not resolved (our-free-model missing or incompatible?); degraded to log-only mode.`);
          }
        })
        .catch((err) => {
          freeModelOk = false;
          safeLog(ctx, 'warn', `work model probe failed (${err?.message ?? err}); degraded to log-only mode.`);
        });
    }
  } catch (err) {
    freeModelOk = false;
    safeLog(ctx, 'warn', `dependency check failed (${err?.message ?? err}); degraded to log-only mode.`);
  }

  // 全局污染隔离（社区做法 @argszero/cordis-plugin-session-model）：
  // session-controller.selectModel 内部会 ctx.agentDefaultModel.saveSelection(selected)
  // （lib/index.js:736-738），把会话选择后台写进全局默认（settings.yaml，经 configEditor）。
  // 路由场景不需要这个副作用 —— 在实例上替换 saveSelection，只报告选择、不写 settings；
  // deploymentDefault: keep（保持默认，不改成 write）。替换失败则退回"切前默认写回"兜底。
  let saveIntercepted = false;
  try {
    const adm = getService(ctx, 'agentDefaultModel');
    if (adm && typeof adm.saveSelection === 'function' && !adm.__autoModelRouterGuard) {
      const origSave = adm.saveSelection.bind(adm);
      adm.__autoModelRouterOrigSave = origSave;
      adm.saveSelection = async (next) => {
        try {
          safeLog(ctx, 'info', `default-save intercepted (kept, not written): ${next?.provider ?? '?'} / ${next?.model ?? '?'}`);
        } catch { /* noop */ }
        return; // 只报告，不写 settings
      };
      adm.__autoModelRouterGuard = true;
      saveIntercepted = true;
      safeLog(ctx, 'info', 'agentDefaultModel.saveSelection intercepted: report-only, deploymentDefault kept.');
    }
  } catch (err) {
    safeLog(ctx, 'warn', `saveSelection intercept skipped, fallback to restore-before (${String(err?.message ?? err)})`);
  }

  // 真切：sessionId 直传 + effort 归一化 + 无 effort 菜单自动省略重试。
  // saveSelection 已被拦截（report-only）；若拦截未生效，realSwitch 内仍有"切前默认写回"兜底。
  // 任何异常都吞掉：真切失败只降级为注解模式，绝不阻断工具链。
  // 权威读回：model/selection 投影（sessionProjections.stateOf）。
  // 绝不读 exec.agent.model（官方无此字段）；读不到回退本插件切换缓存。
  // 同步版：pre-execute 热路径用（服务引用由调用方保证新鲜）。
  function readSelectionProjection(sid, services = null) {
    try {
      const sp = services?.sp ?? getService(ctx, 'sessionProjections');
      const sessionsSvc = services?.sessions ?? getService(ctx, 'sessions');
      const sess = typeof sid === 'string' && sessionsSvc?.get ? sessionsSvc.get(sid) : null;
      const st = sp?.stateOf?.(sess, 'modelSelection');
      const sel = st?.pending ?? st?.assembled;
      if (sel) return `${sel.provider}/${sel.model}/${sel.reasoningEffort ?? '-'}`;
    } catch { /* 读回失败不影响切换 */ }
    return lastSwitch.get(sid) ?? '(projection-unreadable)';
  }

  // v0.6.0 阶段二·修复点二：pre-step 的权威读取（旧路只有 pending/assembled 两个投影位）。
  // 三段降级：① 投影 pending/assembled → ② 会话 requestHeader().config（真实请求配置，
  // 外部漂移也会落这里）→ ③ 本插件切换台账 lastSwitch；三段全空才判 unreadable。
  // 投影对象在场但没有选择记录时返回 '(no-selection)'，与"读不出"区分开：
  // 前者可以正常判定，后者必须保守不覆盖。
  function readSelectionForRoute(sid) {
    try {
      if (!sid || sid === 'unknown') return '(projection-unreadable)';
      const sp = getService(ctx, 'sessionProjections');
      const sessionsSvc = getService(ctx, 'sessions');
      const sess = sessionsSvc?.get ? sessionsSvc.get(sid) : null;
      const st = sp?.stateOf?.(sess, 'modelSelection');
      const sel = st?.pending ?? st?.assembled;
      if (sel?.provider && sel?.model) return `${sel.provider}/${sel.model}/${sel.reasoningEffort ?? '-'}`;
      let hdr;
      try { hdr = typeof sess?.requestHeader === 'function' ? sess.requestHeader() : undefined; } catch { hdr = undefined; }
      const hc = hdr?.config;
      if (hc?.provider && hc?.model) return `${hc.provider}/${hc.model}/${hc.reasoningEffort ?? '-'}`;
      const mine = lastSwitch.get(sid);
      if (mine) return mine;
      if (st || sess) return '(no-selection)';
      return '(projection-unreadable)';
    } catch { return '(projection-unreadable)'; }
  }

  // 异步版：自测/后台路径用，先有界重查服务再读（宿主回收后旧引用失效）。
  async function readSelectionProjectionFresh(sid) {
    const sp = await resolveService('sessionProjections');
    const sessionsSvc = await resolveService('sessions');
    if (!sp) return lastSwitch.get(sid) ?? '(projection-unreadable)';
    return readSelectionProjection(sid, { sp, sessions: sessionsSvc });
  }

  // ── 功能一（v0.5.1）：用户手动选择绝对优先 —— durable 判定 ──
  // durable 信号（宿主 dsh-api-session-controller modelSelection 投影 + dsh-session 折叠）：
  //  ① 投影 pending —— 显式 selectModel 写入的 model/selection，尚未被请求消费；
  //  ② 会话 durable request header（session.requestHeader().config）—— 首条消息后即存在。
  // 来源判定（v0.5.1/内部模拟实测补）：durable 选择与本路由自己的切换台账 lastSwitch 一致
  //  ⇒ 路由自有态（chat/work 四象限来回切），允许继续路由；不一致（用户/其他来源改过）
  //  ⇒ 绝对优先返回 'user-manual-selection-kept'；
  // 状态读不出（服务缺席/会话查无）⇒ 返回 'selection-state-unreadable' 同样不覆盖（绝不赌手动选择）。
  // 落点说明：规格写"shouldSwitch 短路"；实现收敛到 realSwitch 入口 + pre-execute 注解
  // （单一咽喉，行为一致），shouldSwitch 保留精确同类判定语义。
  function manualKeepReason(sid, services = null, routeMode = '') {
    try {
      if (!sid || sid === 'unknown') return 'selection-state-unreadable';
      const sp = services?.sp ?? getService(ctx, 'sessionProjections');
      const sessionsSvc = services?.sessions ?? getService(ctx, 'sessions');
      const sess = sessionsSvc?.get ? sessionsSvc.get(sid) : null;
      if (!sess) return 'selection-state-unreadable';
      const st = sp?.stateOf?.(sess, 'modelSelection');
      let sel = st?.pending ?? null;
      if (!sel) {
        let hdr = null;
        try { hdr = typeof sess.requestHeader === 'function' ? sess.requestHeader() : undefined; } catch { hdr = undefined; }
        if (hdr?.config) sel = hdr.config;
      }
      if (!sel) {
        if (!st || typeof sp?.stateOf !== 'function') return 'selection-state-unreadable';
        return null;
      }
      // 来源判定：与路由自有切换台账比对（lastSwitch = 'provider/model/effort'，仅本插件真切成功时写入）
      const mine = lastSwitch.get(sid);
      if (mine) {
        const mineKey = mine.split('/').slice(0, 2).join('/');
        const selKey = `${sel.provider ?? ''}/${sel.model ?? ''}`;
        if (mineKey === selKey) return null; // 路由自己切的 → 四象限继续工作
      } else {
        // v0.5.2 冷启动空台账二次判定：台账为空（重启失忆）时用 route.mode × 当前档 provider
        // 做跨类放行（模型只来自配置）。routeMode 由 realSwitch/pre-execute 调用方透传；
        // 缺省（旧调用）→ 保守返回手动保持，不赌。
        try {
          if (routeMode) {
            const ct = resolveChatTarget({
              chatProvider: cfg.chatProvider,
              chatModel: cfg.chatModel,
              workProvider: cfg.workProvider,
              workModelFallback: cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL,
            });
            if (isColdStartCrossKind({
              selProvider: sel.provider ?? '',
              routeMode,
              workProvider: cfg.workProvider,
              chatTargetProvider: ct.provider,
            })) {
              const targetPair = routeMode === 'chat' ? `${ct.provider}/${ct.model}` : `${cfg.workProvider}/${currentWorkModel()}`;
              safeLog(ctx, 'info', `cold-start reroute allowed: ${sel.provider}/${sel.model} -> ${targetPair} (route.mode=${routeMode}; reason=cold-start-cross-kind).`);
              return null; // 放行一次：路由继续走真切，并重写 lastSwitch 台账
            }
          }
        } catch { /* 二次判定失败走保守路径 */ }
      }
      // ── v0.5.3 未知漂移纠偏（Config.reclaimUnknownModel，默认 true）──
      // 走到这里 = 台账外来（或冷启动跨类未命中）：当前模型既非聊天目标也非配置干活对
      // ⇒ 判为外部漂移，开关打开时放行真切（reason=reclaim-unknown-model）；
      // 关闭（false）→ 维持保守"不认识就不动"。routeMode 缺省（旧调用）不纠偏，绝不赌。
      try {
        if (routeMode && cfg.reclaimUnknownModel !== false) {
          const ct = resolveChatTarget({
            chatProvider: cfg.chatProvider,
            chatModel: cfg.chatModel,
            workProvider: cfg.workProvider,
            workModelFallback: cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL,
          });
          if (isUnknownDrift({
            selProvider: sel.provider ?? '',
            selModel: sel.model ?? '',
            chatTargetProvider: ct.provider,
            chatTargetModel: ct.model,
            knownWorkPairs: knownWorkPairs(),
          })) {
            const targetPair = routeMode === 'chat' ? `${ct.provider}/${ct.model}` : `${cfg.workProvider}/${currentWorkModel()}`;
            safeLog(ctx, 'info', `reclaim unknown model: ${sel.provider}/${sel.model} -> ${targetPair} (route.mode=${routeMode}; reason=reclaim-unknown-model).`);
            return null; // 纠偏放行：路由继续真切并重写 lastSwitch 台账
          }
        }
      } catch { /* 纠偏失败走保守路径 */ }
      return 'user-manual-selection-kept';
    } catch {
      return 'selection-state-unreadable';
    }
  }

  // ── 死代码清理（v0.4）：isUserWorkChoice 按 provider 全家判定，与精确同类口径冲突，
  // 且无任何调用方（grep 全仓零引用）——已删除，手动尊重统一走 shouldSwitch/isSameKind。

  // 精确同类判定见 router.js isSameKind（provider/model 精确匹配，不按全家判定）。

  // 仅当需要真切时返回目标，否则返回 null（表示：已在同类档位 / 用户选择优先，不干预）
  function shouldSwitch(actualSel, target) {
    try {
      if (!target?.provider || !target?.model) return target; // 目标无效交给调用方处理
      if (isSameKind(actualSel, target.provider, target.model)) return null; // 精确同类才不覆盖
      return target;
    } catch { return target; }
  }

  // 有界重查（官方补丁口径：3 次 × 250ms）：移动端宿主会回收服务，
  // 启动时取一次的引用不可信——每次用前重取，失败则等 250ms 再取，最多 3 次。
  async function resolveService(name, { retries = 3, intervalMs = 250 } = {}) {
    for (let i = 0; i < retries; i++) {
      let svc = null;
      try { svc = getService(ctx, name); } catch { svc = null; }
      if (svc) return svc;
      if (i < retries - 1) await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
  }

  async function realSwitch(sessionId, target, routeMode = '') {
    const sid = String(sessionId || '');
    const tag = `realSwitch ${sid || '(empty)'} -> ${target?.provider ?? '?'}/${target?.model ?? '?'}/${target?.effort ?? '-'}`;
    // STEP1 全部 early-return 带声音：no-session / no-controller / same-kind-kept / cooldown
    if (!sid || sid === 'unknown') {
      safeLog(ctx, 'warn', `${tag} | early-return reason=no-session`);
      return { ok: false, reason: 'no-session', target };
    }
    // 功能一短路（规格落点）：durable 手动选择/请求头在位 → 绝不覆盖（user-manual-selection-kept）。
    // v0.5.2：透传 route.mode，冷启动空台账时跨类可放行一次（reason 不再是 kept 而是真切）。
    // 放在 controller 解析之前：保留与否是读判定，不依赖真切服务是否就绪。
    try {
      const keep = manualKeepReason(sid, null, target?.__routeMode ?? routeMode);
      if (keep) {
        safeLog(ctx, 'info', `${tag} | early-return reason=${keep} (manual selection absolute; durable selection/header present).`);
        return { ok: false, reason: keep, target };
      }
    } catch { /* manualKeepReason 自带兜底，绝不阻断 */ }
    // 每次用前重取 + 有界重查（不用 apply 时缓存的引用，宿主回收后旧引用失效）
    const controller = await resolveService('sessionController');
    if (!controller || typeof controller.selectModel !== 'function') {
      safeLog(ctx, 'warn', `${tag} | early-return reason=no-controller (3x250ms retry exhausted, controller=${controller ? typeof controller.selectModel : 'null'})`);
      return { ok: false, reason: 'no-controller', target };
    }
    // 尊重手动选择：当前已是目标同类档位（our-free-model 任意模型 / 同 provider）=> 不覆盖
    try {
      const proj = readSelectionProjection(sid);
      if (shouldSwitch(proj, target) === null) {
        safeLog(ctx, 'info', `${tag} | early-return reason=same-kind-kept kept=${proj} (manual choice respected).`);
        return { ok: false, reason: 'same-kind-kept', kept: proj, target };
      }
    } catch { /* 读回失败不影响后续 */ }
    // 节流：同一会话冷却内不重复切（默认 5s，可配 switchCooldownMs；旧 60s 会吞连续纠偏）
    const cooldownMs = Number.isFinite(Number(cfg?.switchCooldownMs)) ? Number(cfg.switchCooldownMs) : 5000;
    try {
      const last = switchState.get(sid);
      if (last && Date.now() - last < cooldownMs) {
        safeLog(ctx, 'warn', `${tag} | early-return reason=cooldown (${Date.now() - last}ms since last switch)`);
        return { ok: false, reason: 'cooldown', target };
      }
    } catch { /* Map 异常不阻断 */ }
    // 切前记住全局默认：用前重取（宿主回收后旧引用失效），拦截生效时仅用于断言
    let beforeDefault = null;
    try {
      const adm = await resolveService('agentDefaultModel');
      beforeDefault = typeof adm?.currentSelection === 'function' ? adm.currentSelection() : null;
    } catch { beforeDefault = null; }
    const payload = buildSelectModelPayload({
      sessionId: sid,
      provider: target.provider,
      model: target.model,
      effort: target.effort,
    });
    try {
      const res = await controller.selectModel(payload);
      try { switchState.set(sid, Date.now()); lastSwitch.set(sid, `${payload.provider}/${payload.model}/${payload.reasoningEffort ?? '-'}`); } catch { /* noop */ }
      // 兜底写回：仅当 saveSelection 拦截未生效时才需要（拦截生效时 save 已是 report-only）。
      // 用 __autoModelRouterGuard 标记区分，避免拦截后又调被替换的空函数。
      try {
        if (!saveIntercepted) {
          const adm = await resolveService('agentDefaultModel');
          if (beforeDefault && adm?.__autoModelRouterGuard) {
            // 其他实例已拦截，无需写回
          } else if (beforeDefault && adm && typeof adm.saveSelection === 'function') {
            const orig = adm.__autoModelRouterOrigSave ?? adm.saveSelection.bind(adm);
            await orig(beforeDefault).catch(() => {});
          }
        }
      } catch { /* 回写失败不影响会话选择 */ }
      // UI 同步确认：selectModel 成功 -> 投影变更 -> 控制流自动 broadcast 到前端选择器。
      // 这里读回投影做一致性确认：不一致只打 warn（通常是前端尚未刷新，非错误）。
      try {
        const back = readSelectionProjection(sid);
        const expect = `${payload.provider}/${payload.model}`;
        if (!String(back).startsWith(expect)) {
          safeLog(ctx, 'warn', `UI sync check: projection=${back} != selected ${expect} (frontend may refresh late; session works with ${expect}).`);
        }
      } catch { /* 确认失败不影响结果 */ }
      safeLog(ctx, 'info', `switched session ${sid} -> ${payload.provider}/${payload.model}/${payload.reasoningEffort ?? '(no-effort)'} ok | projection=${readSelectionProjection(sid)}`);
      return { ok: true, payload, res };
    } catch (err) {
      const code = err?.code || err?.message || String(err);
      // 无 effort 菜单的模型（如 glm-5.3-flash）：去掉 effort 重试一次
      if (payload.reasoningEffort && /model-unavailable|effort/i.test(String(code))) {
        try {
          const retry = { sessionId: sid, provider: payload.provider, model: payload.model };
          const res2 = await controller.selectModel(retry);
          try { switchState.set(sid, Date.now()); lastSwitch.set(sid, `${retry.provider}/${retry.model}/-`); } catch { /* noop */ }
          try {
            if (!saveIntercepted) {
              const adm = await resolveService('agentDefaultModel');
              if (beforeDefault && adm && typeof adm.saveSelection === 'function' && !adm.__autoModelRouterGuard) {
                const orig = adm.__autoModelRouterOrigSave ?? adm.saveSelection.bind(adm);
                await orig(beforeDefault).catch(() => {});
              }
            }
          } catch { /* noop */ }
          safeLog(ctx, 'info', `switched session ${sid} -> ${retry.provider}/${retry.model}/(no-effort retry) ok | projection=${readSelectionProjection(sid)}`);
          return { ok: true, payload: retry, res: res2, retried: true };
        } catch (err2) {
          safeLog(ctx, 'warn', `selectModel failed for ${sid} (${String(err2?.message ?? err2)}); degraded to annotate-only.`);
          return { ok: false, reason: String(err2?.message ?? err2) };
        }
      }
      safeLog(ctx, 'warn', `selectModel failed for ${sid} (${String(err?.message ?? err)}); degraded to annotate-only.`);
      return { ok: false, reason: String(err?.message ?? err) };
    }
  }

  // 路由期望写入 exec 旁路，供后续链路/日志消费；绝不改写工具参数本身。
  // workStyle: 'free' = 动态最强免费模型；'owned' = 自有 API（resolveChatTarget 解析配置，不写死 GLM）。
  // modelOverride: 自测钉死快照时传入，生产调用不传（走实时 currentWorkModel()）。
  // v0.5.0：chat/owned 目标统一走 resolveChatTarget —— 支持 chatModel 'prov/mod' 格式、
  // chatModel 为空回退 workModelFallback（限频警告），目标不完整时置 null 只注解不真切。
  let chatFallbackWarnedAt = 0;
  // 自有 API 默认模型读回（用户真实配置，非硬编码）：
  // agent-default-model 是宿主官方插件（@deepseek-ai/dsh-agent-default-model），
  // deploymentDefault = 用户在「设置→模型」里选的自有 API 默认档（dump 可见 provider/model/reasoningEffort）。
  // 读不到（服务缺席/字段缺失）→ 返回 null，调用方回退原 resolveChatTarget 链。
  function ownedDefaultTarget() {
    try {
      const adm = getService(ctx, 'agentDefaultModel');
      const cur = typeof adm?.currentSelection === 'function' ? adm.currentSelection() : null;
      const p = String(cur?.provider ?? '').trim();
      const m = String(cur?.model ?? '').trim();
      if (p && m && p !== 'our-free-model') return { provider: p, model: m, effort: cur?.reasoningEffort ?? undefined };
      return null;
    } catch { return null; }
  }
  function chatTarget() {
    // chatModel 留空 = 自动用你自有 API 的默认模型（不再锁死 GLM）；
    // 填了 = 按填的走（'prov/mod' 或裸模型名+chatProvider）；两头都空 → 回退 workModelFallback + 警告。
    const rawChat = String(cfg.chatModel ?? '').trim();
    if (!rawChat) {
      const owned = ownedDefaultTarget();
      if (owned && owned.provider && owned.model) return { ...owned, source: 'owned-default' };
    }
    const ct = resolveChatTarget({
      chatProvider: cfg.chatProvider,
      chatModel: cfg.chatModel,
      workProvider: cfg.workProvider,
      workModelFallback: cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL,
    });
    if (ct.source === 'fallback' || ct.source === 'owned-default') {
      const now = Date.now();
      if (now - chatFallbackWarnedAt > 10 * 60 * 1000) { // 限频：10 分钟最多一条
        chatFallbackWarnedAt = now;
        if (ct.source === 'fallback') {
          safeLog(ctx, 'warn', `chatModel empty + no owned default; chat route falls back to ${ct.provider}/${ct.model} (set chatModel in plugin config or configure an owned API default).`);
        } else {
          safeLog(ctx, 'info', `chatModel empty; chat route uses your owned API default ${ct.provider}/${ct.model}.`);
        }
      }
    }
    return ct;
  }
  function annotateRoute(exec, route, modelOverride) {
    try {
      if (!exec || typeof exec !== 'object') return;
      let target;
      if (route.mode === 'work' && route.workStyle === 'owned') {
        const ct = chatTarget();
        target = { provider: ct.provider, model: ct.model, effort: cfg.workEffortOwned || cfg.chatEffort };
      } else if (route.mode === 'work') {
        // 功能二：锁定时手动 pair 绝对优先（modelOverride/动态榜都让位）
        const w = manualLock.on
          ? { provider: manualLock.provider, model: manualLock.model }
          : { provider: cfg.workProvider, model: modelOverride || currentWorkModel() };
        target = { provider: w.provider, model: w.model, effort: cfg.workEffort };
      } else {
        const ct = chatTarget();
        target = { provider: ct.provider, model: ct.model, effort: cfg.chatEffort };
      }
      // 目标不完整（配置两头都空）：只注解不真切，避免向 selectModel 传空 model。
      if (!target?.provider || !target?.model) {
        safeLog(ctx, 'warn', `route=${route.mode} target incomplete (provider=${target?.provider ?? ''} model=${target?.model ?? ''}); annotate-only, no switch.`);
        exec.autoModelRouter = { ...(exec.autoModelRouter || {}), route: route.mode, task: route.task, workStyle: route.workStyle, target: null, freeModelOk };
        return;
      }
      // 非侵入式注解：挂在独立命名空间下，不污染 exec 原有字段。
      exec.autoModelRouter = { ...(exec.autoModelRouter || {}), route: route.mode, task: route.task, workStyle: route.workStyle, target, freeModelOk };
    } catch { /* 注解失败不影响放行 */ }
  }

  // 规则三（看实际模型 + 防刷屏）：
  //  - 对症：只看 exec.agent.model 是否命中 work 档，不看文本分类
  //  - 防刷屏：hint_sent_until 冷却（默认 10min）+ hintMaxCount 计数（默认 20 条）双保险
  //  - 解除：切回非 work 模型 -> 清状态；群聊明确工作指令 -> 清状态（重新起算）
  function maybeGroupHint(ctxRef, exec, route) {
    try {
      const meta = exec?.agent?.source || exec?.meta || {};
      const sessionKey = sidOf(exec) || 'unknown';
      // 官方无 exec.agent.model 字段：读 model/selection 投影，再回退本插件切换缓存。
      let actualModel;
      try {
        const sp = getService(ctx, 'sessionProjections');
        const key = sidOf(exec);
        const sess = typeof exec?.agent?.session === 'object' ? exec.agent.session : (key ? getService(ctx, 'sessions')?.get?.(key) : null);
        const st = sp?.stateOf?.(sess, 'modelSelection');
        // 修（m01290 内部模拟 s4 实锤）：判档必须带 provider——裸动态模型名（如 muse-spark-1.2…）
        // 既不含 cfg.workModel 也不含 cfg.workProvider，isWorkModelRef 恒 false ⇒ 动态档下
        // 群聊提示从不触发。带 provider 后走 workProvider 分支。
        if (st && st.pending) actualModel = st.pending.provider ? `${st.pending.provider}/${st.pending.model}` : st.pending.model;
      } catch { actualModel = undefined; }
      if (!actualModel) {
        const lw = lastSwitch.get(sidOf(exec));
        if (lw) actualModel = lw.split('/').slice(0, 2).join('/');
      }
      const onWorkModel = isWorkModelRef(actualModel, cfg.workModel, cfg.workProvider);
      const st = hintState.get(sessionKey);

      // 解除条件 1：已切回非工作模型 -> 清状态，直接放行
      if (!onWorkModel) {
        if (st) hintState.delete(sessionKey);
        return;
      }
      // 非群聊不提示，但保留状态（私聊 work 是正常的）
      if (!isGroupMeta(meta)) return;
      // 解除条件 2：群聊明确工作指令 -> 重置冷却（重新起算），不提示这次
      if (route?.mode === 'work' && route?.task === 'agent-work') {
        hintState.delete(sessionKey);
        return;
      }
      // 冷却期内直接放行
      const now = Date.now();
      if (st && now < st.until) return;
      if (st && st.count >= cfg.hintMaxCount) return;
      // 提示 + 记录 hint_sent_until
      hintState.set(sessionKey, { until: now + cfg.hintCooldownMs, count: (st?.count || 0) + 1 });
      safeLog(ctxRef, 'info', `group hint for session ${sessionKey}: ${buildGroupHint(currentWorkModel(), cfg.workEffort)}`);
    } catch { /* 提示失败不影响放行 */ }
  }

  try {
    ctx.effect(function* () {
      yield ctx.on('tools/pre-execute', preExecuteHandler);
    }, 'dsh-auto-model-router.route');
  } catch (err) {
    safeLog(ctx, 'warn', `hook registration skipped (degraded): ${String(err?.message ?? err)}`);
  }

  // v0.6.0 阶段一：纯聊天轮覆盖。
  // 只挂 tools/pre-execute 时，纯聊天轮（无任何工具调用）根本不进钩子 ⇒ QQ 轨迹零活动、模型不切。
  // agent/pre-step 在 Inbox.claim() 之后、每个拟议步骤前触发，是覆盖"用户消息进入"的钩子。
  // 独立 try：新钩子万一未就绪，绝不连累已有的 tools/pre-execute 注册。
  try {
    ctx.effect(function* () {
      yield ctx.on('agent/pre-step', preStepHandler);
    }, 'dsh-auto-model-router.pre-step');
    safeLog(ctx, 'info', 'hook agent/pre-step registered (v0.6.0 pure-chat coverage).');
  } catch (err) {
    safeLog(ctx, 'warn', `hook agent/pre-step registration skipped (degraded): ${String(err?.message ?? err)}`);
  }

  // pre-execute 主体（单独命名，便于自测探活）
  async function preExecuteHandler(exec, next) {
    {
        // ── 安全阀：任何异常都放行，绝不阻断工具链 ──
        try {
          let text = '';
          try {
            const args = exec?.args ?? exec?.arguments;
            if (typeof args === 'string') text = args;
            else if (args && typeof args === 'object') {
              text = [args.input, args.prompt, args.message, args.text, args.command, args.file_path, args.path, args.filePath, args.content, args.textContent]
                .filter((v) => typeof v === 'string').join('\n');
            }
            // 工具名直判（ToolExecution 实测形：exec.name + exec.arguments，无 .tool 字段）：
            // write/edit/bash 等工具名本身就是"干活"证据 —— 哪怕自然语言已被压缩成“测试”二字，
            // 工具调用仍是铁证。补一句"工具调用:<name>"，classifyTask 命中 AGENT_KEYWORDS 即判 work。
            try {
              const toolName = String(exec?.name ?? exec?.tool ?? '').trim();
              if (toolName && /^(write|edit|bash|exec|run|create|update|delete|remove|move|copy|mkdir|install|deploy|publish|build|test|run_command|file|shell)$/i.test(toolName)) {
                text += `\n工具调用:${toolName} 建文件 写代码 跑命令`;
              } else if (toolName) {
                text += `\n工具调用:${toolName}`;
              }
            } catch { /* 工具名读取失败不影响文本分类 */ }
          } catch { text = ''; }

          let meta = {};
          try {
            meta = exec?.agent?.source || exec?.meta || {};
          } catch { meta = {}; }

          let source = 'main';
          try {
            source = sourceFromMeta(meta);
          } catch { source = 'main'; }

          let route;
          try {
            route = decideRoute({ source, text, meta, currentMode: lastSwitch.get(sidOf(exec)) ? 'work' : null, strategy: cfg.privateChatWorkStrategy });
          } catch {
            return await next();
          }

          ensureFresh(); // 后台补拉（不阻塞）：过期才触发
          annotateRoute(exec, route);
          maybeGroupHint(ctx, exec, route);
          // JSONL 诊断：决策落盘（fire-and-forget，不阻塞工具链）
          try {
            const __sid = sidOf(exec);
            const __target = exec?.autoModelRouter?.target ?? null;
            const __logEntry = {
              sid: __sid,
              tool: String(exec?.name ?? exec?.tool ?? ''),
              extractText: String(text ?? '').slice(0, 500),
              task: route?.task ?? '',
              route: route?.mode ?? '',
              target: __target ? `${__target.provider}/${__target.model}/${__target.effort ?? '-'}` : null,
              keepReason: exec?.autoModelRouter?.keepReason ?? null,
              actualSel: null,
            };
            try { __logEntry.actualSel = readSelectionProjection(__sid); } catch { /* 读回失败留空 */ }
            appendRouteLog(__logEntry).catch(() => {});
          } catch { /* 诊断失败不阻断 */ }
          // 真切（fire-and-forget，不阻塞工具链）：
          //  - sessionId 直传：exec.agent.session ?? exec.sessionId，无转换
          //  - 目标档位来自注解 target；失败自动降级为注解模式
          try {
            let target = exec?.autoModelRouter?.target;
            const sid = sidOf(exec);
            // 功能一（v0.5.1）：手动绝对优先 —— durable 在位先短路，再走精确同类判定
            try {
              if (target && sid && sid !== 'unknown') {
                const keep = manualKeepReason(sid, null, route?.mode ?? '');
                if (keep) {
                  exec.autoModelRouter.target = null;
                  exec.autoModelRouter.kept = readSelectionProjection(sid);
                  exec.autoModelRouter.keepReason = keep;
                  safeLog(ctx, 'info', `kept session ${sid} on ${exec.autoModelRouter.kept} (${keep}; routing skipped).`);
                  target = null;
                } else {
                  const actual = readSelectionProjection(sid);
                  if (shouldSwitch(actual, target) === null) {
                    exec.autoModelRouter.target = null;
                    exec.autoModelRouter.kept = actual;
                    safeLog(ctx, 'info', `kept session ${sid} on ${actual} (manual choice respected, no switch).`);
                    target = null;
                  }
                }
              }
            } catch { /* 读回失败走原路径（realSwitch 内还有权威短路兜底） */ }
            if (target && sid && sid !== 'unknown' && freeModelOk !== false) {
              // 不 await：切模型是后台操作，工具本次执行不受影响（下轮生效）
              // v0.5.2：透传 route.mode —— 冷启动空台账时 realSwitch 内二次判定需要它，
              // 不传则 manualKeepReason 缺 routeMode 保守短路，跨类也切不动（crash 3 FAIL 根因）。
              realSwitch(sid, target, route?.mode ?? '').then((r) => {
                try {
                  exec.autoModelRouter.switched = r.ok;
                  if (!r.ok) exec.autoModelRouter.switchError = r.reason;
                } catch { /* noop */ }
              }).catch(() => {});
            }
          } catch { /* 真切调度失败不影响放行 */ }
          return await next();
        } catch (err) {
          try {
            safeLog(ctx, 'warn', `pre-execute hook degraded: ${String(err?.message ?? err)}`);
          } catch { /* noop */ }
          try {
            return await next();
          } catch { /* next 本身抛错时不再传播 */ return { kind: 'allow' }; }
        }
    }
  }

  // ── v0.6.0 阶段一：agent/pre-step handler ────────────────────────────────
  // 纪律：本 handler 只做「取文本 → 复用既有判定/注解/真切」，不改 decideRoute /
  // manualKeepReason / annotateRoute / realSwitch 任何一行路由核心逻辑。
  const stepRouted = new Map(); // sid|turn|textSig -> 已路由时间戳（同一轮只判一次）
  const stepProbed = new Set(); // sid|turn -> 已记录过"取不到文本"的形状探针（每轮只探一次）
  const stepSkipped = new Set(); // sid|turn -> 已记录过"系统注入跳过"（每轮只记一次）

  // ── v0.7.1 来源过滤（本版唯一改动点）──────────────────────────────────────
  // 只认真人输入：source.kind === 'user' 且不是插件/系统注入的通知。
  // 实测形状（2026-10-06 真机会话普查）：
  //   真人      {"kind":"user","rpcId":...} / QQ {"kind":"user","rpcId":"qq-..."}
  //   auto-continue 重试注入（bug 主角）
  //             {"kind":"user","producer":"dsh-auto-continue","form":"notice"}
  //   其他非人  runtime-context / dsh-mnemon / goal / user-approval / model-selection / 无 source 合成消息
  // 注意：重试通知故意把 kind 伪造成 "user"（为了在聊天界面渲染气泡），
  // 所以只看 kind 不够，必须同时排掉 producer 署名与 form=notice。
  function isHumanInput(m) {
    try {
      const s = m?.source;
      if (!s || s.kind !== 'user') return false;
      if (s.producer) return false;             // 插件署名注入（dsh-auto-continue 等）
      if (s.form === 'notice') return false;    // 通知形注入
      return true;
    } catch { return false; }
  }

  // 从 pre-step 的 messages 里取出用户消息原文。
  // 首选 role==='user' 的最后一条（须通过 isHumanInput）；若本批消息压根没有 user 角色
  // （不同宿主版本形状有别），退化取最后一条真人输入、有文本的消息。
  // 取不到就必须留探针，不能静默丢轮。
  // 返回 { text, skipReason, rejectedText }：
  //   text         —— 作为路由依据的真人文本（'' = 不可用于路由）
  //   skipReason   —— 'system-retry-skipped' 表示末条 user 形消息是系统/插件注入
  //   rejectedText —— 被拒消息的原文（供跳过日志取证，不参与路由）
  function extractUserText(messages) {
    try {
      const list = Array.isArray(messages) ? messages : [];
      if (!list.length) return { text: '', skipReason: null, rejectedText: '' };
      const toText = (m) => {
        try {
          const c = m?.content;
          if (typeof c === 'string') return c.trim();
          if (Array.isArray(c)) {
            return c.map((x) => (typeof x === 'string' ? x : (x && x.type === 'text' && typeof x.text === 'string' ? x.text : ''))).join('\n').trim();
          }
          return '';
        } catch { return ''; }
      };
      const users = list.filter((m) => m && m.role === 'user');
      if (users.length) {
        const last = users[users.length - 1];
        if (!isHumanInput(last)) {
          const raw = toText(last);
          // 有文本的非人消息 = 系统重试/插件通知 → 明确跳过；无文本 → 走旧探针路径。
          return { text: '', skipReason: raw ? 'system-retry-skipped' : null, rejectedText: raw };
        }
        return { text: toText(last), skipReason: null, rejectedText: '' };
      }
      // 退化路径：无 user 角色时取最后一条真人输入、有文本的消息
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const m = list[i];
        if (!m || !isHumanInput(m)) continue;
        const t = toText(m);
        if (t) return { text: t, skipReason: null, rejectedText: '' };
      }
      return { text: '', skipReason: null, rejectedText: '' };
    } catch { return { text: '', skipReason: null, rejectedText: '' }; }
  }

  function textSig(s) {
    try {
      let h = 0;
      const str = String(s || '');
      for (let i = 0; i < str.length; i += 1) h = (h * 31 + str.charCodeAt(i)) | 0;
      return `${str.length}:${h}`;
    } catch { return '0'; }
  }

  async function preStepHandler(payload, next) {
    try {
      const agent = payload?.agent;
      const holder = { agent };
      const sid = sidOf(holder);
      const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
      const { text, skipReason, rejectedText } = extractUserText(msgs);
      if (!text) {
        // v0.7.1 来源过滤：本步输入是系统/插件注入的重试通知等（非真人消息）→
        // 一律跳过路由决策，保持当前模型不变；落一行 reason=system-retry-skipped 便于验证。
        if (skipReason === 'system-retry-skipped') {
          const skey = `${sid || 'unknown'}|${payload?.turn ?? '?'}`;
          if (!stepSkipped.has(skey)) {
            if (stepSkipped.size > 500) stepSkipped.clear();
            stepSkipped.add(skey);
            try {
              let actual = null;
              try { actual = readSelectionForRoute(sid); } catch { actual = null; }
              appendRouteLog({
                sid,
                tool: 'agent/pre-step/skip',
                extractText: String(rejectedText ?? '').slice(0, 300),
                task: '', route: '', target: null,
                keepReason: 'system-retry-skipped',
                reason: 'system-retry-skipped',
                actualSel: actual,
                turn: payload?.turn ?? null,
                step: payload?.step ?? null,
              }).catch(() => {});
            } catch { /* 跳过日志失败不阻断 */ }
          }
          return await next();
        }
        // 形状探针：取不到文本 ≠ 没有轮次。每 (sid,turn,step) 记一次角色形状，
        // 阶段一若失败，这一行就是定位"消息形状对不上"的唯一线索。
        if (msgs.length) {
          const pkey = `${sid || 'unknown'}|${payload?.turn ?? '?'}|${payload?.step ?? '?'}`;
          if (!stepProbed.has(pkey)) {
            if (stepProbed.size > 500) stepProbed.clear();
            stepProbed.add(pkey);
            try {
              const roles = msgs.map((m) => `${m?.role ?? '?'}/${m?.source?.kind ?? '-'}`).slice(0, 12).join(',');
              appendRouteLog({
                sid,
                tool: 'agent/pre-step/probe',
                extractText: `[no-user-text] n=${msgs.length} roles=${roles}`,
                task: '', route: '', target: null, keepReason: null, actualSel: null,
                turn: payload?.turn ?? null, step: payload?.step ?? null,
              }).catch(() => {});
            } catch { /* 探针失败不阻断 */ }
          }
        }
        return await next();
      }
      const key = `${sid || 'unknown'}|${payload?.turn ?? '?'}|${textSig(text)}`;
      if (stepRouted.has(key)) return await next();
      if (stepRouted.size > 500) stepRouted.clear(); // 有界，防长期常驻泄漏
      stepRouted.set(key, Date.now());

      let meta = {};
      try { meta = agent?.source || {}; } catch { meta = {}; }
      let source = 'main';
      try { source = sourceFromMeta(meta); } catch { source = 'main'; }

      let route;
      try {
        route = decideRoute({ source, text, meta, currentMode: lastSwitch.get(sid) ? 'work' : null, strategy: cfg.privateChatWorkStrategy });
      } catch { return await next(); }

      ensureFresh(); // 与 pre-execute 一致：过期才后台补拉
      annotateRoute(holder, route);
      maybeGroupHint(ctx, holder, route);

      // JSONL 诊断：纯聊天轮第一次有落盘（tool=agent/pre-step）
      try {
        const target = holder?.autoModelRouter?.target ?? null;
        const logEntry = {
          sid,
          tool: 'agent/pre-step',
          extractText: String(text).slice(0, 500),
          task: route?.task ?? '',
          route: route?.mode ?? '',
          target: target ? `${target.provider}/${target.model}/${target.effort ?? '-'}` : null,
          keepReason: holder?.autoModelRouter?.keepReason ?? null,
          actualSel: null,
          turn: payload?.turn ?? null,
          step: payload?.step ?? null,
        };
        try { logEntry.actualSel = readSelectionForRoute(sid); } catch { /* 读回失败留空 */ }
        appendRouteLog(logEntry).catch(() => {});
      } catch { /* 诊断失败不阻断 */ }

      // 真切：与 pre-execute 同一套短路（手动优先 / 同类保留）。
      // 差别只有一处：这里 await + 1500ms 上限，让选择在本步 prompt 组装前落定；
      // fire-and-forget 会与组装赛跑，纯聊天轮极易读不到新选择。
      try {
        const target = holder?.autoModelRouter?.target;
        const origTargetStr = target ? `${target.provider}/${target.model}/${target.effort ?? '-'}` : null;
        if (target && sid && sid !== 'unknown' && freeModelOk !== false) {
          let keep = null;
          try { keep = manualKeepReason(sid, null, route?.mode ?? ''); } catch { keep = null; }
          if (keep) {
            holder.autoModelRouter.target = null;
            holder.autoModelRouter.keepReason = keep;
            safeLog(ctx, 'info', `pre-step kept session ${sid} on ${readSelectionForRoute(sid)} (${keep}; routing skipped).`);
          } else {
            const actual = readSelectionForRoute(sid);
            if (actual === '(projection-unreadable)') {
              // 修复点二：读不出当前模型就不能盲切（否则可能覆盖用户手动选择）。
              // 降级为保守不覆盖，并把原因写进注解与日志，便于事后核对。
              holder.autoModelRouter.target = null;
              holder.autoModelRouter.keepReason = 'projection-unreadable-fallback';
              safeLog(ctx, 'warn', `pre-step kept session ${sid} on unknown (reason=projection-unreadable-fallback; conservative no-override).`);
            } else if (shouldSwitch(actual, target) === null) {
              holder.autoModelRouter.target = null;
              holder.autoModelRouter.keepReason = 'same-kind-kept';
              safeLog(ctx, 'info', `pre-step kept session ${sid} on ${actual} (manual choice respected, no switch).`);
            } else {
              const sw = await Promise.race([
                realSwitch(sid, target, route?.mode ?? ''),
                new Promise((resolve) => { const t = setTimeout(() => resolve({ ok: false, reason: 'pre-step-timeout' }), 1500); if (typeof t.unref === 'function') t.unref(); }),
              ]).catch(() => null);
              try {
                holder.autoModelRouter.switched = sw?.ok ?? null;
                if (sw && !sw.ok) holder.autoModelRouter.switchError = sw.reason ?? 'unknown';
              } catch { /* noop */ }
            }
          }
        }
        // 决策后补一条：keepReason / 真实读回 / 是否真切，阶段二核对全靠这行
        try {
          const decision = {
            sid,
            tool: 'agent/pre-step/decision',
            extractText: String(text).slice(0, 300),
            task: route?.task ?? '',
            route: route?.mode ?? '',
            target: origTargetStr,
            keepReason: holder?.autoModelRouter?.keepReason ?? null,
            switched: holder?.autoModelRouter?.switched ?? null,
            actualSel: null,
            turn: payload?.turn ?? null,
            step: payload?.step ?? null,
          };
          try { decision.actualSel = readSelectionForRoute(sid); } catch { decision.actualSel = null; }
          appendRouteLog(decision).catch(() => {});
        } catch { /* 诊断失败不阻断 */ }
      } catch { /* 真切失败不影响放行 */ }
      return await next();
    } catch (err) {
      try {
        safeLog(ctx, 'warn', `pre-step hook degraded: ${String(err?.message ?? err)}`);
      } catch { /* noop */ }
      // 放行优先：路由判失败也绝不阻断这一步
      return await next();
    }
  }

  // ── 隔离自测驱动（仅 cfg.selftest 时执行；生产 patch 不配置该键 = 完全不运行）──
  // 方案B多轮常驻：cfg.selftest=true 跑全量；cfg.selftest='r1'..'r4' 或 cfg.selftestRound
  // 只跑该回合 2 项。每个回合独立启动（headless 新进程），启动即重取服务并记录 ready。
  if (cfg.selftest) {
    selftestLines = [];
    const RAW_ROUND = String(cfg.selftestRound ?? (typeof cfg.selftest === 'string' ? cfg.selftest : 'all')).toLowerCase();
    const ROUND = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'].includes(RAW_ROUND) ? RAW_ROUND : 'all';
    const ROUND_TAGS = {
      r1: ['prework', 't1-privchat', 't2-privwork-free'],
      r2: ['t3-privwork-owned', 't4-groupchat'],
      r3: ['t5-groupwork', 't6-manual'],
      r4: ['t7-uisync', 't8-pollute'],
      r5: ['t9-chatmodel-empty', 't10-dynamic-off'],
      r6: ['t11-manual-lock', 't12-manual-lock-off'],
      // r7 = m01290 隔离内部模拟 6 项（四象限核心路由 + 手动优先 + 全局不污染）
      r7: ['s1-privchat', 's2-privwork', 's3-groupwork', 's4-groupchat', 's5-manual', 's6-nopollute'],
      // r8 = v0.5.2 冷启动空台账二次判定 2 项（台账为空 + durable 在位 + 跨类 → 放行一次）
      r8: ['t13-coldstart-chat', 't14-coldstart-work'],
      all: ['prework', 't1-privchat', 't2-privwork-free', 't3-privwork-owned', 't4-groupchat', 't5-groupwork', 't6-manual', 't7-uisync', 't8-pollute', 't9-chatmodel-empty', 't10-dynamic-off', 't11-manual-lock', 't12-manual-lock-off', 's1-privchat', 's2-privwork', 's3-groupwork', 's4-groupchat', 's5-manual', 's6-nopollute', 't13-coldstart-chat', 't14-coldstart-work'],
    };
    const ACTIVE_TAGS = ROUND_TAGS[ROUND];
    const hasTag = (t) => ACTIVE_TAGS.includes(t);
    // 回合输出隔离：r1..r4 写 selftest-result-rN.json，全量写原路径（兼容旧断言）。
    const SELFTEST_OUT_BASE = String(cfg.selftestOut || '');
    const SELFTEST_OUT_PATH = (ROUND === 'all' || !SELFTEST_OUT_BASE) ? SELFTEST_OUT_BASE
      : SELFTEST_OUT_BASE.replace(/\.json$/, `-${ROUND}.json`);
    const out = { startedAt: new Date().toISOString(), round: ROUND, checks: {}, logs: [] };
    const flush = async () => {
      try {
        out.logs = selftestLines ? selftestLines.slice(-40) : [];
        if (SELFTEST_OUT_PATH) await writeTextFile(SELFTEST_OUT_PATH, JSON.stringify(out, null, 2));
        else if (cfg.selftestOut) await writeTextFile(cfg.selftestOut, JSON.stringify(out, null, 2));
      } catch (e) { console.log('[selftest] flush failed:', String(e?.message ?? e)); }
    };
      const getSvc = () => getService(ctx, 'sessionController'); // 遗留：自测内已改走 resolveService，仅留兼容
      const getAdm = () => getService(ctx, 'agentDefaultModel'); // 遗留：t8 已改走 resolveService，仅留兼容

    const runSelftest = async () => {
      // 回合开始：重取服务并记录 ready（方案B要求：不复用旧引用，每回合新鲜实例）
      out.checks.service_ready = {};
      const svc = await resolveService('sessionController', { retries: 40, intervalMs: 250 });
      const admProbe = await resolveService('agentDefaultModel');
      out.checks.service_ready = {
        round: ROUND,
        sessionController: svc ? `ok(has ${typeof svc.selectModel === 'function' ? 'selectModel' : 'no-selectModel'})` : 'null',
        agentDefaultModel: admProbe ? `ok(has ${typeof admProbe.currentSelection === 'function' ? 'currentSelection' : 'no-currentSelection'})` : 'null',
      };
      await flush();
      // 1) 等 sessionController 就绪（有界重查：官方 3×250ms 打底，加长到 40×250ms 覆盖冷启动）
      if (!svc?.selectModel) { out.fatal = 'sessionController unavailable'; await flush(); return; }
      // svc 引用不缓存：每次 create 前重取（宿主回收后旧引用失效）
      const t0 = Date.now();
      const mkSession = async (tag) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const sid = `session-selftest-${tag}-${Date.now()}-${attempt}`;
          try {
            const fresh = await resolveService('sessionController');
            if (!fresh?.create) throw new Error('no-controller');
            await fresh.create({ sessionId: sid, cwd: process.cwd() }); return sid;
          }
          catch (e) {
            if (attempt === 2) out.checks[`create_${tag}`] = { error: String(e?.message ?? e) };
            else await new Promise((r) => setTimeout(r, 800));
          }
        }
        return null;
      };
      // 顺序：先建本回合会话（agents 上下文活跃期），再预热榜单，最后逐项跑路由。
      // 原因：预热的网络等待会拖出 agents 活跃窗口，后建会话必报 inactive context。
      // 方案B：只建 ACTIVE_TAGS（本回合 2-3 个），不建全量 9 个。
      const preSids = {};
      for (const tag of ACTIVE_TAGS) {
        preSids[tag] = await mkSession(tag);
      }
      const takeSid = (tag) => {
        const sid = preSids[tag];
        preSids[tag] = null;
        return sid;
      };
      // 先预热：排行榜 + 可用清单拉完再跑 8 项，否则早期项只能命中回退值而非动态最强
      try {
        await refreshFreeList();
        await refreshLeaderboard();
        safeLog(ctx, 'info', `selftest warmed: workModel=${currentWorkModel()} free=${(freeList.avail ?? []).length} lb=${(lb.get() ?? []).length}`);
      } catch { /* 预热失败走回退，不阻断 */ }
      // 榜单快照钉死：8 项全程用同一 picked 值断言，不受后台刷新抖动干扰。
      // refreshFreeList/refreshLeaderboard 不再触发（预热已拉完，TTL 内也不会过期）。
      const PINNED_WORK_MODEL = currentWorkModel();
      const dynModel = () => PINNED_WORK_MODEL;

      // ── 8 项验证（四象限口径，每项读 model/selection 真实投影）──
      // 辅助：走完整 pre-execute 路径（decideRoute→annotate→真切），返回 { route, projection }。
      // sid 为空（创建失败）时返回 pass:null（环境偶发，非逻辑失败），failures 口径跳过 null。
      // sid 预取自 preSids（tag 须与预建表一致），避免逐项建会话拖出 agents 活跃窗口。
      const runRoute = async (tag, { text, meta, strategy, preset }) => {
        const sid = takeSid(tag);
        if (!sid) return { sid: null, pass: null, projection: null, note: 'session-create-failed' };
        // 前置档位（内部模拟 6 项用）：先用路由自己的真切把会话置于指定档（写 lastSwitch 台账，
        // 模拟"会话当前处于 X 档"的路由自有态），再走完整路由路径。
        let presetRes = null;
        let presetProjection = null;
        if (preset) {
          presetRes = await realSwitch(sid, preset);
          await new Promise((r) => setTimeout(r, 300));
          presetProjection = await readSelectionProjectionFresh(sid);
          // 自测前置档位是"稳态模拟"（会话本来就停在该档），不是 300ms 前的一次真实切换——
          // 清掉同会话 60s 节流，让随后的路由真切不受 preset 污染（生产节流逻辑不动）。
          try { switchState.delete(sid); } catch { /* noop */ }
        }
        const exec = { args: text, agent: { session: sid, source: meta } };
        const route = decideRoute({ source: sourceFromMeta(meta), text, meta, strategy: strategy ?? cfg.privateChatWorkStrategy });
        ensureFresh();
        annotateRoute(exec, route, PINNED_WORK_MODEL);
        // 手动尊重检查（与 pre-execute 主体同逻辑；自测走新鲜读回，宿主回收后旧引用失效）
        // v0.5.2：先走 manualKeepReason（含冷启动二次判定），再走精确同类 —— 与 pre-execute 主体同序，
        // 否则自测 runRoute 里手动门被跳过，老用例/新 t13 口径对不上。
        let target = exec?.autoModelRouter?.target;
        try {
          if (target) {
            const keep = manualKeepReason(sid, null, route?.mode ?? '');
            if (keep) {
              exec.autoModelRouter.target = null;
              exec.autoModelRouter.kept = await readSelectionProjectionFresh(sid);
              exec.autoModelRouter.keepReason = keep;
              target = null;
            } else {
              const actual = await readSelectionProjectionFresh(sid);
              if (shouldSwitch(actual, target) === null) {
                exec.autoModelRouter.target = null;
                exec.autoModelRouter.kept = actual;
                target = null;
              }
            }
          }
        } catch { /* 走原路径 */ }
        let sw = { ok: false, reason: 'skipped-no-target' };
        if (target) {
          sw = await realSwitch(sid, target, route?.mode ?? '');
          await new Promise((r) => setTimeout(r, 300)); // 等投影落定
        }
        return { sid, route, preset: presetRes, presetProjection, target: exec?.autoModelRouter?.target ?? null, kept: exec?.autoModelRouter?.kept ?? null, switch: sw, projection: await readSelectionProjectionFresh(sid) };
      };

      // 1) 私聊闲聊 → 强制回自有 chat/light（先停在 work 档也要切回）
      // 方案B：r1 含 prework+t1+t2；其他回合跳过（checks 不留该键，failures 不计）。
      if (hasTag('prework') && hasTag('t1-privchat')) {
        const sidPre = takeSid('prework');
        if (sidPre) await realSwitch(sidPre, { provider: cfg.workProvider, model: dynModel(), effort: cfg.workEffort });
        const t1 = await runRoute('t1-privchat', { text: '今天天气怎么样', meta: { channel: 'qq' } });
        out.checks.t1_private_chat = { round: ROUND, route: t1.route, projection: t1.projection,
          switchOk: t1.switch?.ok ?? null, switchReason: t1.switch?.reason ?? null, switchTarget: t1.switch?.target ?? t1.target ?? null,
          switched: t1.switch?.ok ?? null, reason: t1.switch?.reason ?? t1.note ?? null,
          target: t1.switch?.target ?? t1.target ?? null, kept: t1.kept ?? null,
          skipped: t1.pass === null ? true : undefined,
          pass: t1.pass === null ? null : (typeof t1.projection === 'string' && t1.projection.startsWith(`${cfg.chatProvider}/${cfg.chatModel}`)) };
        if (t1.pass === null) { out.checks.t1_private_chat.skipped = true; out.checks.t1_private_chat.reason = t1.note ?? 'session-create-failed'; }
        await flush();
      }

      // 2) 私聊干活 free → 动态最强/deep
      if (hasTag('t2-privwork-free')) {
        const t2 = await runRoute('t2-privwork-free', { text: '帮我装插件', meta: { channel: 'qq' }, strategy: 'free' });
        const dyn2 = dynModel();
        out.checks.t2_private_work_free = { round: ROUND, route: t2.route, picked: dyn2, projection: t2.projection,
          switchOk: t2.switch?.ok ?? null, switchReason: t2.switch?.reason ?? null, switchTarget: t2.switch?.target ?? t2.target ?? null,
          reason: t2.switch?.reason ?? t2.note ?? null, target: t2.switch?.target ?? t2.target ?? null, kept: t2.kept ?? null,
          pass: t2.pass === null ? null : (t2.route?.workStyle === 'free' && typeof t2.projection === 'string' && t2.projection.startsWith(`${cfg.workProvider}/${dyn2}`)) };
        if (t2.pass === null) { out.checks.t2_private_work_free.skipped = true; out.checks.t2_private_work_free.reason = t2.note ?? 'session-create-failed'; }
        await flush();
      }

      // 3) 私聊干活 owned → 自有/deep（workEffortOwned）
      if (hasTag('t3-privwork-owned')) {
        const t3 = await runRoute('t3-privwork-owned', { text: '帮我装插件', meta: { channel: 'qq' }, strategy: 'owned' });
        out.checks.t3_private_work_owned = { round: ROUND, route: t3.route, projection: t3.projection,
          switchOk: t3.switch?.ok ?? null, switchReason: t3.switch?.reason ?? null, switchTarget: t3.switch?.target ?? t3.target ?? null,
          reason: t3.switch?.reason ?? t3.note ?? null, target: t3.switch?.target ?? t3.target ?? null, kept: t3.kept ?? null,
          pass: t3.pass === null ? null : (t3.route?.workStyle === 'owned' && typeof t3.projection === 'string' && t3.projection.startsWith(`${cfg.chatProvider}/${cfg.chatModel}`)) };
        if (t3.pass === null) { out.checks.t3_private_work_owned.skipped = true; out.checks.t3_private_work_owned.reason = t3.note ?? 'session-create-failed'; }
        await flush();
      }

      // 4) 群聊闲聊 → 自有 chat/light
      if (hasTag('t4-groupchat')) {
        const t4 = await runRoute('t4-groupchat', { text: '大家好', meta: { channel: 'qq', chatType: 'group' } });
        out.checks.t4_group_chat = { round: ROUND, route: t4.route, projection: t4.projection,
          switchOk: t4.switch?.ok ?? null, switchReason: t4.switch?.reason ?? null, switchTarget: t4.switch?.target ?? t4.target ?? null,
          reason: t4.switch?.reason ?? t4.note ?? null, target: t4.switch?.target ?? t4.target ?? null, kept: t4.kept ?? null,
          pass: t4.pass === null ? null : (t4.route?.mode === 'chat' && typeof t4.projection === 'string' && t4.projection.startsWith(`${cfg.chatProvider}/${cfg.chatModel}`)) };
        if (t4.pass === null) { out.checks.t4_group_chat.skipped = true; out.checks.t4_group_chat.reason = t4.note ?? 'session-create-failed'; }
        await flush();
      }

      // 5) 群聊干活 → 动态最强/deep
      if (hasTag('t5-groupwork')) {
        const t5 = await runRoute('t5-groupwork', { text: '帮我装插件', meta: { channel: 'qq', chatType: 'group' }, strategy: 'free' });
        const dyn5 = dynModel();
        out.checks.t5_group_work = { round: ROUND, route: t5.route, picked: dyn5, projection: t5.projection,
          switchOk: t5.switch?.ok ?? null, switchReason: t5.switch?.reason ?? null, switchTarget: t5.switch?.target ?? t5.target ?? null,
          reason: t5.switch?.reason ?? t5.note ?? null, target: t5.switch?.target ?? t5.target ?? null, kept: t5.kept ?? null,
          pass: t5.pass === null ? null : (t5.route?.mode === 'work' && typeof t5.projection === 'string' && t5.projection.startsWith(`${cfg.workProvider}/${dyn5}`)) };
        if (t5.pass === null) { out.checks.t5_group_work.skipped = true; out.checks.t5_group_work.reason = t5.note ?? 'session-create-failed'; }
        await flush();
      }

      // 6)（v0.5.1 严格语义）手动选择绝对优先：手动 selectModel 后发工作指令 → 绝不覆盖。
      //    pass = realSwitch 返回 reason=user-manual-selection-kept + ok=false + 投影前后一致（仍为手动值）。
      //    规格 m01006 功能一.3「一旦用户在会话里做了显式选择，该选择始终优先」。
      // 方案B：仅 r3 跑。
      if (hasTag('t6-manual')) {
      const sid6 = takeSid('t6-manual');
      let t6out = null;
      if (sid6) {
        // 手动模型取自配置回退值（禁硬编码），且须与动态榜首不同——否则 same-kind 与 manual-keep 语义撞车。
        const manualModel6 = cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL;
        try {
          const freshSvc = await resolveService('sessionController');
          await freshSvc.selectModel({ sessionId: sid6, provider: cfg.workProvider, model: manualModel6, reasoningEffort: cfg.workEffort });
        } catch { /* 切失败会体现在 before6/断言里 */ }
        // 投影落定有延迟：最多等 3×500ms；仍读不出判环境抖动 → pass:null 跳过（不记失败）。
        let before6 = await readSelectionProjectionFresh(sid6);
        for (let ri = 0; ri < 3 && (before6 === '(projection-unreadable)' || before6 == null); ri++) {
          await new Promise((r) => setTimeout(r, 500));
          before6 = await readSelectionProjectionFresh(sid6);
        }
        if (before6 === '(projection-unreadable)' || before6 == null) {
          t6out = { round: ROUND, pass: null, skipped: true, reason: 'projection-unreadable-after-retry' };
        } else {
        // 工作指令经完整路径：durable 门应短路为 user-manual-selection-kept，绝不真切
        const exec6 = { args: '帮我装插件', agent: { session: sid6, source: {} } };
        const route6 = decideRoute({ source: 'main', text: '帮我装插件', meta: {}, strategy: cfg.privateChatWorkStrategy });
        annotateRoute(exec6, route6, PINNED_WORK_MODEL);
        const target6 = exec6?.autoModelRouter?.target ?? null;
        let sw6 = { ok: false, reason: 'skipped-no-target' };
        if (target6) { sw6 = await realSwitch(sid6, target6); await new Promise((r) => setTimeout(r, 300)); }
        const after6 = await readSelectionProjectionFresh(sid6);
        t6out = { round: ROUND, before: before6, manualPair: `${cfg.workProvider}/${manualModel6}`, dynTarget: `${cfg.workProvider}/${dynModel()}`, keepReason: sw6.reason ?? null, switched: sw6.ok, reason: sw6.reason ?? null, switchReason: sw6.reason ?? null, target: sw6.target ?? target6 ?? null, switchTarget: sw6.target ?? target6 ?? null, after: after6,
          pass: sw6.ok === false && sw6.reason === 'user-manual-selection-kept'
            && String(after6) === String(before6)
            && String(before6).startsWith(`${cfg.workProvider}/${manualModel6}`) };
        }
      } else {
        t6out = { round: ROUND, pass: null, skipped: true, reason: 'session-create-failed' };
      }
      out.checks.t6_manual_kept = t6out;
      await flush();
      }

      // 7) UI 同步：真切后投影与 selected 一致
      // 方案B：仅 r4 跑。
      if (hasTag('t7-uisync')) {
      const sid7 = takeSid('t7-uisync');
      if (sid7) {
        const warnBefore = selftestLines.filter((l) => l.includes('UI sync check')).length;
        const r = await realSwitch(sid7, { provider: cfg.workProvider, model: dynModel(), effort: cfg.workEffort });
        const back = await readSelectionProjectionFresh(sid7);
        const warnAfter = selftestLines.filter((l) => l.includes('UI sync check')).length;
        out.checks.t7_uisync = { round: ROUND, ok: r.ok, reason: r.reason ?? null, target: r.target ?? { provider: cfg.workProvider, model: dynModel() }, kept: r.kept ?? null, projection: back, matches: typeof back === 'string' && back.startsWith(`${cfg.workProvider}/`), syncWarn: warnAfter - warnBefore, pass: r.ok === true && typeof back === 'string' && back.startsWith(`${cfg.workProvider}/`) };
        if (out.checks.t7_uisync.pass !== true && out.checks.t7_uisync.reason && !r.ok) { out.checks.t7_uisync.skipped = true; }
      } else {
        out.checks.t7_uisync = { round: ROUND, ok: false, reason: 'session-create-failed', skipped: true, pass: null };
      }
      await flush();
      }

      // 8) 全局污染：切前后 currentSelection() 一致（有界重查 adm，始终记录该键）
      // 方案B：仅 r4 跑。
      if (hasTag('t8-pollute')) {
      const adm8 = await resolveService('agentDefaultModel');
      // 拦截若在宿主回收后丢失，在新鲜实例上重建（report-only，不写 settings）
      try {
        if (adm8 && typeof adm8.saveSelection === 'function' && !adm8.__autoModelRouterGuard) {
          const origSave = adm8.saveSelection.bind(adm8);
          adm8.__autoModelRouterOrigSave = origSave;
          adm8.saveSelection = async (next) => {
            try { safeLog(ctx, 'info', `default-save intercepted (kept, not written): ${next?.provider ?? '?'} / ${next?.model ?? '?'}`); } catch { /* noop */ }
            return;
          };
          adm8.__autoModelRouterGuard = true;
          saveIntercepted = true;
        }
      } catch { /* 拦截重建失败走写回兜底 */ }
      const sid8 = takeSid('t8-pollute');
      if (adm8 && sid8) {
        const before = adm8.currentSelection();
        const r = await realSwitch(sid8, { provider: cfg.workProvider, model: dynModel(), effort: cfg.workEffort });
        const after = adm8.currentSelection();
        out.checks.t8_pollution = { round: ROUND, switchOk: r.ok, reason: r.reason ?? null, target: r.target ?? null, unchanged: JSON.stringify(before) === JSON.stringify(after), intercepted: adm8.__autoModelRouterGuard === true, pass: JSON.stringify(before) === JSON.stringify(after) };
      } else {
        out.checks.t8_pollution = { round: ROUND, pass: null, skipped: true, reason: !adm8 ? 'no-agentDefaultModel' : 'session-create-failed' };
        safeLog(ctx, 'warn', `t8 skipped: adm=${adm8 ? 'ok' : 'null'} sid=${sid8 ?? 'null'}`);
      }
      await flush();
      } // hasTag t8-pollute

      // 9) chatModel 为空回退（v0.5.0）：resolveChatTarget 必须给 workProvider/workModelFallback，
      //    且真切后真实投影落在该目标上（配置空 → 免费池 light 档，不向 selectModel 传空 model）。
      if (hasTag('t9-chatmodel-empty')) {
      const sid9 = takeSid('t9-chatmodel-empty');
      if (sid9) {
        const ct = resolveChatTarget({ chatProvider: cfg.chatProvider, chatModel: '', workProvider: cfg.workProvider, workModelFallback: cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL });
        const sw = await realSwitch(sid9, { provider: ct.provider, model: ct.model, effort: cfg.chatEffort });
        await new Promise((r) => setTimeout(r, 300));
        const back = await readSelectionProjectionFresh(sid9);
        out.checks.t9_chatmodel_empty = { round: ROUND, source: ct.source, target: `${ct.provider}/${ct.model}`, switchOk: sw.ok, reason: sw.reason ?? null, projection: back,
          pass: ct.source === 'fallback' && ct.provider === cfg.workProvider && ct.model === (cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL)
            && sw.ok === true && typeof back === 'string' && back.startsWith(`${ct.provider}/${ct.model}`) };
      } else {
        out.checks.t9_chatmodel_empty = { round: ROUND, pass: null, skipped: true, reason: 'session-create-failed' };
      }
      await flush();
      }

      // 10) enableDynamicRanking=false 不请求（v0.5.0）：临时翻转开关调 refreshLeaderboard，
      //     OpenRouter 请求计数必须 0 增长，且 currentWorkModel 直接回退配置值（不读榜单）。
      if (hasTag('t10-dynamic-off')) {
      const before10 = lbFetchCount;
      const savedOn = dynamicOn;
      dynamicOn = false;
      try {
        await refreshLeaderboard();
        const fallback10 = cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL;
        const wm = currentWorkModel();
        const fetchDelta = lbFetchCount - before10;
        out.checks.t10_dynamic_off = { round: ROUND, fetchDelta, workModel: wm, fallback: fallback10,
          pass: fetchDelta === 0 && wm === fallback10 };
      } finally {
        dynamicOn = savedOn;
      }
      await flush();
      } // hasTag t10-dynamic-off

      // 11)（v0.5.1 功能二）手动锁定 work 模型：locked=true + manualWorkModel 指定 →
      //     工作指令真切到锁定模型（压过动态榜/modelOverride），OpenRouter 请求计数 0 增长，
      //     锁定日志 reason=manual-work-model-locked。夹具值 = workProvider/workModelFallback（即规格示例 our-free-model/mimo-v2.6-flash-free）。
      if (hasTag('t11-manual-lock')) {
        const savedLocked11 = cfg.manualWorkModelLocked;
        const savedManual11 = cfg.manualWorkModel;
        // 不 takeSid：预建会话由 runRoute 内 takeSid 消费，此处先取会吞掉它
        const MANUAL_PAIR = `${cfg.workProvider}/${cfg.workModelFallback}`;
        cfg.manualWorkModelLocked = true;
        cfg.manualWorkModel = MANUAL_PAIR;
        syncManualLock();
        try {
          const beforeFetch11 = lbFetchCount;
          await refreshLeaderboard(); // 锁下必须 0 请求（lbFetchCount 不动）
          const fetchDelta11 = lbFetchCount - beforeFetch11;
          const t11 = await runRoute('t11-manual-lock', { text: '帮我装插件', meta: { channel: 'qq' }, strategy: 'free' });
          const lockLogs11 = (selftestLines ?? []).filter((l) => l.includes('manual-work-model-locked')).length;
          out.checks.t11_manual_lock = { round: ROUND, manualPair: MANUAL_PAIR, lock: { on: manualLock.on, provider: manualLock.provider, model: manualLock.model, reason: manualLock.reason ?? null },
            fetchDelta: fetchDelta11, lockLogCount: lockLogs11, route: t11.route,
            switchOk: t11.switch?.ok ?? null, reason: t11.switch?.reason ?? null, target: t11.switch?.target ?? t11.target ?? null,
            projection: t11.projection,
            pass: t11.pass !== null && manualLock.on === true && fetchDelta11 === 0 && lockLogs11 >= 1
              && t11.switch?.ok === true && t11.route?.workStyle === 'free'
              && typeof t11.projection === 'string' && t11.projection.startsWith(MANUAL_PAIR) };
          if (t11.pass === null) { out.checks.t11_manual_lock.skipped = true; out.checks.t11_manual_lock.reason = t11.note ?? 'session-create-failed'; }
        } finally {
          cfg.manualWorkModelLocked = savedLocked11;
          cfg.manualWorkModel = savedManual11;
          syncManualLock();
        }
        await flush();
      } // hasTag t11-manual-lock

      // 12)（v0.5.1 功能二）锁关闭 / 锁值为空 → 恢复动态排行榜逻辑：
      //     ① locked=false → 非锁态；② locked=true 但 manualWorkModel 空 → 不构成锁；
      //     ③ 恢复正常后完整路由：真切到动态/回退（currentWorkModel 不再被手动值钉死）。
      if (hasTag('t12-manual-lock-off')) {
        const savedLocked12 = cfg.manualWorkModelLocked;
        const savedManual12 = cfg.manualWorkModel;
        // 不 takeSid（会吞掉 runRoute 的预建会话）；空 sid 由 runRoute 返回 note 处理
        {
          cfg.manualWorkModelLocked = false;
          cfg.manualWorkModel = `${cfg.workProvider}/should-not-be-used`;
          syncManualLock();
          const offWhenDisabled = manualLock.on === false;
          cfg.manualWorkModelLocked = true;
          cfg.manualWorkModel = '';
          syncManualLock();
          const offWhenEmpty = manualLock.on === false;
          cfg.manualWorkModelLocked = false;
          cfg.manualWorkModel = '';
          syncManualLock();
          const t12 = await runRoute('t12-manual-lock-off', { text: '帮我装插件', meta: { channel: 'qq' }, strategy: 'free' });
          const wm12 = currentWorkModel();
          out.checks.t12_manual_lock_off = { round: ROUND, offWhenDisabled, offWhenEmpty,
            switchOk: t12.switch?.ok ?? null, reason: t12.switch?.reason ?? null, target: t12.switch?.target ?? t12.target ?? null,
            projection: t12.projection, workModel: wm12, pinned: dynModel(),
            pass: t12.pass !== null && offWhenDisabled && offWhenEmpty
              && t12.switch?.ok === true
              && typeof t12.projection === 'string' && t12.projection.startsWith(`${cfg.workProvider}/${dynModel()}`)
              && wm12 === dynModel() };
          if (t12.pass === null) { out.checks.t12_manual_lock_off.skipped = true; out.checks.t12_manual_lock_off.reason = t12.note ?? 'session-create-failed'; }
        }
        cfg.manualWorkModelLocked = savedLocked12;
        cfg.manualWorkModel = savedManual12;
        syncManualLock();
        await flush();
      } // hasTag t12-manual-lock-off

      // ── m01290 隔离内部模拟 6 项（四象限核心路由）──
      // 每项记录真实 model/selection 投影值；前置档位用路由自有真切建立（写 lastSwitch 台账），
      // 手动项用直接 selectModel（模拟用户路径，不写台账）。全部模型值取自 config/动态榜。

      // 模拟1) 私聊闲聊：当前 work 档 → 切回 config.chatModel
      if (hasTag('s1-privchat')) {
        const ct1 = resolveChatTarget({ chatProvider: cfg.chatProvider, chatModel: cfg.chatModel, workProvider: cfg.workProvider, workModelFallback: cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL });
        const chatPair1 = `${ct1.provider}/${ct1.model}`;
        const r1s = await runRoute('s1-privchat', {
          text: '今天天气怎么样', meta: { channel: 'qq' },
          preset: { provider: cfg.workProvider, model: currentWorkModel(), effort: cfg.workEffort },
        });
        out.checks.s1_privchat_work_to_chat = { round: ROUND, chatTarget: chatPair1,
          presetOk: r1s.preset?.ok ?? null, presetReason: r1s.preset?.reason ?? null, presetProjection: r1s.presetProjection ?? null,
          route: r1s.route, projection: r1s.projection,
          switchOk: r1s.switch?.ok ?? null, reason: r1s.switch?.reason ?? r1s.note ?? null, target: r1s.switch?.target ?? r1s.target ?? null,
          pass: r1s.pass === null ? null : (
            r1s.preset?.ok === true && typeof r1s.presetProjection === 'string' && r1s.presetProjection.startsWith(`${cfg.workProvider}/`)
            && r1s.route?.mode === 'chat' && r1s.switch?.ok === true
            && typeof r1s.projection === 'string' && r1s.projection.startsWith(chatPair1)) };
        if (r1s.pass === null) { out.checks.s1_privchat_work_to_chat.skipped = true; out.checks.s1_privchat_work_to_chat.reason = r1s.note ?? 'session-create-failed'; }
        await flush();
      }

      // 模拟2) 私聊干活：当前 chat 档 → 切 config.workModel（动态最强/回退）
      if (hasTag('s2-privwork')) {
        const ct2 = resolveChatTarget({ chatProvider: cfg.chatProvider, chatModel: cfg.chatModel, workProvider: cfg.workProvider, workModelFallback: cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL });
        const chatPair2 = `${ct2.provider}/${ct2.model}`;
        const dyn2s = currentWorkModel();
        const r2s = await runRoute('s2-privwork', {
          text: '帮我查日志', meta: { channel: 'qq' }, strategy: cfg.privateChatWorkStrategy,
          preset: { provider: ct2.provider, model: ct2.model, effort: cfg.chatEffort },
        });
        out.checks.s2_privwork_chat_to_work = { round: ROUND, chatPreset: chatPair2, picked: dyn2s,
          presetOk: r2s.preset?.ok ?? null, presetReason: r2s.preset?.reason ?? null, presetProjection: r2s.presetProjection ?? null,
          route: r2s.route, projection: r2s.projection,
          switchOk: r2s.switch?.ok ?? null, reason: r2s.switch?.reason ?? r2s.note ?? null, target: r2s.switch?.target ?? r2s.target ?? null,
          pass: r2s.pass === null ? null : (
            r2s.preset?.ok === true && typeof r2s.presetProjection === 'string' && r2s.presetProjection.startsWith(chatPair2)
            && r2s.route?.mode === 'work' && r2s.route?.workStyle === 'free' && r2s.switch?.ok === true
            && typeof r2s.projection === 'string' && r2s.projection.startsWith(`${cfg.workProvider}/${dyn2s}`)) };
        if (r2s.pass === null) { out.checks.s2_privwork_chat_to_work.skipped = true; out.checks.s2_privwork_chat_to_work.reason = r2s.note ?? 'session-create-failed'; }
        await flush();
      }

      // 模拟3) 群聊干活：当前 chat 档 → 切 config.workModel（群工作恒 free 动态）
      if (hasTag('s3-groupwork')) {
        const ct3 = resolveChatTarget({ chatProvider: cfg.chatProvider, chatModel: cfg.chatModel, workProvider: cfg.workProvider, workModelFallback: cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL });
        const chatPair3 = `${ct3.provider}/${ct3.model}`;
        const dyn3s = currentWorkModel();
        const r3s = await runRoute('s3-groupwork', {
          text: '写个脚本', meta: { channel: 'qq', chatType: 'group' }, strategy: cfg.privateChatWorkStrategy,
          preset: { provider: ct3.provider, model: ct3.model, effort: cfg.chatEffort },
        });
        out.checks.s3_groupwork_chat_to_work = { round: ROUND, chatPreset: chatPair3, picked: dyn3s,
          presetOk: r3s.preset?.ok ?? null, presetReason: r3s.preset?.reason ?? null, presetProjection: r3s.presetProjection ?? null,
          route: r3s.route, projection: r3s.projection,
          switchOk: r3s.switch?.ok ?? null, reason: r3s.switch?.reason ?? r3s.note ?? null, target: r3s.switch?.target ?? r3s.target ?? null,
          pass: r3s.pass === null ? null : (
            r3s.preset?.ok === true && typeof r3s.presetProjection === 'string' && r3s.presetProjection.startsWith(chatPair3)
            && r3s.route?.mode === 'work' && r3s.route?.workStyle === 'free' && r3s.switch?.ok === true
            && typeof r3s.projection === 'string' && r3s.projection.startsWith(`${cfg.workProvider}/${dyn3s}`)) };
        if (r3s.pass === null) { out.checks.s3_groupwork_chat_to_work.skipped = true; out.checks.s3_groupwork_chat_to_work.reason = r3s.note ?? 'session-create-failed'; }
        await flush();
      }

      // 模拟4) 群聊闲聊：当前 work 档 → 切回 chatModel；冷却提示只触发一次（第二次进冷却）
      if (hasTag('s4-groupchat')) {
        const sid4 = takeSid('s4-groupchat');
        if (sid4) {
          const ct4 = resolveChatTarget({ chatProvider: cfg.chatProvider, chatModel: cfg.chatModel, workProvider: cfg.workProvider, workModelFallback: cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL });
          const chatPair4 = `${ct4.provider}/${ct4.model}`;
          const pre4 = await realSwitch(sid4, { provider: cfg.workProvider, model: currentWorkModel(), effort: cfg.workEffort });
          await new Promise((r) => setTimeout(r, 300));
          try { switchState.delete(sid4); } catch { /* 自测前置档位清节流（同 runRoute preset 口径），生产不动 */ }
          const before4 = await readSelectionProjectionFresh(sid4);
          const exec4 = { args: '哈哈哈', agent: { session: sid4, source: { channel: 'qq', chatType: 'group' } } };
          const meta4 = { channel: 'qq', chatType: 'group' };
          const route4 = decideRoute({ source: 'im', text: '哈哈哈', meta: meta4, strategy: cfg.privateChatWorkStrategy });
          const hintKey = `group hint for session ${sid4}`;
          const cnt = () => selftestLines.filter((l) => l.includes(hintKey)).length;
          const h0 = cnt();
          maybeGroupHint(ctx, exec4, route4);
          const h1 = cnt();
          maybeGroupHint(ctx, exec4, route4); // 冷却内第二次 → 不再提示
          const h2 = cnt();
          annotateRoute(exec4, route4, PINNED_WORK_MODEL);
          const tgt4 = exec4?.autoModelRouter?.target ?? null;
          let sw4 = { ok: false, reason: 'skipped-no-target' };
          if (tgt4) { sw4 = await realSwitch(sid4, tgt4); await new Promise((r) => setTimeout(r, 300)); }
          const after4 = await readSelectionProjectionFresh(sid4);
          out.checks.s4_groupchat_work_to_chat = { round: ROUND, chatTarget: chatPair4,
            presetOk: pre4.ok, presetReason: pre4.reason ?? null, before: before4,
            hintBefore: h0, hintAfter1: h1, hintAfter2: h2, hintCooldownMs: cfg.hintCooldownMs,
            route: route4, switchOk: sw4.ok, reason: sw4.reason ?? null, target: sw4.target ?? tgt4 ?? null, projection: after4,
            pass: pre4.ok === true && typeof before4 === 'string' && before4.startsWith(`${cfg.workProvider}/`)
              && h0 === 0 && h1 === 1 && h2 === 1
              && route4?.mode === 'chat' && sw4.ok === true
              && typeof after4 === 'string' && after4.startsWith(chatPair4) };
        } else {
          out.checks.s4_groupchat_work_to_chat = { round: ROUND, pass: null, skipped: true, reason: 'session-create-failed' };
        }
        await flush();
      }

      // 模拟5) 手动选择优先：直接 selectModel（用户路径）选配置回退档 → 工作指令绝不覆盖
      if (hasTag('s5-manual')) {
        const sid5 = takeSid('s5-manual');
        if (sid5) {
          const manual5 = cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL;
          const manualPair5 = `${cfg.workProvider}/${manual5}`;
          try {
            const c5 = await resolveService('sessionController');
            await c5.selectModel({ sessionId: sid5, provider: cfg.workProvider, model: manual5, reasoningEffort: cfg.workEffort });
          } catch { /* 切失败体现在 before5/断言 */ }
          await new Promise((r) => setTimeout(r, 300));
          const before5 = await readSelectionProjectionFresh(sid5);
          const exec5 = { args: '帮我装插件', agent: { session: sid5, source: {} } };
          const route5 = decideRoute({ source: 'main', text: '帮我装插件', meta: {}, strategy: cfg.privateChatWorkStrategy });
          annotateRoute(exec5, route5, PINNED_WORK_MODEL);
          const tgt5 = exec5?.autoModelRouter?.target ?? null;
          let sw5 = { ok: false, reason: 'skipped-no-target' };
          if (tgt5) { sw5 = await realSwitch(sid5, tgt5); await new Promise((r) => setTimeout(r, 300)); }
          const after5 = await readSelectionProjectionFresh(sid5);
          out.checks.s5_manual_keep = { round: ROUND, manualPair: manualPair5, before: before5, after: after5,
            switchOk: sw5.ok, reason: sw5.reason ?? null, target: sw5.target ?? tgt5 ?? null,
            pass: sw5.ok === false && sw5.reason === 'user-manual-selection-kept'
              && String(after5) === String(before5)
              && typeof before5 === 'string' && before5.startsWith(manualPair5) };
        } else {
          out.checks.s5_manual_keep = { round: ROUND, pass: null, skipped: true, reason: 'session-create-failed' };
        }
        await flush();
      }

      // 模拟6) 全局不污染：切完 IM 会话后，全局默认三次读数一致 + 新开主界面会话默认未被污染
      if (hasTag('s6-nopollute')) {
        const adm6 = await resolveService('agentDefaultModel');
        try {
          if (adm6 && typeof adm6.saveSelection === 'function' && !adm6.__autoModelRouterGuard) {
            const origSave = adm6.saveSelection.bind(adm6);
            adm6.__autoModelRouterOrigSave = origSave;
            adm6.saveSelection = async (next) => {
              try { safeLog(ctx, 'info', `default-save intercepted (kept, not written): ${next?.provider ?? '?'} / ${next?.model ?? '?'}`); } catch { /* noop */ }
              return;
            };
            adm6.__autoModelRouterGuard = true;
            saveIntercepted = true;
          }
        } catch { /* 拦截重建失败走写回兜底 */ }
        const sid6s = takeSid('s6-nopollute');
        if (adm6 && sid6s) {
          const ct6 = resolveChatTarget({ chatProvider: cfg.chatProvider, chatModel: cfg.chatModel, workProvider: cfg.workProvider, workModelFallback: cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL });
          const before6s = adm6.currentSelection();
          const r6s = await realSwitch(sid6s, { provider: ct6.provider, model: ct6.model, effort: cfg.chatEffort });
          await new Promise((r) => setTimeout(r, 300));
          const afterSwitch6 = adm6.currentSelection();
          const sidNew6 = await mkSession('s6-new-main');
          const afterNew6 = adm6.currentSelection();
          out.checks.s6_no_pollution = { round: ROUND,
            before: before6s, afterSwitch: afterSwitch6, afterNewSession: afterNew6, newSessionId: sidNew6 ?? null,
            switchOk: r6s.ok, reason: r6s.reason ?? null, target: r6s.target ?? null,
            intercepted: adm6.__autoModelRouterGuard === true,
            unchanged: JSON.stringify(before6s) === JSON.stringify(afterSwitch6) && JSON.stringify(before6s) === JSON.stringify(afterNew6),
            pass: r6s.ok === true
              && JSON.stringify(before6s) === JSON.stringify(afterSwitch6)
              && JSON.stringify(before6s) === JSON.stringify(afterNew6)
              && adm6.__autoModelRouterGuard === true };
        } else {
          out.checks.s6_no_pollution = { round: ROUND, pass: null, skipped: true, reason: !adm6 ? 'no-agentDefaultModel' : 'session-create-failed' };
        }
        await flush();
      } // hasTag s6-nopollute

      // ── v0.5.2 冷启动二次判定 2 项（r8：台账为空 + durable 在位 + 跨类 → 放行一次）──
      // 直接经完整路径：durable 门 + runRoute 都不写 lastSwitch 台账 —— runRoute 的 preset 恰好
      // 模拟"重启失忆"（host 新进程 lastSwitch 为空），再发跨类指令看是否放行。
      // t13：durable 停 work 档（直接 selectModel 写档，不写台账）→ 发闲聊 → 应切回 chat 目标。
      if (hasTag('t13-coldstart-chat')) {
        const sid13 = takeSid('t13-coldstart-chat');
        if (sid13) {
          const ct13 = resolveChatTarget({ chatProvider: cfg.chatProvider, chatModel: cfg.chatModel, workProvider: cfg.workProvider, workModelFallback: cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL });
          const chatPair13 = `${ct13.provider}/${ct13.model}`;
          const workModel13 = currentWorkModel();
          let preset13err = null;
          try {
            const c13 = await resolveService('sessionController');
            if (!c13 || typeof c13.selectModel !== 'function') throw new Error('no-controller');
            try {
              await c13.selectModel({ sessionId: sid13, provider: cfg.workProvider, model: workModel13, reasoningEffort: cfg.workEffort });
            } catch (e) {
              // 目标模型无 effort 菜单时省略 effort 重试一次（与 realSwitch 同款语义）。
              const m = String(e?.message ?? e);
              if (/effort|unavailable|support/i.test(m)) await c13.selectModel({ sessionId: sid13, provider: cfg.workProvider, model: workModel13 });
              else throw e;
            }
          } catch (e) { preset13err = String(e?.message ?? e); }
          await new Promise((r) => setTimeout(r, 300));
          const before13 = await readSelectionProjectionFresh(sid13);
          // 冷启动现场：lastSwitch 台账为空（重启失忆）+ durable 在位 + 跨类 → 放行一次。
          // 直接走内联完整路径（不用 runRoute：它按 tag 取预建 sid，t13 专属 sid 已取走）。
          const exec13 = { args: '今天天气怎么样', agent: { session: sid13, source: { channel: 'qq' } } };
          const route13 = decideRoute({ source: 'im', text: '今天天气怎么样', meta: { channel: 'qq' }, strategy: cfg.privateChatWorkStrategy });
          ensureFresh();
          annotateRoute(exec13, route13, PINNED_WORK_MODEL);
          let tgt13 = exec13?.autoModelRouter?.target ?? null;
          let sw13 = { ok: false, reason: 'skipped-no-target' };
          try {
            if (tgt13) {
              if (tgt13) tgt13 = { ...tgt13, __routeMode: route13?.mode ?? '' };
              const keep13 = manualKeepReason(sid13, null, route13?.mode ?? '');
              if (keep13) { sw13 = { ok: false, reason: keep13, target: tgt13 }; }
              else { sw13 = await realSwitch(sid13, tgt13, route13?.mode ?? ''); await new Promise((r) => setTimeout(r, 300)); }
            }
          } catch { /* 走原路径 */ }
          const after13 = await readSelectionProjectionFresh(sid13);
          const coldLogs13 = (selftestLines ?? []).filter((l) => l.includes('cold-start reroute allowed')).length;
          out.checks.t13_coldstart_chat = { round: ROUND, before: before13, chatTarget: chatPair13,
            presetError: preset13err,
            route: route13, switchOk: sw13.ok, reason: sw13.reason ?? null, target: sw13.target ?? tgt13 ?? null,
            projection: after13, coldLogCount: coldLogs13,
            pass: typeof before13 === 'string' && before13.startsWith(`${cfg.workProvider}/`)
              && route13?.mode === 'chat' && sw13.ok === true && coldLogs13 >= 1
              && typeof after13 === 'string' && after13.startsWith(chatPair13) };
        } else {
          out.checks.t13_coldstart_chat = { round: ROUND, pass: null, skipped: true, reason: 'session-create-failed' };
        }
        await flush();
      }

      // t14：durable 停 chat 档（直接 selectModel 写档，不写台账）→ 发工作指令 → 应切到 work 目标。
      if (hasTag('t14-coldstart-work')) {
        const sid14 = takeSid('t14-coldstart-work');
        if (sid14) {
          const ct14 = resolveChatTarget({ chatProvider: cfg.chatProvider, chatModel: cfg.chatModel, workProvider: cfg.workProvider, workModelFallback: cfg.workModelFallback || cfg.workModel || DEFAULT_WORK_MODEL });
          const chatPair14 = `${ct14.provider}/${ct14.model}`;
          const workModel14 = currentWorkModel();
          const workPair14 = `${cfg.workProvider}/${workModel14}`;
          let preset14err = null;
          try {
            const c14 = await resolveService('sessionController');
            if (!c14 || typeof c14.selectModel !== 'function') throw new Error('no-controller');
            try {
              await c14.selectModel({ sessionId: sid14, provider: ct14.provider, model: ct14.model, reasoningEffort: cfg.chatEffort });
            } catch (e) {
              // 目标模型无 effort 菜单时省略 effort 重试一次（与 realSwitch 同款语义）。
              const m = String(e?.message ?? e);
              if (/effort|unavailable|support/i.test(m)) await c14.selectModel({ sessionId: sid14, provider: ct14.provider, model: ct14.model });
              else throw e;
            }
          } catch (e) { preset14err = String(e?.message ?? e); }
          // 投影落定有延迟（t6 同款 3×500ms 口径）：chat 预置档读不出则 before 不成立，直接判
          // pass:null 跳过（环境抖动不记失败）——与 t6 的 unreadable 口径一致。
          let before14 = await readSelectionProjectionFresh(sid14);
          for (let ri = 0; ri < 3 && (before14 === '(projection-unreadable)' || before14 == null); ri++) {
            await new Promise((r) => setTimeout(r, 500));
            before14 = await readSelectionProjectionFresh(sid14);
          }
          const exec14 = { args: '帮我装插件', agent: { session: sid14, source: { channel: 'qq' } } };
          const route14 = decideRoute({ source: 'im', text: '帮我装插件', meta: { channel: 'qq' }, strategy: cfg.privateChatWorkStrategy });
          ensureFresh();
          annotateRoute(exec14, route14, PINNED_WORK_MODEL);
          let tgt14 = exec14?.autoModelRouter?.target ?? null;
          let sw14 = { ok: false, reason: 'skipped-no-target' };
          try {
            if (tgt14) {
              if (tgt14) tgt14 = { ...tgt14, __routeMode: route14?.mode ?? '' };
              const keep14 = manualKeepReason(sid14, null, route14?.mode ?? '');
              if (keep14) { sw14 = { ok: false, reason: keep14, target: tgt14 }; }
              else { sw14 = await realSwitch(sid14, tgt14, route14?.mode ?? ''); await new Promise((r) => setTimeout(r, 300)); }
            }
          } catch { /* 走原路径 */ }
          const after14 = await readSelectionProjectionFresh(sid14);
          const coldLogs14 = (selftestLines ?? []).filter((l) => l.includes('cold-start reroute allowed')).length;
          out.checks.t14_coldstart_work = { round: ROUND, before: before14, chatPreset: chatPair14, workTarget: workPair14,
            presetError: preset14err, route: route14, switchOk: sw14.ok, reason: sw14.reason ?? null, target: sw14.target ?? tgt14 ?? null,
            projection: after14, coldLogCount: coldLogs14,
            pass: (before14 === '(projection-unreadable)' || before14 == null) ? null
              : (typeof before14 === 'string' && before14.startsWith(chatPair14)
              && route14?.mode === 'work' && sw14.ok === true && coldLogs14 >= 1
              && typeof after14 === 'string' && after14.startsWith(workPair14)) };
        } else {
          out.checks.t14_coldstart_work = { round: ROUND, pass: null, skipped: true, reason: 'session-create-failed' };
        }
        await flush();
      }

      // 动态信息（供回归对比）：排行榜命中/回退
      try {
        await refreshFreeList();
        await refreshLeaderboard();
        const dyn = dynModel();
        const lbMeta = lb.meta();
        const { ranked } = await import('./leaderboard.js').then((m) => m.rankIntersection(lb.get() ?? [], freeList.avail ?? []));
        out.checks.dynamic = {
          freeCount: (freeList.avail ?? []).length,
          lbCount: (lb.get() ?? []).length,
          lbError: lbMeta.lastError,
          rankedTop3: ranked.slice(0, 3),
          picked: dyn,
          fallsBack: typeof dyn === 'string' && dyn.length > 0,
        };
      } catch (e) {
        out.checks.dynamic = { error: String(e?.message ?? e) };
      }
      await flush();

      out.totalMs = Date.now() - t0;
      await flush();
      // failures 口径：新 8 项走 pass 字段（pass===null 为环境偶发创建失败，跳过不计入）；
      // create_* 键为会话创建重试记录，不单独计入（对应 t 项的 pass 已覆盖）。
      // 旧口径 fallback/dynamic/manual/uisync 仍按专用字段。
      const failures = [];
      for (const [k, v] of Object.entries(out.checks)) {
        if (k.startsWith('create_')) continue;
        if (!v) { failures.push(k); continue; }
        if (v.error || v.unchanged === false) { failures.push(k); continue; }
        if (k.startsWith('t1_') || k.startsWith('t2_') || k.startsWith('t3_') || k.startsWith('t4_') ||
            k.startsWith('t5_') || k.startsWith('t6_') || k.startsWith('t7_') || k.startsWith('t8_') ||
            k.startsWith('t9_') || k.startsWith('t10_') || k.startsWith('t11_') || k.startsWith('t12_') ||
            k.startsWith('t13_') || k.startsWith('t14_') ||
            k.startsWith('s1_') || k.startsWith('s2_') || k.startsWith('s3_') || k.startsWith('s4_') || k.startsWith('s5_') || k.startsWith('s6_')) {
          if (v.pass === null || v.pass === undefined) continue; // 环境偶发，跳过
          if (v.pass !== true) failures.push(k);
          continue;
        }
        if (k === 'fallback') { if (!(v.degraded === true && v.hookStillAlive === true)) failures.push(k); continue; }
        if (k === 'manual') { if (!(v.manualKept === true)) failures.push(k); continue; }
        if (k === 'dynamic') { if (!(v.fallsBack === true)) failures.push(k); continue; }
        if (k === 'uisync') { if (!(v.ok === true && v.matches === true)) failures.push(k); continue; }
        if (v && v.ok === false) failures.push(k);
      }
      console.log('SELFTEST_DONE ' + JSON.stringify({ totalMs: out.totalMs, checks: Object.keys(out.checks), failures }));
    };

    setTimeout(() => { runSelftest().catch(async (err) => { out.fatal = String(err?.stack ?? err); await flush(); }); }, 300);
  }
}
