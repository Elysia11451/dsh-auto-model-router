// telemetry / impl / mode-event —— 会话升降档事件的落痕。
// 回答的问题：模式从 chat 变 work（或反过来）时，要留下什么证据？
// 每次 mode 变化写一行 JSONL（auto-router.jsonl）+ 一行 info 日志。
//
// 拆分铁律：本文件不 import 本域 interface.js；事件名（MODE_CHANGED_EVENT）属
// routing-policy 域，由装配根经 deps 注入，不跨域 import 实现。

/**
 * @typedef {object} ModeEventDeps
 * @property {object} ctx
 * @property {(entry: object) => Promise<void>} appendRouteLog —— 跨域注入（telemetry/route-log）
 * @property {(ctx: object, level: string, msg: string) => void} safeLog
 * @property {string} MODE_CHANGED_EVENT                        —— 跨域注入（routing-policy）
 */

/**
 * @param {ModeEventDeps} d
 * @returns {(ev: {sid: string, prevMode: string, mode: string, chatTurns: number, reason: string}) => void}
 */
export function createModeEventHandler(d) {
  const { ctx, appendRouteLog, safeLog, MODE_CHANGED_EVENT } = d;
  return function onModeEvent(ev) {
    try {
      appendRouteLog({
        sid: ev.sid,
        tool: MODE_CHANGED_EVENT,
        extractText: ev.reason ?? '',
        task: '',
        route: ev.mode,
        target: null,
        keepReason: ev.reason ?? null,
        actualSel: null,
        mode: ev.mode,
        prevMode: ev.prevMode,
        chatTurns: ev.chatTurns,
      }).catch(() => {});
      safeLog(ctx, 'info', 'session ' + ev.sid + ' mode ' + ev.prevMode + ' -> ' + ev.mode + ' (reason=' + (ev.reason ?? '-') + '; chatTurns=' + ev.chatTurns + '; event=' + MODE_CHANGED_EVENT + ').');
    } catch { /* 诊断失败不阻断 */ }
  };
}
