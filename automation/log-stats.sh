#!/bin/sh
# 任务C（每日 10:00）：日志异常统计 —— 只读扫描 auto-router.jsonl。
# 产出：daily-reports/log-stats-daily.md
set -u

H=/data/data/com.dsharnessmobile.shell/files/home
LOG="$H/.dsh/logs/auto-router.jsonl"
REPO=/storage/emulated/0/Documents/dsh-auto-model-router
REPORTS="$REPO/daily-reports"
DATE=$(date '+%Y-%m-%d %H:%M:%S %Z')
mkdir -p "$REPORTS"

if [ ! -f "$LOG" ]; then
  echo "## 日志统计 - $DATE
<!-- summary:start -->
- ⚠️ 日志文件不存在：$LOG
### 结论
- ⚠️ 无可扫描日志
<!-- summary:end -->" > "$REPORTS/log-stats-daily.md"
  echo "log-stats: log missing"; exit 0
fi

count() { grep -o "$1" "$LOG" 2>/dev/null | wc -l | tr -d ' '; }

N1=$(count 'system-retry-skipped')
N2=$(count 'downgrade-cooldown-blocked')
N3=$(count 'chat-chain-empty')
TOTAL=$(wc -l < "$LOG" | tr -d ' ')
SIZE=$(wc -c < "$LOG" | tr -d ' ')
LAST_TS=$(tail -1 "$LOG" | sed -n 's/.*"ts":"\([^"]*\)".*/\1/p')
ERRN=$(grep -cE '"error"|"level":"error"|Error:' "$LOG" 2>/dev/null); ERRN=${ERRN:-0}

# 所有 reason / keepReason 取值分布
DIST=$( { grep -oE '"(reason|keepReason)"[[:space:]]*:[[:space:]]*"[^"]*"' "$LOG" 2>/dev/null \
  | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/'; } | sort | uniq -c | sort -rn | head -25 )

ANOMALY="无（三个重点 reason 均为 0，且无 error 行）"
if [ "$N1" -gt 0 ] || [ "$N2" -gt 0 ] || [ "$N3" -gt 0 ] || [ "$ERRN" -gt 0 ]; then
  ANOMALY="system-retry-skipped × $N1，downgrade-cooldown-blocked × $N2，chat-chain-empty × $N3，error 行 $ERRN 条（详见下表，属已知降级/跳过路径，仅记录）"
fi

{
  echo "## 日志统计 - $DATE"
  echo
  echo "<!-- summary:start -->"
  echo "| 重点 reason | 次数 |"
  echo "| --- | --- |"
  echo "| system-retry-skipped | $N1 |"
  echo "| downgrade-cooldown-blocked | $N2 |"
  echo "| chat-chain-empty | $N3 |"
  echo "| error 关键字行 | $ERRN |"
  echo
  echo "- 日志总行数：$TOTAL（$(numfmt --to=iec "$SIZE" 2>/dev/null || echo "$SIZE" B)），最后一条：${LAST_TS:-未知}"
  echo
  echo "### 结论"
  echo "- 异常详情：$ANOMALY"
  echo "<!-- summary:end -->"
  echo
  echo "### reason / keepReason 分布（Top 25）"
  echo '```'
  echo "$DIST"
  echo '```'
  echo
  echo "扫描对象：\`$LOG\`（只读，未修改日志）。"
} > "$REPORTS/log-stats-daily.md"

echo "log-stats done -> $REPORTS/log-stats-daily.md (retry=$N1 cooldown=$N2 chain=$N3 err=$ERRN)"
