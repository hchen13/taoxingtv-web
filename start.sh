#!/bin/zsh
# 淘星TV 常驻守护进程 —— 只有这个一直开着(约40MB),模拟器按需起/闲时关
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ADB="$ANDROID_HOME/platform-tools/adb"
export EMULATOR="$ANDROID_HOME/emulator/emulator"
export AVD=TaoxingTV
export PORT=${PORT:-8090}
export IDLE_MS=${IDLE_MS:-90000}
cd "$(dirname "$0")"

case "$1" in
  stop)
    "$ADB" emu kill 2>/dev/null
    pkill -f "node .*taoxingtv/server.js" 2>/dev/null && echo "已停止" || echo "未运行"
    exit 0 ;;
esac

if pgrep -f "node .*taoxingtv/server.js" >/dev/null; then
  echo "服务已在运行: http://localhost:$PORT"
else
  nohup node server.js > /tmp/taoxingtv-server.log 2>&1 &
  echo "淘星TV 已启动: http://localhost:$PORT"
  echo "  打开网页即按需唤醒引擎(约7秒),关掉网页闲置${IDLE_MS}ms后自动释放内存"
fi
