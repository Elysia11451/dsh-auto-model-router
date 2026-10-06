// Pure routing logic — no DSH imports, unit-testable.
// v0.7.0：静态降级链单一事实源在 leaderboard.js（纯 ESM，同样零 DSH 依赖）。
import { DEFAULT_WORK_MODEL_PRIORITY } from './leaderboard.js';
export const AGENT_KEYWORDS = [
  '装插件', '安装插件', '装个插件', '安装一个插件',
  '跑命令', '运行命令', '执行命令', '跑个命令', '执行一下',
  '写代码', '写个脚本', '改代码', '操作文件', '创建文件', '删除文件',
  '建文件', '新建文件', '写入文件', '建个文件', '新建个文件', '创建个文件',
  '生成文件', '生成一个文件', '建个', '写入',
  '改文件', '重构', '写个插件', '帮我写', '帮我改', '帮我查',
  '查日志', '看日志', '部署', '发版', '回滚',
  'install plugin', 'run command', 'write code',
  'edit file', 'create file', 'new file', 'write file', 'make a file',
];

export function classifyTask(text = '') {
  const t = String(text);
  return AGENT_KEYWORDS.some((k) => t.includes(k)) ? 'agent-work' : 'chat';
}

export function sourceFromMeta(meta = {}) {
  const ch = String(meta.channel || meta.source || meta.origin || '').toLowerCase();
  if (['weixin', 'wechat', 'qq', 'telegram', 'tg', 'discord', 'feishu', 'dingtalk', 'whatsapp', 'slack', 'im'].some((k) => ch.includes(k))) return 'im';
  if (meta.conversationKey || meta.chatType || meta.chat_mode) return 'im';
  return 'main';
}

export function isGroupMeta(meta = {}) {
  if (meta.chatType === 'group' || meta.chat_type === 'group') return true;
  if (meta.isGroup === true) return true;
  if (typeof meta.participants === 'number' && meta.participants > 2) return true;
  if (Array.isArray(meta.participants) && meta.participants.length > 2) return true;
  if (typeof meta.senderCount === 'number' && meta.senderCount > 1) return true;
  return false;
}

// source: 'im' | 'main'. Returns { mode: 'chat'|'work', task, needHint, workStyle }.
// 四象限（strategy = cfg.privateChatWorkStrategy，私聊干活用 free 还是 owned）:
//  - 私聊闲聊 -> chat（强制回自有，哪怕当前停在 work 档）
//  - 私聊干活 + free -> work/free（动态最强）；+ owned -> work/owned（自有 API 最强档）
//  - 群聊闲聊 -> chat；群聊干活 -> work/free（动态最强）
export function decideRoute({ source, text = '', meta = {}, currentMode = null, strategy = 'free', task: taskOverride = null } = {}) {
  // v0.7.2 阶段三 3.3：task 可由会话状态机给出（pre-step/pre-execute 传入）；
  // 未传（null）时退回关键词分类 —— 供首轮预判兜底与自测/单测直调保持旧行为。
  const task = taskOverride || classifyTask(text);
  const group = isGroupMeta(meta);
  // v0.6.0 阶段二·修复点一：classifyTask 判 chat ⇒ route.mode 必须是 chat，与 source 无关。
  // 旧版末尾「main 兜底无条件 return work」越权当了 Rule 2 —— 主界面/QQ 单聊闲聊一律落 work，
  // 于是 chatModel 永远轮不到，目标被 work 象限（动态榜 TOP）吃掉。
  // 现在只有 task === 'agent-work' 才进 work；chat 一律回 chat（目标 = config.chatModel）。
  if (task === 'chat') {
    const needHint = currentMode === 'work' && group;
    return { mode: 'chat', task, needHint, workStyle: 'owned' };
  }
  // Rule 2 wins: explicit agent work anywhere -> work (style depends on quadrant)
  if (task === 'agent-work') {
    if (source === 'im' && !group) {
      const workStyle = strategy === 'owned' ? 'owned' : 'free';
      return { mode: 'work', task, needHint: false, workStyle };
    }
    return { mode: 'work', task, needHint: false, workStyle: 'free' };
  }
  // 兜底（classifyTask 目前只返回上面两值）：未识别任务保守回 chat，不越权进 work。
  const needHintFallback = currentMode === 'work' && group;
  return { mode: 'chat', task, needHint: needHintFallback, workStyle: 'owned' };
}

// 精确同类判定：cur 'provider/model' == target 'provider/model' 才算同类。
// 不再按 provider 全家判定：手动 1.3 在位 + 动态最强空间兔 => 跨类，该换就换。
export function isSameKind(curActualModel, targetProvider, targetModel) {
  try {
    const cur = String(curActualModel || '').toLowerCase();
    const tp = String(targetProvider || '').toLowerCase();
    const tm = String(targetModel || '').toLowerCase();
    if (!cur || !tp || !tm) return false;
    return cur.startsWith(`${tp}/${tm}`);
  } catch { return false; }
}

export function buildGroupHint(workModel = DEFAULTS.workModel, workEffort = DEFAULTS.workEffort) {
  const short = String(workModel || '').split('/').pop()
    .replace(/[-_]v?\d+(\.\d+)*.*$/, '')
    .replace(/-free$/, '') || 'work';
  return `⚠️ 当前群聊正在使用 Agent 工作模型（${short}/${workEffort}），建议发送 /switch chat 切换为聊天模型，否则将持续消耗高配额。`;
}

// 实际模型判定：只看 exec.agent.model（当前真实档位），不对症不下药。
export function isWorkModelRef(model, workModel = DEFAULTS.workModel, workProvider = DEFAULTS.workProvider) {
  const s = String(model || '');
  if (!s) return false;
  return s.includes(workModel) || s.includes(workProvider);
}

/**
 * chat 目标解析（v0.5.0）：所有模型从配置读取，不写死。
 *  - chatModel 含 "prov/mod"（插件表单只暴露 chatModel 键，chatProvider 走 patch/默认值）
 *    → 按第一个 "/" 拆成 provider/model；
 *  - chatModel 为裸模型名 → 搭配 chatProvider；
 *  - chatModel 留空 → 回退 workProvider/workModelFallback（免费池恒可用，聊天仍走 light 档），
 *    调用方按 source==='fallback' 打警告日志（Config 描述承诺的行为）。
 * @returns {{provider: string, model: string, source: 'configured'|'fallback'}}
 */
export function resolveChatTarget({ chatProvider = '', chatModel = '', workProvider = '', workModelFallback = '' } = {}) {
  const raw = String(chatModel ?? '').trim();
  if (raw) {
    const slash = raw.indexOf('/');
    if (slash > 0 && slash < raw.length - 1) {
      return { provider: raw.slice(0, slash), model: raw.slice(slash + 1), source: 'configured' };
    }
    return { provider: String(chatProvider ?? ''), model: raw, source: 'configured' };
  }
  return { provider: String(workProvider ?? ''), model: String(workModelFallback ?? ''), source: 'fallback' };
}

/**
 * 手动锁定 work 模型解析（v0.5.1 功能二）。
 * - locked=false 或 manualWorkModel 为空 → 不构成锁（on:false，调用方走原动态/回退逻辑）。
 * - 'prov/mod' → 按第一个 '/' 拆；裸模型名 → 搭配 fallbackProvider（cfg.workProvider）。
 * - 锁定成立 → { on:true, provider, model, reason:'manual-work-model-locked' }，
 *   调用方据此跳过动态排行榜（lbFetchCount 必须为 0）。零硬编码：模型只来自配置。
 * @returns {{on: boolean, provider: string, model: string, reason?: string, why?: string}}
 */
export function parseManualWorkLock({ locked = false, modelRef = '', fallbackProvider = '' } = {}) {
  if (!locked) return { on: false, provider: '', model: '', why: 'lock-disabled' };
  const raw = String(modelRef ?? '').trim();
  if (!raw) return { on: false, provider: '', model: '', why: 'empty' };
  const slash = raw.indexOf('/');
  let provider, model;
  if (slash > 0 && slash < raw.length - 1) {
    provider = raw.slice(0, slash);
    model = raw.slice(slash + 1);
  } else {
    provider = String(fallbackProvider ?? '');
    model = raw;
  }
  if (!provider || !model) return { on: false, provider: '', model: '', why: 'incomplete' };
  return { on: true, provider, model, reason: 'manual-work-model-locked' };
}

/**
 * 冷启动空台账二次判定（v0.5.2）：lastSwitch 为空时无法区分"路由自有态"还是"用户手选"，
 * 用 route.mode × 当前档 provider 做跨类放行（模型只来自配置，零硬编码）：
 *  - chat 路由 + 当前停在 workProvider（且 work≠chat 可分类）→ 放行（work→chat，如 QQ 闲聊回 GLM）
 *  - work 路由 + 当前停在 chat 目标 provider（且可分类）→ 放行（chat→work）
 *  - 同类/无法归类（provider 相同、第三方值、缺参）→ false，调用方保守不覆盖。
 * @returns {boolean} true=跨类放行，false=保守保持
 */
export function isColdStartCrossKind({ selProvider = '', routeMode = '', workProvider = '', chatTargetProvider = '' } = {}) {
  const sel = String(selProvider ?? '').trim();
  const mode = String(routeMode ?? '').trim();
  const work = String(workProvider ?? '').trim();
  const chatP = String(chatTargetProvider ?? '').trim();
  if (!sel || !mode || !work || !chatP) return false;
  if (work === chatP) return false; // chat 回退到免费池时同 provider，无法分类
  if (mode === 'chat') return sel === work && sel !== chatP;
  if (mode === 'work') return sel === chatP && sel !== work;
  return false;
}

/**
 * 未知漂移纠偏判定（v0.5.3，由 Config.reclaimUnknownModel 门控）。
 * 场景：外部手动切换/宿主中止把会话模型拽到既非聊天目标、也非配置干活模型的值
 *      （实测：our-free-model/muse-spark-1.2-contributor-free/balanced），
 *      v0.5.1 台账外来判定会保守 kept，路由失效 —— 开关打开时在此放行。
 * 已知集合（全部来自配置，零硬编码）：
 *  - 聊天目标对：resolveChatTarget 的 provider/model（支持 'prov/mod' / 裸名 / 空回退）；
 *  - 干活配置对：workProvider/workModel、workProvider/workModelFallback、手动锁对（若生效）。
 * 为何不把动态榜单交集整体算作已知：交集第一名可能恰好就是漂移目标（实测 TOP=muse-spark-1.2），
 *  记成已知会让纠偏在生产失灵；路由器自己选出的动态模型必写 lastSwitch 台账，
 *  台账匹配在本判定之前已放行 —— 台账才是"路由器自有态"的权威证据。
 * 读不出（sel 缺 provider/model）→ false：与全局纪律一致，绝不赌。
 * @returns {boolean} true=未知漂移（可纠偏），false=已知模型（保持手动优先）
 */
export function isUnknownDrift({ selProvider = '', selModel = '', chatTargetProvider = '', chatTargetModel = '', knownWorkPairs = [] } = {}) {
  const sp = String(selProvider ?? '').trim();
  const sm = String(selModel ?? '').trim();
  if (!sp || !sm) return false;
  const sel = `${sp}/${sm}`;
  const cp = String(chatTargetProvider ?? '').trim();
  const cm = String(chatTargetModel ?? '').trim();
  if (cp && cm && sel === `${cp}/${cm}`) return false;
  const known = (Array.isArray(knownWorkPairs) ? knownWorkPairs : []).map((p) => String(p ?? '').trim()).filter(Boolean);
  if (known.includes(sel)) return false;
  return true;
}

export const DEFAULTS = Object.freeze({
  chatProvider: 'zai-coding-cn',
  chatModel: 'glm-5.3-flash',
  // 探针实锤：free-model 只声明 light/balanced/deep，无 off/max。
  // chat 走自有 API：传 light（若目标模型无 effort 菜单，调用层会自动省略 effort 重试）。
  // 注意：chatProvider/chatModel 只是默认占位——用户在「设置→插件→插件配置」
  // 里按自己的 API key 改成任意 provider/model，路由照走不写死。
  chatEffort: 'light',
  workProvider: 'our-free-model',
  workModel: 'mimo-v2.6-flash-free',
  // 最强档 = deep（历史配置里的 'max' 是 UI 概念，调用层映射为 deep）。
  workEffort: 'deep',
  // 私聊干活自有策略的最强档（owned 时用自有 API + 此档位）。
  workEffortOwned: 'deep',
  // 私聊干活策略：free = 免费池动态最强（省钱）；owned = 自有 API（保稳定）。
  privateChatWorkStrategy: 'free',
  // 动态排行榜不可用时的回退模型（Config 可配 workModelFallback，默认与 workModel 一致）。
  workModelFallback: 'mimo-v2.6-flash-free',
  // v0.7.0 静态降级链（FreeTierError 后策略：动态榜只是加分项，链才是底线）。
  // 排行榜失败/超时/缓存过期时按序挑可用者，全不中才落 workModelFallback。
  workModelPriority: [...DEFAULT_WORK_MODEL_PRIORITY],
  hintCooldownMs: 10 * 60 * 1000,
  hintMaxCount: 20,
});

// UI 概念档位 -> adapter 真实 effort id。sessionId 直传，不做任何转换。
//  - 'max' -> 'deep'（最强）；'off'/'minimal' -> 'light'（最省）；其余原样透传。
export function normalizeEffortForSwitch(effort) {
  const e = String(effort || '');
  if (e === 'max') return 'deep';
  if (e === 'off' || e === 'minimal') return 'light';
  return e || undefined;
}

// 为一次 selectModel 调用组装 payload：sessionId 直传 + effort 归一化。
 
// ── v0.7.2 会话状态机（纯函数，离线单测；取代关键词全局判定）────────────────
// 输入：
//   currentMode  当前会话态 'chat'|'work'（非法值一律按 'chat' 处理，冷启动默认态）
//   hasToolCall  本轮是否已发生真实工具调用（tools/pre-execute 铁证，唯一可信升档信号）
//   hasKeywords  干活关键词命中信号（classifyTask 结果）。
//                ⚠ 调用方约束：chat 态只允许首轮（无状态新会话）传真，
//                非首轮关键词不作为路由依据（仅在 work 态用于清零计数）——
//                "仅首轮预判加速"的门禁放在调用层，纯函数保持无状态。
//   chatTurns    连续「无工具、无关键词」轮数（work 态降档计数器）
//   opts.pendingToolCalls  任务进行中（有未完成 tool_calls）→ 冻结计数，禁止降档
// 返回 { mode, chatTurns }：
//   工具调用  -> work/0（升档铁证，优先级最高）
//   chat+关键词（首轮预判）-> work/0
//   chat 闲聊 -> chat/0
//   work+关键词 -> work/0（干活延续，清零计数）
//   work 无工具无关键词 -> 计数 +1；连续 3 轮（入值 >=2 即下一轮达 3）-> chat/0
//   work + pendingToolCalls -> work/计数冻结
export function nextSessionMode(currentMode, hasToolCall, hasKeywords, chatTurns, opts = {}) {
  const mode = currentMode === 'work' ? 'work' : 'chat';
  const raw = Number(chatTurns);
  const n = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0;
  if (hasToolCall) return { mode: 'work', chatTurns: 0 };
  if (mode === 'chat') {
    if (hasKeywords) return { mode: 'work', chatTurns: 0 };
    return { mode: 'chat', chatTurns: 0 };
  }
  // mode === 'work'
  if (hasKeywords) return { mode: 'work', chatTurns: 0 };
  if (opts && opts.pendingToolCalls) return { mode: 'work', chatTurns: n }; // 任务进行中禁降档
  const next = n + 1;
  if (next >= 3) return { mode: 'chat', chatTurns: 0 }; // 阈值 3：入值 2 即降档
  return { mode: 'work', chatTurns: next };
}

export function buildSelectModelPayload({ sessionId, provider, model, effort }) {
  const payload = {
    sessionId: String(sessionId || ''),
    provider: String(provider || ''),
    model: String(model || ''),
  };
  const normalized = normalizeEffortForSwitch(effort);
  if (normalized) payload.reasoningEffort = normalized;
  return payload;
}
