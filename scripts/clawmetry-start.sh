#!/usr/bin/env bash
# Runs ClawMetry (the OpenClaw observability dashboard) on 127.0.0.1:8900 until Ctrl+C.
# Our agents export OpenTelemetry spans to its OTLP receiver at http://127.0.0.1:8900/v1/traces
# (loopback senders need no token).
#
# ClawMetry is two processes: the dashboard (HTTP + OTLP receiver) and a sync daemon that owns its
# DuckDB store; without the daemon the receiver answers 503 "store_unavailable". This script runs
# both and stops both on exit.
#
# Privacy defaults (see ClawMetry's docs/EGRESS.md):
#   - its own HOME under .runtime/clawmetry-home: it keeps its data there and does not read your
#     personal agent folders (~/.claude, ~/.codex, ...); it only shows what this project sends it;
#   - no install ping, no PyPI update checks or self-updates, no cloud sync, no LLM calls;
#   - no sign-in gate and no launchd service: nothing keeps running after Ctrl+C;
#   - production server (waitress) instead of Flask's debug server.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$ROOT/.runtime/clawmetry-venv"
CLAWMETRY_HOME_DIR="$ROOT/.runtime/clawmetry-home"
LOG_DIR="$ROOT/.runtime/logs"
HOST="${CLAWMETRY_HOST:-127.0.0.1}"
PORT="${CLAWMETRY_PORT:-8900}"

if [[ ! -x "$VENV/bin/clawmetry" ]]; then
  echo "ClawMetry is not installed. Run: pnpm clawmetry:setup" >&2
  exit 1
fi
if curl -fsS -o /dev/null --max-time 2 "http://$HOST:$PORT/api/otel-status" 2>/dev/null; then
  echo "ClawMetry is already running at http://$HOST:$PORT"
  exit 0
fi

mkdir -p "$CLAWMETRY_HOME_DIR" "$LOG_DIR"
# Our agents' secrets are not ClawMetry's business (an ANTHROPIC_API_KEY would enable its alert narrator).
unset ANTHROPIC_API_KEY TELEGRAM_BOT_TOKEN

export HOME="$CLAWMETRY_HOME_DIR"
export CLAWMETRY_HOME="$CLAWMETRY_HOME_DIR"
export CLAWMETRY_OFFLINE=1           # suppress every discretionary outbound request
export CLAWMETRY_NO_CLOUD=1          # never upload anything
export CLAWMETRY_AUTO_UPDATE=0       # never pip-install a newer version by itself
export CLAWMETRY_NO_TELEMETRY=1 DO_NOT_TRACK=1
export CLAWMETRY_NARRATOR_ENABLED=0
export CLAWMETRY_AUTO_INGEST=0       # the dashboard must not spawn its own detached daemon: we run it below
export CLAWMETRY_OTLP_PORT_DISABLE=1 # do not also grab :4318
# Every answer on ClawMetry's first-run "Welcome" gate registers a launchd KeepAlive service that keeps
# a daemon running after you stop this script. This setup needs no account, so skip the gate.
export CLAWMETRY_SKIP_ONBOARDING=1
export PYTHONUNBUFFERED=1
cd "$CLAWMETRY_HOME_DIR"

DAEMON_PID=""
DASHBOARD_PID=""
cleanup() {
  for pid in $DASHBOARD_PID $DAEMON_PID; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The daemon needs a local-only config on first run (an empty api_key keeps cloud sync off).
"$VENV/bin/python" -c 'from clawmetry.sync import ensure_local_config; ensure_local_config()'
"$VENV/bin/python" -m clawmetry.sync >>"$LOG_DIR/clawmetry-sync.log" 2>&1 &
DAEMON_PID=$!

echo "ClawMetry: http://$HOST:$PORT  (OTLP receiver /v1/traces; data in $CLAWMETRY_HOME_DIR; daemon log $LOG_DIR/clawmetry-sync.log)"
"$VENV/bin/clawmetry" --host "$HOST" --port "$PORT" --no-debug "$@" &
DASHBOARD_PID=$!
wait "$DASHBOARD_PID"
