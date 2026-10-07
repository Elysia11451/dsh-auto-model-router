#!/bin/sh
# 每日汇总：抽取三份报告的 summary 块，合成 daily-summary.md，并按日期归档。
set -u

REPO=/storage/emulated/0/Documents/dsh-auto-model-router
REPORTS="$REPO/daily-reports"
DATE=$(date '+%Y-%m-%d')
NOW=$(date '+%Y-%m-%d %H:%M:%S %Z')
mkdir -p "$REPORTS/archive/$DATE"

extract() { # $1=file -> 打印 summary:start..end 之间内容
  awk '/<!-- summary:start -->/{f=1;next} /<!-- summary:end -->/{f=0} f' "$1" 2>/dev/null
}

BAD=""
grep -q '❌' "$REPORTS/test-daily.md" 2>/dev/null && BAD="$BAD 单测失败。"
grep -qE '🔄|⚠️' "$REPORTS/compatibility-report.md" 2>/dev/null && BAD="$BAD 兼容性检查有告警/新版本。"
grep -qE 'error 关键字行 \| [1-9]' "$REPORTS/log-stats-daily.md" 2>/dev/null && BAD="$BAD 日志存在 error 行。"
[ -z "$BAD" ] && ADVICE="无需人工介入" || ADVICE="需人工查看：$BAD"

{
  echo "## 每日汇总 - $DATE"
  echo
  echo "> 生成时间：$NOW · 由 automation/summary.sh 自动汇总"
  echo
  echo "### 兼容性"
  extract "$REPORTS/compatibility-report.md"
  echo
  echo "### 单测"
  extract "$REPORTS/test-daily.md"
  echo
  echo "### 日志异常"
  extract "$REPORTS/log-stats-daily.md"
  echo
  echo "### 建议"
  echo "- $ADVICE"
} > "$REPORTS/daily-summary.md"

# 按日期归档当日四份报告（同日覆盖，保留当日最新）
cp "$REPORTS/compatibility-report.md" "$REPORTS/test-daily.md" \
   "$REPORTS/log-stats-daily.md" "$REPORTS/daily-summary.md" \
   "$REPORTS/archive/$DATE/" 2>/dev/null

echo "summary done -> $REPORTS/daily-summary.md (advice=$ADVICE)"
