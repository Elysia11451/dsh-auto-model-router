#!/bin/sh
# 任务B（每日 09:00）：npm test 回归 —— 只读跑测试，不改代码。
# 产出：daily-reports/test-daily.md
set -u

REPO=/storage/emulated/0/Documents/dsh-auto-model-router
REPORTS="$REPO/daily-reports"
DATE=$(date '+%Y-%m-%d %H:%M:%S %Z')
OUT=$(mktemp /data/data/com.dsharnessmobile.shell/files/home/tmp/test-XXXXXX.log 2>/dev/null || echo /tmp/test-$$.log)
mkdir -p "$REPORTS"

cd "$REPO" || exit 1
timeout 900 npm test > "$OUT" 2>&1
RC=$?

OK=$(grep -cE '^(ok|ok -|✔|✅)' "$OUT" 2>/dev/null); OK=${OK:-0}
BAD=$(grep -cE '^(not ok|✖|✗|❌|.*failing)' "$OUT" 2>/dev/null); BAD=${BAD:-0}
LINES=$(wc -l < "$OUT" | tr -d ' ')

if [ "$RC" -eq 0 ]; then
  STATUS="✅ 通过（退出码 0）"
  VERDICT="✅ $OK 条断言通过，0 失败"
else
  STATUS="❌ 失败（退出码 $RC）"
  VERDICT="❌ 失败：$BAD 处异常 / $OK 条通过，需人工介入"
fi

{
  echo "## 单测结果 - $DATE"
  echo
  echo "<!-- summary:start -->"
  echo "- 执行：\`npm test\`（5 个测试文件串联）"
  echo "- 结果：$STATUS"
  echo "- 断言：通过 $OK 条，异常行 $BAD 条，输出共 $LINES 行"
  echo
  echo "### 结论"
  echo "- $VERDICT"
  echo "<!-- summary:end -->"
  echo
  echo "### 输出尾部"
  echo '```'
  if [ "$RC" -eq 0 ]; then
    tail -15 "$OUT"
  else
    tail -60 "$OUT"
  fi
  echo '```'
} > "$REPORTS/test-daily.md"

# 失败时留全量日志供回看
if [ "$RC" -ne 0 ]; then
  cp "$OUT" "$REPORTS/test-daily-full.log" 2>/dev/null
fi
rm -f "$OUT" 2>/dev/null

echo "run-tests done -> $REPORTS/test-daily.md ($STATUS)"
exit 0
