#!/bin/sh
set -eu

OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"

echo "== date =="
date

echo
echo "== host =="
hostname
sw_vers 2>/dev/null || true

echo
echo "== disk =="
df -h /

echo
echo "== tailscale =="
if command -v tailscale >/dev/null 2>&1; then
  tailscale status 2>&1 | head -80 || true
elif [ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]; then
  /Applications/Tailscale.app/Contents/MacOS/Tailscale status 2>&1 | head -80 || true
else
  echo "Tailscale CLI not found"
fi

echo
echo "== openclaw gateway =="
"$OPENCLAW_BIN" gateway status 2>&1 | head -120 || true

echo
echo "== imessage channel =="
"$OPENCLAW_BIN" channels status --probe --channel imessage 2>&1 | head -160 || true

echo
echo "== process snapshot =="
ps aux | grep -E 'openclaw|imsg|Messages|ollama|hiveplane' | grep -v grep | head -80 || true

echo
echo "== recent hiveplane incidents =="
tail -40 "$HOME/.hiveplane/incidents.jsonl" 2>/dev/null || true
