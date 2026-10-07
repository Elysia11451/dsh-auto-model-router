// 一次性生成脚本：从 index.js 自测块生成 src/selftest/driver.js（已执行，留档）
import fs from 'node:fs';

// 末行是 apply() 的收尾 }（原 2244 行），不属于自测块 —— 丢弃
const lines = fs.readFileSync('automation/.selftest-block.js', 'utf8').split('\n').slice(0, -1);
const map = [
  [/\bsavedOn = dynamicOn;/g, 'savedOn = d.flags.dynamicOn;'],
  [/\bdynamicOn = false;/g, 'd.flags.dynamicOn = false;'],
  [/\bdynamicOn = savedOn;/g, 'd.flags.dynamicOn = savedOn;'],
  [/\bsaveIntercepted = true;/g, 'd.flags.saveIntercepted = true;'],
  [/\blbFetchCount\b/g, 'd.leaderboard.lbFetchCount'],
  [/\bswitchState\./g, 'd.switchState.'],
  [/\bsyncManualLock\(\)/g, 'd.syncManualLock()'],
  [/\bfreeList\./g, 'd.leaderboard.freeList.'],
  [/import\('\.\/leaderboard\.js'\)/g, "import('../leaderboard/leaderboard.js')"],
  [/\bwriteTextFile\(/g, 'd.writeTextFile('],
];
let body = lines.map((l) => { let o = l; for (const [re, to] of map) o = o.replace(re, to); return o; });
body = body.map((l) => (l.trim() === 'selftestLines = [];' ? `${l}\n    d.capture.lines = selftestLines;` : l));

const header = `// selftest / driver —— 隔离自测驱动（原 src/index.js 1505-2244 整块平移，逻辑零改）。
// 仅 cfg.selftest 时运行；生产 patch 不配置该键 = 完全不运行。
// 拆分铁律：本文件不 import 本域 interface.js；跨域状态全部经 d 注入。
import { decideRoute, sourceFromMeta, resolveChatTarget } from '../routing-policy/impl/decider.js';
import { rankIntersection, DEFAULT_WORK_MODEL } from '../leaderboard/leaderboard.js';

/**
 * @param {object} d
 * @param {object} d.ctx
 * @param {object} d.cfg
 * @param {{dynamicOn: boolean, freeModelOk: boolean, saveIntercepted: boolean}} d.flags
 * @param {object} d.manualLock
 * @param {() => void} d.syncManualLock
 * @param {Map} d.switchState
 * @param {Map} d.lastSwitch
 * @param {object} d.leaderboard —— createLeaderboardRefresh() 返回
 * @param {object} d.sw          —— createRealSwitch() 返回
 * @param {object} d.decider     —— createDecider() 返回
 * @param {Function} d.getService
 * @param {Function} d.safeLog
 * @param {Function} d.writeTextFile
 * @param {{lines: Array<string>|null}} d.capture
 */
export function startSelftest(d) {
  const { ctx, cfg, manualLock, lastSwitch, getService, safeLog, decider } = d;
  const { chatTarget, annotateRoute, maybeGroupHint } = decider;
  const {
    readSelectionProjectionFresh, manualKeepReason, applyPriorityMode,
    shouldSwitch, resolveService, realSwitch,
  } = d.sw;
  const { refreshFreeList, refreshLeaderboard, currentWorkModel, ensureFresh, lb } = d.leaderboard;
  let selftestLines = null;
`;

fs.writeFileSync('src/selftest/driver.js', header + body.join('\n') + '\n}\n');
console.log('written', fs.statSync('src/selftest/driver.js').size, 'bytes');
