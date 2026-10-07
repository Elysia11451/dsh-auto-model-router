/**
 * dsh-auto-model-router (host half, v0.8.6 — 按域拆分后的组合根).
 *
 * 按会话来源在 tools/pre-execute 链路上做路由决策：
 *  Rule 1 (IM 聊天)  -> 旁路放行 + 记录期望 chat 档（不阻断）
 *  Rule 2 (Agent 工作)-> 旁路放行 + 记录期望 work 档（不阻断）
 *  Rule 3 (群聊提示) -> 命中时在日志中给出切换提示（节流），不阻断
 *
 * 安全阀（防崩溃）：
 *  - apply() 内只做同步注册，不做网络/文件等长阻塞操作
 *  - pre-execute / pre-step 处理器全程 try...catch，任何异常都 return next() 放行
 *  - 所有分支都以 return next() / return downstream 收尾，不留短路路径
 *  - ctx.effect 包裹注册，卸载时自动注销
 *  - free-model 缺失时降级为纯日志模式，不抛错
 *
 * v0.8.6 拆分铁律：本文件只做「Config + buildCfg/reloadCfg + 装配 + 包导出面」。
 *  业务逻辑全部住在域目录，跨域一律经 deps 注入，不互引实现。
 */
import Schema from '@deepseek-ai/schemastery';
// routing-policy：判定纯函数 + 状态机 + 领域实例
import { isGroupMeta, sourceFromMeta, classifyTask } from './routing-policy/impl/classifier.js';
import {
  DEFAULTS, normalizeEffortForSwitch, parseManualWorkLock, createDecider, decideRoute,
  resolveChatTarget, isColdStartCrossKind, isUnknownDrift, isSameKind, buildSelectModelPayload,
} from './routing-policy/impl/decider.js';
import { createSessionModeStore, MODE_CHANGED_EVENT } from './routing-policy/impl/session-mode.js';
import { createPreExecuteHandler } from './routing-policy/impl/pre-execute.js';
import { createPreStepHandler } from './routing-policy/impl/pre-step.js';
// leaderboard：动态选模节拍
import { DEFAULT_WORK_MODEL } from './leaderboard/leaderboard.js';
import { createLeaderboardRefresh } from './leaderboard/impl/refresh.js';
// switch-controller：真切 / 冷却 / 保存守卫
import { createCooldown } from './switch-controller/impl/cooldown.js';
import { createSaveGuard } from './switch-controller/impl/save-guard.js';
import { createRealSwitch } from './switch-controller/impl/real-switch.js';
// first-turn：首轮模式建立与弹窗
import { establishFirstTurnState } from './first-turn/impl/prompt.js';
// telemetry：诊断落盘与升降档事件
import { createRouteLog } from './telemetry/impl/route-log.js';
import { createModeEventHandler } from './telemetry/impl/mode-event.js';
// 隔离自测（仅 cfg.selftest 时运行）
import { startSelftest } from './selftest/driver.js';
// v0.5.1: schemastery 改为静态真导入（规格红线：禁 stub/裸对象）。
//   依赖解析：@deepseek-ai/schemastery + @standard-schema/spec + @deepseek-ai/cosmokit
//   已 vendor 进工作区 node_modules（fuse 盘不支持 symlink，实拷贝），import 走真实路径。

export const name = 'dsh-auto-model-router';
// 移动端规范强制 inject = ['tools', 'llm']（多写会导致 PENDING）。
// sessionController / agentDefaultModel 只走 ctx.get 可选获取，缺席时降级为注解模式。
export const inject = ['tools', 'llm'];
// v0.7.5: 设置页命名空间 = profile entry id（Host 用 entry id 自动识别，不再自报）。
export const SETTINGS_NAMESPACE = 'auto-model-router';

// ── 插件配置（设置 → 插件 → 插件配置 自动投影成表单）──
// v0.7.5：全部用户字段 .volatile()（Host 只为含 volatile 字段的 entry 提供表单），
//   运维键彻底删除（方案a），旧 patch 残留由 DEFAULTS 兜底；自测键 hidden 不进表单。
// description({zh,en}) 首句写死条件语义（§4 按不支持档做，全量展示+静默忽略）。
export const Config = Schema.object({
  // —— 分组 A · 基础（默认展开，enabled 置顶）——
  enabled: Schema.boolean().default(true).volatile()
    .description({ zh: '总开关。关闭后插件只记日志不切换模型', en: 'Master switch. When off, the plugin only logs and never switches models' }),
  priorityMode: Schema.union(['manual', 'auto']).default('manual').volatile()
    .description({ zh: '手动优先：你在模型选择器里手动选的永远不动；路由优先：插件判该切就切', en: 'Manual-first: your manual selection always wins; Auto-first: the router switches whenever it decides' }),
  // —— 分组 B · Work 档（默认展开）——
  workMode: Schema.union(['manual', 'auto']).default('auto').volatile()
    .description({ zh: '手动：固定用下方填的模型，不跑排行榜；自动：动态榜 + 降级链自动挑', en: 'Manual: pin the model below, no ranking; Auto: dynamic ranking + fallback chain' }),
  manualWorkModel: Schema.string().default('').volatile()
    .description({ zh: '仅手动模式生效。格式 provider/model，留空等于没锁', en: 'Only used in manual mode. Format provider/model; empty means unlocked' }),
  workModelPriority: Schema.array(Schema.string()).default(['mimo-v2.6-flash-free', 'glm-5.3-flash', 'deepseek-v4.1-flash']).volatile()
    .description({ zh: '仅自动模式生效。动态榜不可用时按序挑可用者，全不中回退兜底', en: 'Only used in auto mode. Ordered fallback chain when ranking is unavailable' }),
  workModelFallback: Schema.string().default('mimo-v2.6-flash-free').volatile()
    .description({ zh: '仅自动模式生效。链上全不中时的最后一兜底（裸模型名）', en: 'Only used in auto mode. Last resort when the whole chain misses' }),
  enableDynamicRanking: Schema.boolean().default(true).volatile()
    .description({ zh: '仅自动模式生效。开：抓 OpenRouter 榜；关：直接走静态链，一次请求都不发', en: 'Only used in auto mode. On: fetch OpenRouter ranking; off: static chain only, zero requests' }),
  rankingRefreshSeconds: Schema.number().default(3600).min(30).max(3600).volatile()
    .description({ zh: '仅自动+开启动态榜时生效。排行榜刷新间隔（秒，30-3600）', en: 'Only used when auto mode + ranking on. Ranking refresh interval in seconds (30-3600)' }),
  // —— 分组 C · Chat 档（默认展开）——
  chatMode: Schema.union(['manual', 'auto']).default('auto').volatile()
    .description({ zh: '手动：固定用下方填的自有 API 模型；自动：按下方降级链从便宜到贵挑', en: 'Manual: pin your owned-API model below; Auto: walk the chain below from cheapest upward' }),
  manualChatModel: Schema.string().default('').volatile()
    .description({ zh: '仅手动模式生效。格式 provider/model；裸模型名配你自己的 provider；留空回退兜底并打警告', en: 'Only used in manual mode. provider/model; bare name pairs with your provider; empty falls back with a warning' }),
  chatModelPriority: Schema.array(Schema.string()).default([]).volatile()
    .description({ zh: '仅自动模式生效。请填入你自己的 API 模型，格式 provider/model，按成本从低到高排序。留空则回退免费池并打警告', en: 'Only used in auto mode. Fill in your own API models as provider/model, cheapest first. Empty falls back to the free pool with a warning' }),
  // —— 分组 D · 群聊（默认折叠，高级）——
  enableGroupHint: Schema.boolean().default(false).volatile()
    .description({ zh: '群聊工作模型提示。默认关（防打扰）；开后 work 档群聊发一次切换提示', en: 'Group work-model hint. Off by default to avoid noise' }),
  hintCooldownMs: Schema.number().default(300000).volatile()
    .description({ zh: '提示冷却（毫秒）。群聊提示发一次后多久内不再发', en: 'Hint cooldown in ms' }),
  // —— 分组 E · 状态机（默认折叠，高级）——
  switchCooldownMs: Schema.number().default(5000).volatile()
    .description({ zh: '同一会话连续切换冷却（毫秒）。切得太频繁被吞时调小', en: 'Per-session switch cooldown in ms; lower it when rapid switches get swallowed' }),
  reclaimUnknownModel: Schema.boolean().default(true).volatile()
    .description({ zh: '未知漂移纠偏。开：当前模型既非聊天目标也非干活配置时强制放回路由目标；关：不认识就不动', en: 'Reclaim unknown drift. On: force back to route target; off: leave unknown models alone' }),
  // —— 分组 F · 首轮弹窗（v0.8.0，默认展开）——
  firstTurnPrompt: Schema.boolean().default(true).volatile()
    .description({ zh: '首轮弹窗选择模式。开：新会话首条真人消息弹窗选 Chat/Work；关：默认 Chat 档不弹窗', en: 'First-turn mode prompt. On: ask Chat/Work on new session first message; off: default chat, no prompt' }),
  firstTurnPromptTimeoutMs: Schema.number().default(60000).volatile()
    .description({ zh: '首轮弹窗超时（毫秒）。超时回退默认 Chat 档', en: 'First-turn prompt timeout in ms; falls back to chat on timeout' }),
  // —— 隐藏键（隔离自测专用，非 volatile + hidden，不进表单）——
  selftest: Schema.union([Schema.boolean(), Schema.string()]).default(false).hidden(true)
    .description({ zh: '隔离自测开关（仅隔离环境配置；生产不配置该键）', en: 'Isolation selftest switch (isolated env only; not set in production)' }),
  selftestRound: Schema.string().default('').hidden(true)
    .description({ zh: '自测回合（r1..r6/all）', en: 'Selftest round (r1..r6/all)' }),
  selftestOut: Schema.string().default('').hidden(true)
    .description({ zh: '自测结果输出路径', en: 'Selftest result output path' }),
});

// v0.7.5: 默认导出（loader unwrapExports 归一化 ESM/CJS 形态；具名导出保留，单测直引不受影响）。
export default { name, inject, Config, apply, SETTINGS_NAMESPACE };

// selftest 门控（cfg.selftest）时捕获 safeLog 输出，供隔离验证断言；生产为 null 不生效。
// 稳定容器：自测驱动（src/selftest/driver.js）写 capture.lines，safeLog 持续推入同一数组。
const selftestCapture = { lines: null };

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
    try { if (selftestCapture.lines) selftestCapture.lines.push(`${level}: ${msg}`); } catch { /* noop */ }
  } catch { /* logger 不可用时静默 */ }
}

export function apply(ctx, config = {}) {
  // v0.7.5 Step2: volatile 读取（官方 Cookbook 口径：config.字段名.get()，undefined 回落 DEFAULTS）。
  // 兼容裸对象（单测 apply(ctx,{}) / 旧 patch 残留无 .get）：plain 值直取；缺键回落默认值。
  const getRaw = (key) => {
    try {
      const v = config?.[key];
      if (v && typeof v === 'object' && typeof v.get === 'function') {
        try { return v.get(); } catch { return undefined; }
      }
      return v;
    } catch { return undefined; }
  };
  const pick = (key, fb) => {
    const v = getRaw(key);
    return v === undefined ? fb : v;
  };
  // 新 Config（15 volatile）→ 旧 cfg 键合成。legacy 优先：旧 patch/单测传旧键时照用，
  // 未传才走新字段合成 —— 默认值下合成结果与旧 DEFAULTS 完全一致（路由行为零变化）。
  function buildCfg() {
    const c = { ...DEFAULTS };
    // A 基础（新语义 Step3 接行为；此处只解析）
    c.enabled = pick('enabled', true);
    c.priorityMode = pick('priorityMode', 'manual');
    // B work 档
    c.workMode = pick('workMode', 'auto');
    c.manualWorkModel = pick('manualWorkModel', '');
    c.workModelPriority = pick('workModelPriority', DEFAULTS.workModelPriority);
    c.workModelFallback = pick('workModelFallback', DEFAULTS.workModelFallback);
    c.enableDynamicRanking = pick('enableDynamicRanking', true);
    c.rankingRefreshSeconds = pick('rankingRefreshSeconds', 3600);
    // C chat 档：legacy chatModel 在场（含空串）走 legacy；否则新字段合成
    c.chatMode = pick('chatMode', 'auto');
    c.manualChatModel = pick('manualChatModel', '');
    c.chatModelPriority = pick('chatModelPriority', []);
    const legacyChat = getRaw('chatModel');
    if (legacyChat !== undefined) {
      c.chatProvider = pick('chatProvider', DEFAULTS.chatProvider);
      c.chatModel = legacyChat;
    } else if (c.chatMode === 'manual' && String(c.manualChatModel ?? '').trim()) {
      c.chatProvider = DEFAULTS.chatProvider;
      c.chatModel = String(c.manualChatModel).trim();
    } else {
      c.chatProvider = DEFAULTS.chatProvider;
      const chain = Array.isArray(c.chatModelPriority) ? c.chatModelPriority.map((s) => String(s ?? '').trim()).filter(Boolean) : [];
      const head = chain.length > 0 ? chain[0] : '';
      if (!head) {
        // 空链：不猜模型，回退免费池占位；chatTarget() 的 resolveChatTarget-fallback 会再按
        // owned-default → workModelFallback 逐级解析，此处仅记诊断日志。
        safeLog(ctx, 'warn', 'chatModelPriority empty (reason=chat-chain-empty); chat route falls back to workModelFallback. Fill chatModelPriority with your own provider/model pairs.');
      }
      c.chatModel = head || '';
    }
    // 运维键（新 Config 已删）：legacy/单测残留照用，否则 DEFAULTS
    c.workProvider = pick('workProvider', DEFAULTS.workProvider);
    c.workModel = pick('workModel', c.workModelFallback || DEFAULTS.workModel);
    c.workEffortOwned = pick('workEffortOwned', DEFAULTS.workEffortOwned);
    c.privateChatWorkStrategy = pick('privateChatWorkStrategy', DEFAULTS.privateChatWorkStrategy);
    c.hintMaxCount = pick('hintMaxCount', DEFAULTS.hintMaxCount);
    // D 群聊 / E 状态机（新老同键，直接取）
    c.enableGroupHint = pick('enableGroupHint', false);
    c.hintCooldownMs = pick('hintCooldownMs', DEFAULTS.hintCooldownMs);
    c.switchCooldownMs = pick('switchCooldownMs', 5000);
    c.reclaimUnknownModel = pick('reclaimUnknownModel', true);
    // F 首轮弹窗（v0.8.0）
    c.firstTurnPrompt = pick('firstTurnPrompt', true);
    c.firstTurnPromptTimeoutMs = pick('firstTurnPromptTimeoutMs', 60000);
    // 隐藏自测键（plain，非 volatile）
    c.selftest = pick('selftest', false);
    c.selftestRound = pick('selftestRound', '');
    c.selftestOut = pick('selftestOut', '');
    // 旧档位归一化（off/max → light/deep），不污染 DEFAULTS
    c.chatEffort = normalizeEffortForSwitch(pick('chatEffort', DEFAULTS.chatEffort)) || 'light';
    c.workEffort = normalizeEffortForSwitch(pick('workEffort', DEFAULTS.workEffort)) || 'deep';
    return c;
  }
  // 稳定对象（非重新赋值）：域工厂在创建时解构持有引用，reloadCfg 必须原地合并，
  // 否则域拿到的是旧配置快照（拆分铁律：引用永久有效）。
  const cfg = buildCfg();
  // 可变开关组：三个原先的模块级 let（dynamicOn / freeModelOk / saveIntercepted）
  // 归拢成一个活对象，域工厂读 flags.xxx 即时生效。
  const flags = {
    // v0.5.0 新增开关：enableDynamicRanking=false 时直接回退，不发起 OpenRouter 请求。
    // v0.7.5：volatile 更新时重算（reloadCfg），设置页翻开关即时生效。
    dynamicOn: cfg.enableDynamicRanking !== false,
    // 依赖检查结论（our-free-model 缺失 → 降级纯日志模式）
    freeModelOk: true,
    // saveSelection 拦截是否生效（realSwitch 兜底写回读它）
    saveIntercepted: false,
  };
  // ── 功能二（v0.5.1）：手动锁定 work 模型 ──
  // 锁成立 ⇒ work 目标 = 手动 pair，跳过动态排行榜（refreshLeaderboard/ensureFresh 直接 return，
  // lbFetchCount 保持 0），日志 reason=manual-work-model-locked。
  // 稳定对象 + syncManualLock()：自测 t11/t12 运行时改 cfg 后重算；生产由 reloadCfg 重算。
  const manualLock = { on: false, provider: '', model: '' };
  const syncManualLock = () => {
    let locked = cfg.manualWorkModelLocked;
    const legacyLocked = getRaw('manualWorkModelLocked');
    if (legacyLocked !== undefined) locked = legacyLocked;
    else if (locked !== true) {
      try { locked = String(cfg.workMode ?? '') === 'manual' && String(cfg.manualWorkModel ?? '').trim() !== ''; }
      catch { locked = false; }
    }
    // 原地合并（不重赋值）：域工厂解构出的 manualLock 引用必须始终指向当前锁状态。
    Object.assign(manualLock, parseManualWorkLock({
      locked,
      modelRef: cfg.manualWorkModel,
      fallbackProvider: cfg.workProvider,
    }));
    if (manualLock.on) {
      safeLog(ctx, 'info', `manual work-model lock active: ${manualLock.provider}/${manualLock.model} (reason=${manualLock.reason}; dynamic ranking skipped, lbFetchCount frozen).`);
    }
  };
  syncManualLock();
  // v0.7.5：设置页改值即时生效（官方 pi-ai / speech-to-text 同款 loader/volatile-update）。
  // 重算 cfg + dynamicOn + manualLock；失败保持旧配置（绝不把路由置空）。
  // 旧宿主无该事件时吞掉 = 一次性快照（行为与旧版一致）。
  function reloadCfg(reason = '') {
    try {
      Object.assign(cfg, buildCfg());
      flags.dynamicOn = cfg.enableDynamicRanking !== false;
      syncManualLock();
      safeLog(ctx, 'info', `config reloaded (${reason || 'volatile-update'}): enabled=${cfg.enabled} priority=${cfg.priorityMode} hint=${cfg.enableGroupHint} workMode=${cfg.workMode} chatMode=${cfg.chatMode} dynamic=${flags.dynamicOn} lock=${manualLock.on}.`);
    } catch { /* reload 失败保持旧配置 */ }
  }
  try {
    if (typeof ctx?.on === 'function') ctx.on('loader/volatile-update', () => reloadCfg('volatile-update'));
  } catch { /* 旧宿主无该事件 */ }
  // v0.7.5 Step4：四门控启动快照（配置→cfg 接线的可观测证据；隔离验证逐跑核对用）。
  safeLog(ctx, 'info', `gates: enabled=${cfg.enabled} priority=${cfg.priorityMode} hint=${cfg.enableGroupHint} workMode=${cfg.workMode} chatMode=${cfg.chatMode} (reason=gates-initialized).`);

  // ── telemetry：JSONL 诊断落盘（auto-router.jsonl），失败静默 ──
  const routeLog = createRouteLog();
  const { getDshHomeDir, writeTextFile, appendRouteLog } = routeLog;

  // ── routing-policy：会话状态存储（热 Map + 冷侧车，升降档事件）──
  const onModeEvent = createModeEventHandler({ ctx, appendRouteLog, safeLog, MODE_CHANGED_EVENT });
  const modeStore = createSessionModeStore({
    homeDir: () => getDshHomeDir(),
    onEvent: onModeEvent,
  });
  // JSONL 诊断字段（mode/chatTurns）的同步读口：只读热 Map，绝不 IO。
  const peekSessionMode = (sid) => { try { return modeStore.peek(sid); } catch { return null; } };

  // 提示冷却（sessionKey -> { until, count }）与切换台账（sessionId -> 'provider/model/effort'）
  const hintState = new Map();
  const lastSwitch = new Map();

  // ── leaderboard：动态工作模型（联网排行榜，1h 缓存；同步读、后台刷，绝不阻塞工具链）──
  const leaderboard = createLeaderboardRefresh({
    ctx, cfg, flags, manualLock, safeLog, getDshHomeDir,
    readTextFile: (p) => routeLog.readTextFile(p),
  });
  const { warmRankCache, refreshFreeList, refreshLeaderboard, lbStale, currentWorkModel, ensureFresh } = leaderboard;

  // 后台预热（apply 不 await）：先读文件缓存，再拉我方清单；榜单只在过期时打上游。
  Promise.resolve()
    .then(() => warmRankCache())
    .then(() => modeStore.hydrate())
    .then((n) => { if (n > 0) safeLog(ctx, 'info', 'session-mode sidecar loaded: ' + n + ' session(s).'); })
    .then(() => refreshFreeList())
    .then(() => { if (lbStale()) return refreshLeaderboard(); })
    .catch(() => {});

  // 依赖检查：our-free-model 缺失时输出明确错误并降级为纯日志模式，不静默失败。
  const degrade = (msg) => {
    flags.freeModelOk = false;
    safeLog(ctx, 'warn', `${msg}; degraded to log-only mode.`);
  };
  try {
    const llm = ctx.llm;
    if (!llm) degrade('llm service unavailable at apply time');
    else if (typeof llm.resolveModelInfo === 'function') {
      // 异步探测，不阻塞 apply：free-model 缺失/版本不兼容时降级。
      Promise.resolve()
        .then(() => llm.resolveModelInfo(cfg.workProvider, cfg.workModelFallback || cfg.workModel))
        .then((info) => { if (!info) degrade(`work model ${cfg.workProvider}/${cfg.workModel} not resolved (our-free-model missing or incompatible?)`); })
        .catch((err) => degrade(`work model probe failed (${err?.message ?? err})`));
    }
  } catch (err) {
    degrade(`dependency check failed (${err?.message ?? err})`);
  }

  // ── switch-controller：全局污染隔离（saveSelection report-only）+ 对称恢复 ──
  const saveGuard = createSaveGuard({ ctx, getService, safeLog, flags });
  // v0.8.6：补 dispose 恢复路径 —— 卸载/热重载时把 monkey-patch 完全回滚。
  try {
    ctx.effect(() => () => saveGuard.dispose(), 'dsh-auto-model-router.save-guard');
  } catch (err) {
    safeLog(ctx, 'warn', `save-guard dispose registration skipped (degraded): ${String(err?.message ?? err)}`);
  }
  const cooldown = createCooldown();

  // ── routing-policy：决策器（判定 + 注解 + 群提示；纯函数域内直用，实例间经 deps）──
  const decider = createDecider({
    ctx, cfg, flags, manualLock, lastSwitch, hintState, getService, safeLog,
    currentWorkModel, sidOf,
  });
  const { annotateRoute, maybeGroupHint, routeBranch, knownWorkPairs } = decider;

  // ── switch-controller：真切咽喉（读回 / 手动保持 / 优先级 / 能不能切 / 真切）──
  const sw = createRealSwitch({
    ctx, cfg, flags, getService, safeLog, lastSwitch, cooldown,
    knownWorkPairs, currentWorkModel,
    resolveChatTarget, isColdStartCrossKind, isUnknownDrift, isSameKind,
    buildSelectModelPayload, DEFAULT_WORK_MODEL,
  });
  const { readSelectionProjection, readSelectionForRoute, manualKeepReason, applyPriorityMode, shouldSwitch, realSwitch } = sw;

  // ── first-turn：首轮状态建立与弹窗（isGroupMeta 属 routing-policy，经 deps 注入）──
  const firstTurnDeps = { ctx, cfg, modeStore, getService, safeLog, isGroupMeta, classifyTask, appendRouteLog };

  // ── handlers：两条钩子主体 ──
  const preExecuteHandler = createPreExecuteHandler({
    ctx, cfg, flags, safeLog, sidOf, modeStore, peekSessionMode, lastSwitch,
    ensureFresh, annotateRoute, maybeGroupHint, routeBranch,
    readSelectionProjection, appendRouteLog,
  });
  const preStepHandler = createPreStepHandler({
    ctx, cfg, flags, safeLog, sidOf, modeStore, peekSessionMode, lastSwitch,
    establishFirstTurnState, ensureFresh, annotateRoute, maybeGroupHint, routeBranch,
    readSelectionForRoute, applyPriorityMode, manualKeepReason, shouldSwitch, realSwitch,
    appendRouteLog, firstTurnDeps,
  });

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
    safeLog(ctx, 'warn', `agent/pre-step registration skipped (degraded): ${String(err?.message ?? err)}`);
  }

  // ── 隔离自测驱动（仅 cfg.selftest 时执行；生产 patch 不配置该键 = 完全不运行）──
  // d 字段口径：断言文件只读 cfg/flags/manualLock/logLines/lbFetchCount 活引用 + 一批领域实例。
  if (cfg.selftest) {
    selftestCapture.lines = [];
    startSelftest({
      ctx, cfg, flags, manualLock, getService, safeLog, writeTextFile,
      logLines: selftestCapture.lines,
      resolveService: sw.resolveService,
      refreshFreeList, refreshLeaderboard, currentWorkModel, ensureFresh,
      lb: leaderboard.lb, freeList: leaderboard.freeList,
      get lbFetchCount() { return leaderboard.lbFetchCount; },
      decideRoute, sourceFromMeta, annotateRoute: decider.annotateRoute,
      maybeGroupHint: decider.maybeGroupHint,
      syncManualLock, resolveChatTarget, DEFAULT_WORK_MODEL,
      applyPriorityMode: sw.applyPriorityMode, manualKeepReason: sw.manualKeepReason,
      shouldSwitch: sw.shouldSwitch, realSwitch: sw.realSwitch,
      readSelectionProjectionFresh: sw.readSelectionProjectionFresh,
      switchState: cooldown.switchState,
    });
  }
}
