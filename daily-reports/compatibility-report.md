## 兼容性检查 - 2026-10-07 10:43:13 CST

<!-- summary:start -->
| 组件 | 已装 | 最新/基准 | 状态 |
| --- | --- | --- | --- |
| DSH 宿主 | 0.2.0-rc.2 | 0.2.0-rc.2 | ✅ 无更新 |
| @xmanrui/dsh-im | 4.36.1 | 4.36.1 | ✅ 无更新 |
| dsh-our-free-model | 2.0.0 | npm 未发布（link 本地包） | ✅ 本地包，跳过远端比对 |
| dsh-auto-model-router（自身） | 0.8.5 | 未发布 | ℹ️ v0.8.6 预览版尚未发布/研究中，不做发布比对 |
| dsh-cron（调度） | unknown | — | ℹ️ 未安装（与 DSH 0.2.0-rc.2 peer 不兼容，暂缓，见 automation/issues.md） |
| dsh-auto-continue（续跑） | 0.5.2 | — | ✅ 已安装 |

### 结论
- ✅ 全部通过
<!-- summary:end -->

### 检查方式
- DSH 宿主 / dsh-im：`npm view <pkg> version` 与 profile node_modules 已装版本比对（只读）。
- dsh-our-free-model：`link:` 本地包（npm 404 无发布），仅记录本地版本。
- 本脚本不执行任何升级、不改任何配置文件。
