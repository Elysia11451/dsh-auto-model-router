// routing-policy / impl / classifier —— 「这条消息是什么」的纯判定层。
// 回答的问题：消息来自哪、是不是真人、是不是干活、有没有待办工具。
// 零依赖、零副作用：不碰 ctx / cfg / 任何服务，可离线单测。
//
// 拆分铁律：本文件不 import 本域 interface.js（用 JSDoc typedef 描述形状）。

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

// ── v0.7.1 来源过滤（本版唯一改动点）──────────────────────────────────────
// 只认真人输入：source.kind === 'user' 且不是插件/系统注入的通知。
// 实测形状（2026-10-06 真机会话普查）：
//   真人      {"kind":"user","rpcId":...} / QQ {"kind":"user","rpcId":"qq-..."}
//   auto-continue 重试注入（bug 主角）
//             {"kind":"user","producer":"dsh-auto-continue","form":"notice"}
//   其他非人  runtime-context / dsh-mnemon / goal / user-approval / model-selection / 无 source 合成消息
// 注意：重试通知故意把 kind 伪造成 "user"（为了在聊天界面渲染气泡），
// 所以只看 kind 不够，必须同时排掉 producer 署名与 form=notice。
export function isHumanInput(m) {
  try {
    const s = m?.source;
    if (!s || s.kind !== 'user') return false;
    if (s.producer) return false;             // 插件署名注入（dsh-auto-continue 等）
    if (s.form === 'notice') return false;    // 通知形注入
    return true;
  } catch { return false; }
}

/**
 * 从 pre-step 的 messages 里取出用户消息原文。
 * 首选 role==='user' 的最后一条（须通过 isHumanInput）；若本批消息压根没有 user 角色
 * （不同宿主版本形状有别），退化取最后一条真人输入、有文本的消息。
 * 取不到就必须留探针，不能静默丢轮。
 * @returns {{text: string, skipReason: string|null, rejectedText: string}}
 *   text         —— 作为路由依据的真人文本（'' = 不可用于路由）
 *   skipReason   —— 'system-retry-skipped' 表示末条 user 形消息是系统/插件注入
 *   rejectedText —— 被拒消息的原文（供跳过日志取证，不参与路由）
 */
export function extractUserText(messages) {
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

// ── v0.7.2 阶段三 3.5：任务进行中判定 ──
// 末条消息是带未回应 tool_calls 的 assistant（工具请求尚未产出结果）→ 视为任务进行中，
// 降档计数冻结（nextSessionMode 的 pendingToolCalls 参数）。
export function hasPendingToolCalls(messages) {
  try {
    const list = Array.isArray(messages) ? messages : [];
    if (!list.length) return false;
    const last = list[list.length - 1];
    if (!last || last.role !== 'assistant') return false;
    if (Array.isArray(last.tool_calls) && last.tool_calls.length > 0) return true;
    if (Array.isArray(last.content)) {
      return last.content.some((b) => b && typeof b === 'object' && (b.type === 'tool_use' || b.type === 'tool_call'));
    }
    return false;
  } catch { return false; }
}

export function textSig(s) {
  try {
    let h = 0;
    const str = String(s || '');
    for (let i = 0; i < str.length; i += 1) h = (h * 31 + str.charCodeAt(i)) | 0;
    return `${str.length}:${h}`;
  } catch { return '0'; }
}
