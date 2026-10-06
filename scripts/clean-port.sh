#!/bin/bash
# clean-port.sh — 释放被孤儿 DSH 进程占用的 3080 端口。
# 背景（2026-10-05 实测）：移动端 DSH 偶发旧进程未退出，新实例抢 3080 报
# webserver EADDRINUSE 而白屏。冷启动白屏时先跑本脚本再启动 DSH；
# 若脚本无效（进程杀不掉），则物理重启手机。
PORT=3080
PIDS=$(lsof -ti :$PORT 2>/dev/null)
if [ -n "$PIDS" ]; then
    echo "释放端口 $PORT，杀掉进程：$PIDS"
    kill -9 $PIDS 2>/dev/null
    sleep 1
fi
echo "端口 $PORT 已就绪"
