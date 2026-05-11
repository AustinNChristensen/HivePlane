#!/bin/sh
# HivePlane Hive installer.
#
# Installs the Hive control plane on this machine. By default it writes a
# launchd (macOS) / systemd-user (Linux) service unit so the Hive survives
# reboots, then starts it. Pass --foreground to skip the service install and
# run the Hive interactively instead (useful for development).
#
# Either way it binds to 0.0.0.0:4483 by default so other machines on the
# Tailnet/LAN can reach it. Override with --host / --port.
#
# Idempotent: safe to re-run to upgrade an existing install.

set -eu

INSTALL_DIR="${HIVEPLANE_INSTALL_DIR:-$HOME/.hiveplane/install}"
CONFIG_DIR="${HIVEPLANE_CONFIG_DIR:-$HOME/.hiveplane}"
BIN_DIR="${HIVEPLANE_BIN_DIR:-$HOME/.local/bin}"
REPO_URL="${HIVEPLANE_REPO_URL:-https://github.com/AustinNChristensen/HivePlane.git}"
REPO_REF="${HIVEPLANE_REPO_REF:-main}"
HIVE_HOST="${HIVE_HOST:-0.0.0.0}"
# 4483 = "HIVE" on a phone keypad. Picked because the 4xxx range is much less
# crowded than the 3000/5000/8000/8787/9000 cluster of dev-server defaults
# (Selenium 4444, Sinatra 4567, GlassFish 4848 are the only neighbours and
# none of them are common). v0.0.2 defaulted to 8787 and immediately hit a
# real-world collision with another local dev server — see the v0.0.3
# release notes.
HIVE_PORT="${HIVE_PORT:-4483}"
MODE="service"   # "service" (default) or "foreground"

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HIVE_HOST="$2"; shift 2 ;;
    --port) HIVE_PORT="$2"; shift 2 ;;
    --foreground) MODE="foreground"; shift ;;
    --no-start) NO_START=1; shift ;;
    -h|--help)
      cat <<USAGE
HivePlane Hive installer

Usage:
  hive.sh [--host 0.0.0.0] [--port 4483] [--foreground] [--no-start]

By default installs a launchd / systemd-user service unit and starts it,
so the Hive survives reboots. Use --foreground to run interactively
without installing a service unit (useful for development).

Env:
  HIVE_HOST, HIVE_PORT
  HIVEPLANE_INSTALL_DIR (default ~/.hiveplane/install)
  HIVEPLANE_CONFIG_DIR  (default ~/.hiveplane)
  HIVEPLANE_BIN_DIR     (default ~/.local/bin)
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

# Drop the `hive` shim so `hive selfhost ...` is on PATH after first install.
mkdir -p "$BIN_DIR"
HIVE_SHIM="$BIN_DIR/hive"
cat > "$HIVE_SHIM" <<EOF
#!/bin/sh
exec "$INSTALL_DIR/node_modules/.bin/tsx" "$INSTALL_DIR/packages/cli/src/index.ts" "\$@"
EOF
chmod +x "$HIVE_SHIM"

log "Hive installed at $INSTALL_DIR"
log "  shim: $HIVE_SHIM"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on PATH. Add: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# --- port pre-flight -------------------------------------------------------
#
# v0.0.2 shipped with default port 8787, which collided with another local dev
# server on a real install. The Hive bound to *:8787 successfully but was
# shadowed by 127.0.0.1:8787 — kernel routing prefers the more-specific bind,
# so localhost requests reached the squatter and the operator chased a 404.
# v0.0.3 changed the default to 4483 to make collisions less likely; this
# pre-flight check is the actual fix — refuse to install if anything is
# already listening on the chosen port, with a clear pointer to whatever
# process is squatting it.
#
# Skipped silently when neither lsof nor ss is available (Windows/WSL1/some
# minimal containers); in that case the existing post-install crash-loop is
# still better than nothing, and the operator can always re-run with --port.
check_port_in_use() {
  port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null
    return $?
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH "sport = :$port" 2>/dev/null
    return $?
  fi
  return 1
}

if [ "$MODE" = "service" ] && [ "${NO_START:-}" != "1" ]; then
  conflict=$(check_port_in_use "$HIVE_PORT" || true)
  if [ -n "$conflict" ]; then
    err "port $HIVE_PORT is already in use:

$conflict

Pick a different port with --port, or stop the conflicting process first.
The Hive cannot start on an already-bound port (and binding to 0.0.0.0 would
still be shadowed for localhost requests by the more-specific bind above)."
  fi
fi

if [ "${NO_START:-}" = "1" ]; then
  echo
  echo "Skipping startup (--no-start). Next steps:"
  echo "  hive selfhost init       # generate hive-config.json + admin token"
  echo "  hive selfhost install    # install the launchd/systemd unit"
  echo "  hive selfhost start      # start the service"
  exit 0
fi

if [ "$MODE" = "foreground" ]; then
  echo
  echo "Starting Hive on $HIVE_HOST:$HIVE_PORT (Ctrl-C to stop)..."
  echo "Foreground mode — no service unit installed; the Hive will not survive reboots."
  echo "Connect Bees with:"
  echo "  hive login                       # interactive prompt for URL + pairing key"
  echo "  # or, scripted:"
  echo "  hive login http://$(hostname):$HIVE_PORT --pairing-key <key-from-dashboard>"
  echo
  cd "$INSTALL_DIR"
  exec pnpm --silent --filter @hiveplane/web start -- --host "$HIVE_HOST" --port "$HIVE_PORT"
fi

# Service mode: write config (idempotent), install unit, start it.
log "writing $CONFIG_DIR/hive-config.json + installing service unit"
"$HIVE_SHIM" --config-dir "$CONFIG_DIR" selfhost up \
  --host "$HIVE_HOST" --port "$HIVE_PORT"

echo
echo "Hive is running as a service and will survive reboots."
echo "Connect Bees with:"
echo "  hive login                       # interactive prompt for URL + pairing key"
echo "  # or, scripted:"
echo "  hive login http://$(hostname):$HIVE_PORT --pairing-key <key-from-dashboard>"
echo
echo "Manage the Hive with:"
echo "  hive selfhost status"
echo "  hive selfhost logs -f"
echo "  hive selfhost stop"
echo "  hive selfhost uninstall"
