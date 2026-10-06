# Security Policy

## 支持的版本

| Version | Supported |
| ------- | --------- |
| 0.2.x   | ✅        |
| < 0.2.0 | ❌（v0.1.x 直接调用 session/selectModel，已废弃） |

## 报告漏洞

请通过 GitHub Issues（Security 标签）或仓库预留的私密联系方式报告，不要在公开 issue 里贴密钥、token、聊天记录等敏感信息。

## 安全设计

- 插件不收集、不外发任何数据；路由决策纯本地（关键词 + 会话来源）。
- 唯一的外发面是 `our-free-model` 本身（请求发往 OpenCode Zen 等第三方网关），隐私风险见 README 隐私声明。
- `tools/pre-execute` 钩子永不阻断工具链：任何内部异常都 `return next()` 放行。
