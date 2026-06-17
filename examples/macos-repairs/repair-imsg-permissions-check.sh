#!/bin/sh
set -eu

OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"
IMSG_BIN="${IMSG_BIN:-/opt/homebrew/bin/imsg}"

echo "Messages process:"
pgrep -fl Messages || true

echo
echo "imsg binary:"
if [ -x "$IMSG_BIN" ]; then
  "$IMSG_BIN" --help 2>&1 | head -20 || true
else
  echo "imsg not executable at $IMSG_BIN"
fi

echo
echo "OpenClaw iMessage probe:"
if "$OPENCLAW_BIN" channels status --probe --channel imessage; then
  exit 0
fi

cat <<'EOF'

iMessage probe failed after CLI-level checks.

If Messages.app is signed in and the Mac is reachable through remote GUI, check:
- Full Disk Access for the terminal/service runtime running OpenClaw/imsg.
- Automation permission allowing that runtime to control Messages.app.
- Messages.app account state and any Apple ID / 2FA prompt.

This class of issue needs remote GUI or account-owner action if permissions were not granted during setup.
EOF

exit 2
