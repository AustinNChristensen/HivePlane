#!/bin/sh
set -eu

echo "Disk before cleanup:"
df -h /

if [ "${HIVEPLANE_CLEANUP_CONFIRM:-}" != "1" ]; then
  cat <<'EOF'

Dry run only. Set HIVEPLANE_CLEANUP_CONFIRM=1 for this repair script to remove known disposable files.

Candidate targets:
- ~/.openclaw/tmp files older than 7 days
- ~/.hiveplane/tmp files older than 7 days
- ~/Library/Logs/OpenClaw *.log files older than 14 days
EOF
  exit 2
fi

find "$HOME/.openclaw/tmp" -type f -mtime +7 -print -delete 2>/dev/null || true
find "$HOME/.hiveplane/tmp" -type f -mtime +7 -print -delete 2>/dev/null || true
find "$HOME/Library/Logs/OpenClaw" -type f -name "*.log" -mtime +14 -print -delete 2>/dev/null || true

echo
echo "Disk after cleanup:"
df -h /
