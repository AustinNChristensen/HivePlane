#!/bin/sh
set -eu

LABEL="${HIVEPLANE_BEE_LAUNCHD_LABEL:-com.hiveplane.bee}"
DOMAIN="${HIVEPLANE_BEE_LAUNCHD_DOMAIN:-gui/$(id -u)}"

launchctl print "$DOMAIN/$LABEL" 2>&1 | head -80
