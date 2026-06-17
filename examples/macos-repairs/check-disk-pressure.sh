#!/bin/sh
set -eu

TARGET="${1:-/}"
MIN_FREE_PERCENT="${2:-15}"

available_percent="$(df -Pk "$TARGET" | awk 'NR == 2 { gsub("%", "", $5); print 100 - $5 }')"

if [ -z "$available_percent" ]; then
  echo "Could not determine disk free percentage for $TARGET"
  exit 1
fi

echo "$TARGET has ${available_percent}% free; threshold is ${MIN_FREE_PERCENT}%"

if [ "$available_percent" -lt "$MIN_FREE_PERCENT" ]; then
  exit 1
fi
