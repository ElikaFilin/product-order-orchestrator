#!/usr/bin/env bash
# Fallback for BROWSER_MODE=cdp, when the Playwright MCP Bridge extension cannot be used: starts Google Chrome
# with a dedicated profile for this project and remote debugging on 127.0.0.1:$PORT. Your normal Chrome profiles
# are not touched. The shop basket then lives only in this profile, so open the basket link COS sends you in
# this Chrome window.
# Usage: pnpm browser:chrome [extra Chrome flags]      (CHROME_DEBUG_PORT=9333 by default)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# A dedicated name: a generic PORT exported for some web project must not move this port.
PORT="${CHROME_DEBUG_PORT:-9333}"
PROFILE_DIR="${PROFILE_DIR:-$HOME/.product-order-orchestrator/chrome-profile}"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
START_URL="${START_URL:-https://karashynyard.com.ua/}"
LOG="$ROOT/.runtime/logs/chrome-profile.log"

version_url="http://127.0.0.1:$PORT/json/version"
browser_line() { curl -fsS --max-time 2 "$version_url" 2>/dev/null | grep -m1 '"Browser"' | sed -E 's/^[[:space:]]*//; s/,$//'; }

print_next_steps() {
  cat <<NEXT
Put these lines into .env (then restart pnpm start):
  BROWSER_MODE=cdp
  BROWSER_CDP_URL=http://127.0.0.1:$PORT

The basket then lives only in this Chrome window: open the basket link COS sends you here.

Security note: while this Chrome runs, any program on this Mac running under your user can control it
through port $PORT (127.0.0.1 only). Log in to the shop in this window only if you need to.
NEXT
}

if line="$(browser_line)" && [[ -n "$line" ]]; then
  echo "A browser already answers on port $PORT: $line"
  print_next_steps
  exit 0
fi
if [[ ! -x "$CHROME" ]]; then
  echo "Google Chrome not found at: $CHROME (set CHROME=/path/to/chrome)" >&2
  exit 1
fi

mkdir -p "$PROFILE_DIR" "$(dirname "$LOG")"
echo "Starting Chrome (profile: $PROFILE_DIR, log: $LOG)"
nohup "$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  "$@" \
  "$START_URL" >>"$LOG" 2>&1 &
PID=$!

for _ in $(seq 1 30); do
  if line="$(browser_line)" && [[ -n "$line" ]]; then
    echo "Ready (pid $PID): $line"
    print_next_steps
    exit 0
  fi
  sleep 1
done
echo "Chrome did not open port $PORT within 30 s. See $LOG" >&2
exit 1
