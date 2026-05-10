#!/bin/sh
# HivePlane Hive installer.
#
# Installs the Hive control plane on this machine and starts it in the
# foreground. By default it binds to 0.0.0.0:8787 so other machines on the
# Tailnet/LAN can reach it. Override with --host / --port.
#
# Idempotent: safe to re-run to upgrade an existing install.

set -eu

INSTALL_DIR="${HIVEPLANE_INSTALL_DIR:-$HOME/.hiveplane/install}"
REPO_URL="${HIVEPLANE_REPO_URL:-https://github.com/AustinNChristensen/HivePlane.git}"
REPO_REF="${HIVEPLANE_REPO_REF:-main}"
HIVE_HOST="${HIVE_HOST:-0.0.0.0}"
HIVE_PORT="${HIVE_PORT:-8787}"

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HIVE_HOST="$2"; shift 2 ;;
    --port) HIVE_PORT="$2"; shift 2 ;;
    --no-start) NO_START=1; shift ;;
    -h|--help)
      cat <<USAGE
HivePlane Hive installer

Usage:
  hive.sh [--host 0.0.0.0] [--port 8787] [--no-start]

Env:
  HIVE_HOST, HIVE_PORT
  HIVEPLANE_INSTALL_DIR (default ~/.hiveplane/install)
USAGE
      exit 0
      ;;
    *) printf '[hive install error] unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

color_info='\033[1;36m'
color_warn='\033[1;33m'
color_err='\033[1;31m'
color_off='\033[0m'

log()  { printf '%b[hive install]%b %s\n' "$color_info" "$color_off" "$1"; }
warn() { printf '%b[hive install]%b %s\n' "$color_warn" "$color_off" "$1"; }
err()  { printf '%b[hive install error]%b %s\n' "$color_err" "$color_off" "$1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || err "Node 20+ required. Install from https://nodejs.org/ first."
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 20 ] || err "Node 20+ required (you have $(node -v))."
command -v git >/dev/null 2>&1 || err "git is required."

if ! command -v pnpm >/dev/null 2>&1; then
  log "pnpm not found, enabling via corepack..."
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    log "installing pnpm globally via npm..."
    npm install -g pnpm >/dev/null
  fi
fi

mkdir -p "$(dirname "$INSTALL_DIR")"
if [ -d "$INSTALL_DIR/.git" ]; then
  log "updating existing install at $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --quiet origin "$REPO_REF"
  git -C "$INSTALL_DIR" reset --hard "origin/$REPO_REF"
else
  log "cloning $REPO_URL → $INSTALL_DIR"
  git clone --quiet --branch "$REPO_REF" "$REPO_URL" "$INSTALL_DIR"
fi

log "installing dependencies..."
(cd "$INSTALL_DIR" && pnpm install --frozen-lockfile --silent)

log "Hive installed at $INSTALL_DIR"

if [ "${NO_START:-}" = "1" ]; then
  echo
  echo "Skipping startup (--no-start). Start later with:"
  echo "  cd $INSTALL_DIR && pnpm --filter @hiveplane/web start -- --host $HIVE_HOST --port $HIVE_PORT"
  exit 0
fi

echo
echo "Starting Hive on $HIVE_HOST:$HIVE_PORT (Ctrl-C to stop)..."
echo "Connect Bees with:"
echo "  hive login http://$(hostname):$HIVE_PORT"
echo
cd "$INSTALL_DIR"
exec pnpm --silent --filter @hiveplane/web start -- --host "$HIVE_HOST" --port "$HIVE_PORT"
