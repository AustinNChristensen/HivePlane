#!/bin/sh
set -eu

LABEL="${HIVEPLANE_BEE_LAUNCHD_LABEL:-com.hiveplane.bee}"
DOMAIN="${HIVEPLANE_BEE_LAUNCHD_DOMAIN:-gui/$(id -u)}"

echo "Before restart:"
launchctl print "$DOMAIN/$LABEL" 2>&1 | head -80 || true

echo "Restarting $DOMAIN/$LABEL..."
launchctl kickstart -k "$DOMAIN/$LABEL"

echo "After restart:"
launchctl print "$DOMAIN/$LABEL" 2>&1 | head -80
