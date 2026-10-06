# Contributing

## 开发流程

1. 改 `src/router.js`（纯逻辑，可单元测试）与 `src/index.js`（宿主层，只做注册）。
2. 跑测试：`node ./test/router.test.mjs && node ./test/crash.test.mjs`，全绿再装。
3. 用 `dsh-plugin-dev-mode`（或等效本地 profile）先挂载验证，确认 DSH 状态为 READY/无 FAILED，再装生产 profile。

## 铁律（违反会崩 DSH）

- `apply()` 内只做同步注册，禁止网络请求/文件读写等长阻塞操作，全部异步化。
- `tools/pre-execute` 处理器必须 `try...catch` 包裹，`catch` 里 `return next()` 放行。
- 所有分支都必须调用 `next()`，不留短路路径。
- 只具名导出 `name / inject / apply`，不混写 `export default`。
- `inject = ['tools', 'llm']` 保持显式声明。
- 不复制第三方插件源码；参考思路时先查对方 License 并在 README 致谢。
