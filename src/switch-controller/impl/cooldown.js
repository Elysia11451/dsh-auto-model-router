// switch-controller / impl / cooldown —— 真切节流（切换冷却）归此文件管。
// 回答的问题：距上次真切多久了？这次切换该被拦、还是升档放行？
//
// 状态：sessionId -> lastSwitchTs。连续 pre-execute 命中同一会话时，
// 冷却内不重复 selectModel，避免模型选择器抖动（Step3 验证项 5）。
// v0.7.8 方向区分：升档（chat→work，含 routeMode==='work'）跳过冷却立即放行；
// 降档（work→chat）与同档切换仍受冷却约束。
//
// 拆分铁律：本文件不 import 本域 interface.js（用 JSDoc typedef 描述形状）。

/**
 * @typedef {object} CooldownAPI
 * @property {Map<string, number>} switchState
 * @property {number} SWITCH_COOLDOWN_MS
 * @property {(sid: string, opts: object) => ({blocked: boolean, bypass?: boolean})} gate
 */

export function createCooldown() {
  // 真切节流：sessionId -> lastSwitchTs。
  const switchState = new Map();
  const SWITCH_COOLDOWN_MS = 60 * 1000; // 历史默认（现已被 cfg.switchCooldownMs 覆盖，默认 5000）

  /**
   * 冷却闸门（逻辑自 realSwitch 原样搬移，含日志与返回语义）。
   * @param {string} sid
   * @param {{cooldownMs: number, isUpgrade: boolean, ctx: object, tag: string,
   *          safeLog: Function}} o
   * @returns {{blocked: boolean, bypass?: boolean}}
   */
  function gate(sid, o) {
    const { cooldownMs, isUpgrade, ctx, tag, safeLog } = o;
    const now = () => Date.now();
    try {
      const last = switchState.get(sid);
      if (!isUpgrade && last && now() - last < cooldownMs) {
        const remain = cooldownMs - (now() - last);
        safeLog(ctx, 'warn', `${tag} | early-return reason=downgrade-cooldown-blocked (${now() - last}ms since last switch; remain=${remain}ms)`);
        return { blocked: true };
      }
      if (isUpgrade && last && now() - last < cooldownMs) {
        safeLog(ctx, 'info', `${tag} | reason=upgrade-bypass-cooldown (${now() - last}ms since last switch; chat->work instant)`);
        return { blocked: false, bypass: true };
      }
    } catch { /* Map 异常不阻断 */ }
    return { blocked: false };
  }

  return { switchState, SWITCH_COOLDOWN_MS, gate };
}
