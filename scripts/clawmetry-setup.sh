#!/usr/bin/env bash
# Installs ClawMetry (the OpenClaw observability dashboard, https://github.com/vivekchand/clawmetry)
# into a private virtualenv at .runtime/clawmetry-venv. Nothing is installed globally.
# Start it afterwards with `pnpm clawmetry`.
set -euo pipefail

CLAWMETRY_VERSION="0.12.915" # pinned; verified with this project (OTLP/JSON traces from our agents)
# ClawMetry's own dependencies float (duckdb>=0.10, flask<4, ...): pin the verified set too.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$ROOT/.runtime/clawmetry-venv"
PYTHON="${PYTHON:-python3}"

if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "python3 not found. Install Python 3.8+ (macOS: xcode-select --install, or https://www.python.org/downloads/)." >&2
  exit 1
fi
if ! "$PYTHON" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'; then
  echo "ClawMetry needs Python >= 3.8, found $("$PYTHON" --version 2>&1)." >&2
  exit 1
fi

if [[ ! -x "$VENV/bin/python" ]]; then
  echo "Creating virtualenv $VENV"
  "$PYTHON" -m venv "$VENV"
fi

echo "Installing clawmetry[otel]==$CLAWMETRY_VERSION into $VENV"
# A bounded pip: new enough for current wheels, never a major version nobody tested.
"$VENV/bin/python" -m pip install --disable-pip-version-check --quiet --upgrade "pip<27"
"$VENV/bin/python" -m pip install --disable-pip-version-check --quiet \
  -c "$ROOT/scripts/clawmetry-constraints.txt" "clawmetry[otel]==$CLAWMETRY_VERSION"

echo "Installed: $("$VENV/bin/clawmetry" --version 2>/dev/null || echo "clawmetry $CLAWMETRY_VERSION")"
echo "Start it with: pnpm clawmetry   (dashboard + OTLP receiver on http://127.0.0.1:8900)"
