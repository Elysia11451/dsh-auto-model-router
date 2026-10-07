#!/bin/sh
# 任务A（每日 08:00）：兼容性检查 —— 只读，不升级任何东西。
# 产出：daily-reports/compatibility-report.md
set -u

REPO=/storage/emulated/0/Documents/dsh-auto-model-router
H=/data/data/com.dsharnessmobile.shell/files/home
REPORTS="$REPO/daily-reports"
WEB_NM="$H/.dsh/profiles/web/node_modules"
DATE=$(date '+%Y-%m-%d %H:%M:%S %Z')
mkdir -p "$REPORTS"

# 读取某包已安装版本；读不到输出 unknown
ver_of() {
  node -e "try{console.log(require('$WEB_NM/$1/package.json').version)}catch(e){console.log('unknown')}" 2>/dev/null || echo unknown
}

# npm 最新版；网络失败输出 unreachable
npm_latest() {
  v=$(npm view "$1" version --fetch-timeout=15000 2>/dev/null | tail -1)
  case "$v" in
    ""|*error*|*ERR*) echo unreachable ;;
    *) echo "$v" ;;
  esac
}

INST_DSH=$(dsh --version 2>/dev/null | tail -1); [ -z "$INST_DSH" ] && INST_DSH=$(node -e "try{console.log(require('$H/.dsh/profiles/web/node_modules/@deepseek-ai/dsh/package.json').version)}catch(e){console.log('unknown')}")
LATEST_DSH=$(npm_latest '@deepseek-ai/dsh')

INST_IM=$(ver_of '@xmanrui/dsh-im')
LATEST_IM=$(npm_latest '@xmanrui/dsh-im')

# dsh-our-free-model：link 本地包，npm 无发布
OFM=$(ver_of 'dsh-our-free-model')

INST_ROUTER=$(node -e "try{console.log(require('$REPO/package.json').version)}catch(e){console.log('unknown')}")

INST_CRON=$(ver_of 'dsh-cron')
INST_CONT=$(ver_of 'dsh-auto-continue')

# 状态判定
stat_pair() { # $1=installed $2=latest
  if [ "$2" = "unreachable" ]; then echo "⚠️ 无法访问 npm，跳过比对"
  elif [ "$1" = "$2" ]; then echo "✅ 无更新"
  elif [ "$1" = "unknown" ]; then echo "⚠️ 读不到已装版本"
  else echo "🔄 有更新（$1 → $2，仅记录，未升级）"
  fi
}

S_DSH=$(stat_pair "$INST_DSH" "$LATEST_DSH")
S_IM=$(stat_pair "$INST_IM" "$LATEST_IM")

VERDICT="✅ 全部通过"
case "$S_DSH$S_IM" in *🔄*) VERDICT="⚠️ 发现新版本（仅记录，不自动升级）" ;; *⚠️*) VERDICT="⚠️ 部分检查未完成（网络/读取失败），详见上表" ;; esac

cat > "$REPORTS/compatibility-report.md" <<EOF
## 兼容性检查 - $DATE

<!-- summary:start -->
| 组件 | 已装 | 最新/基准 | 状态 |
| --- | --- | --- | --- |
| DSH 宿主 | $INST_DSH | $LATEST_DSH | $S_DSH |
| @xmanrui/dsh-im | $INST_IM | $LATEST_IM | $S_IM |
| dsh-our-free-model | $OFM | npm 未发布（link 本地包） | ✅ 本地包，跳过远端比对 |
| dsh-auto-model-router（自身） | $INST_ROUTER | 未发布 | ℹ️ v0.8.6 预览版尚未发布/研究中，不做发布比对 |
| dsh-cron（调度） | $INST_CRON | — | $( [ "$INST_CRON" = "unknown" ] && echo "ℹ️ 未安装（与 DSH 0.2.0-rc.2 peer 不兼容，暂缓，见 automation/issues.md）" || echo "✅ 已安装" ) |
| dsh-auto-continue（续跑） | $INST_CONT | — | $( [ "$INST_CONT" = "unknown" ] && echo "⚠️ 未安装" || echo "✅ 已安装" ) |

### 结论
- $VERDICT
<!-- summary:end -->

### 检查方式
- DSH 宿主 / dsh-im：\`npm view <pkg> version\` 与 profile node_modules 已装版本比对（只读）。
- dsh-our-free-model：\`link:\` 本地包（npm 404 无发布），仅记录本地版本。
- 本脚本不执行任何升级、不改任何配置文件。
EOF

echo "compat-check done -> $REPORTS/compatibility-report.md ($VERDICT)"
