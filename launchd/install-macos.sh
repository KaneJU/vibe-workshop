#!/bin/sh
# Install Vibe Workshop as a macOS LaunchAgent: starts at login, restarts if it crashes.
#   ./launchd/install-macos.sh          # this computer only (http://localhost:5310)
#   ./launchd/install-macos.sh --lan    # also reachable from phones on the same network (access key required)
# Uninstall:
#   launchctl bootout gui/$(id -u)/com.vibeworkshop.server
#   rm ~/Library/LaunchAgents/com.vibeworkshop.server.plist
set -eu
LABEL=com.vibeworkshop.server
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)" || { echo "node not found" >&2; exit 1; }
CODEX="$(command -v codex)" || { echo "codex not found (install the OpenAI Codex CLI first)" >&2; exit 1; }
HOST=127.0.0.1
[ "${1:-}" = "--lan" ] && HOST=0.0.0.0
PATH_VALUE="$(dirname "$NODE"):$(dirname "$CODEX"):/usr/bin:/bin:/usr/sbin:/sbin"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$DIR/logs" "$HOME/Library/LaunchAgents"
sed -e "s#__NODE__#$NODE#g" -e "s#__DIR__#$DIR#g" -e "s#__PATH__#$PATH_VALUE#g" -e "s#__HOST__#$HOST#g" \
  "$DIR/launchd/$LABEL.plist" > "$TARGET"
plutil -lint "$TARGET" >/dev/null
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$TARGET"
echo "Vibe Workshop is running: http://localhost:5310 (HOST=$HOST)"
[ "$HOST" = 0.0.0.0 ] && echo "Phone access key: $(cat "$DIR/data/access-key" 2>/dev/null || echo 'created on first start, see data/access-key')"
exit 0
