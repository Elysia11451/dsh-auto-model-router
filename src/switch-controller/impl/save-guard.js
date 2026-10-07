// switch-controller / impl / save-guard —— 全局污染隔离 + 对称恢复。
// 回答的问题：会话真切会不会偷偷改写全局默认？卸载/热重载时能不能原样还回去？
//
// 全局污染隔离（社区做法 @argszero/cordis-plugin-session-model）：
// session-controller.selectModel 内部会 ctx.agentDefaultModel.saveSelection(selected)
// （lib/index.js:736-738），把会话选择后台写进全局默认（settings.yaml，经 configEditor）。
// 路由场景不需要这个副作用 —— 在实例上替换 saveSelection，只报告选择、不写 settings；
// deploymentDefault: keep（保持默认，不改成 write）。替换失败则退回"切前默认写回"兜底。
//
// v0.8.6：补 dispose() 对称恢复路径 —— 之前 monkey-patch 只装不卸，卸载/热重载时
// 副作用残留（saveSelection 永久变成 report-only）。现在 ctx.effect 卸载时回滚。
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
 * @param {{saveIntercepted: boolean}} d.flags —— 可变开关（realSwitch 兜底写回读它）
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
        try {
          safeLog(ctx, 'info', `default-save intercepted (kept, not written): ${next?.provider ?? '?'} / ${next?.model ?? '?'}`);
        } catch { /* noop */ }
        return; // 只报告，不写 settings
      };
      adm.__autoModelRouterGuard = true;
      flags.saveIntercepted = true;
      admRef = adm;
      active = true;
      safeLog(ctx, 'info', 'agentDefaultModel.saveSelection intercepted: report-only, deploymentDefault kept.');
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
