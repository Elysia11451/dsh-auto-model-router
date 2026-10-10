// switch-controller / impl / save-guard —— 窗口内污染隔离 + 对称恢复。
// 回答的问题：会话真切会不会偷偷改写全局默认？卸载/热重载时能不能原样还回去？
//
// 全局污染隔离（社区做法 @argszero/cordis-plugin-session-model）：
// session-controller.selectModel 内部会 ctx.agentDefaultModel.saveSelection(selected)
// （lib/index.js:736-738），把会话选择后台写进全局默认（settings.yaml，经 configEditor）。
//
// v0.8.7 步骤10（千问审计·收窄）：不再全局吞写 ——
//  - 窗口内（flags.saveWindow > 0，路由自己发起的 selectModel 期间）：saveSelection 变
//    report-only，只报告选择、不写 settings；deploymentDefault: keep；
//  - 窗口外（默认，含用户手动选择）：走原函数，正常写 settings —— 守卫不干预原生路径。
// real-switch 的 withSaveWindow 负责 +1/-1（try/finally 配对）；替换失败仍退回"切前默认写回"兜底。
//
// v0.8.6：补 dispose() 对称恢复路径 —— 卸载/热重载时把 monkey-patch 拆回原样。
//
// 拆分铁律：本文件不 import 本域 interface.js（用 JSDoc typedef 描述形状）。

/**
 * @typedef {object} SaveGuardAPI
 * @property {() => void} dispose      —— 恢复原 saveSelection，回滚全部标记
 * @property {() => boolean} isActive  —— 当前是否处于拦截态
 */

/**
 * @param {object} d
 * @param {object} d.ctx
 * @param {(ctx: object, name: string) => any} d.getService
 * @param {(ctx: object, level: string, msg: string) => void} d.safeLog
 * @param {{saveIntercepted: boolean, saveWindow?: number}} d.flags —— 可变开关（窗口深度 + realSwitch 兜底写回读它）
 */
export function createSaveGuard(d) {
  const { ctx, getService, safeLog, flags } = d;
  let admRef = null;
  let active = false;

  try {
    const adm = getService(ctx, 'agentDefaultModel');
    if (adm && typeof adm.saveSelection === 'function' && !adm.__autoModelRouterGuard) {
      const origSave = adm.saveSelection.bind(adm);
      adm.__autoModelRouterOrigSave = origSave;
      adm.saveSelection = async (next) => {
        // v0.8.7 步骤10：窗口外（默认/用户手动选择）保持原始行为，正常写 settings。
        if (!(Number(flags.saveWindow) > 0)) return origSave(next);
        try {
          safeLog(ctx, 'info', `default-save suppressed in router window (kept, not written): ${next?.provider ?? '?'} / ${next?.model ?? '?'}`);
        } catch { /* noop */ }
        return; // 窗口内：只报告，不写 settings
      };
      adm.__autoModelRouterGuard = true;
      flags.saveIntercepted = true;
      admRef = adm;
      active = true;
      safeLog(ctx, 'info', 'agentDefaultModel.saveSelection guarded: report-only inside router switch window, passthrough outside.');
    }
  } catch (err) {
    safeLog(ctx, 'warn', `saveSelection intercept skipped, fallback to restore-before (${String(err?.message ?? err)})`);
  }

  // 对称恢复：把 monkey-patch 拆回原样（只在本实例装过守卫时才动）。
  function dispose() {
    try {
      if (!active || !admRef) return;
      if (admRef.__autoModelRouterGuard && typeof admRef.__autoModelRouterOrigSave === 'function') {
        admRef.saveSelection = admRef.__autoModelRouterOrigSave;
        try { delete admRef.__autoModelRouterOrigSave; } catch { /* noop */ }
        try { delete admRef.__autoModelRouterGuard; } catch { /* noop */ }
      }
      flags.saveIntercepted = false;
      active = false;
      safeLog(ctx, 'info', 'saveSelection guard disposed: original restored (side effects rolled back).');
    } catch (err) {
      safeLog(ctx, 'warn', `saveSelection guard dispose failed (${String(err?.message ?? err)}); patch may persist until reload.`);
    }
  }

  return { dispose, isActive: () => active };
}
