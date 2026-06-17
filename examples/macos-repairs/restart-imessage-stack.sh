#!/bin/sh
set -eu

OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"

echo "Stopping Messages.app if running..."
osascript -e 'tell application "Messages" to quit' >/dev/null 2>&1 || true
sleep 2

echo "Opening Messages.app..."
open -a Messages
sleep 5

echo "Restarting OpenClaw gateway so imsg channel state refreshes..."
"$OPENCLAW_BIN" gateway restart || true

echo "Probing OpenClaw iMessage channel..."
"$OPENCLAW_BIN" channels status --probe --channel imessage
