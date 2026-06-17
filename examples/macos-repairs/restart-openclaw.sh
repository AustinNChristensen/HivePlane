#!/bin/sh
set -eu

OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"

echo "Before restart:"
"$OPENCLAW_BIN" gateway status || true

echo "Restarting OpenClaw gateway..."
"$OPENCLAW_BIN" gateway restart

echo "After restart:"
"$OPENCLAW_BIN" gateway status
