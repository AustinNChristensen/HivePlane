#!/bin/sh
# HivePlane Bee installer.
#
# Installs the Bee daemon + the `bee` CLI on this machine.
#
# Default mode installs only. After install, configure with:
#
#   bee login <hive-url>
#   bee start
#
# One-command mode installs, pairs, and starts when these env vars are supplied:
#
#   HIVEPLANE_HIVE_URL=http://hive.local:4483
#   HIVEPLANE_PAIRING_KEY=K7RQ-2P9X
#
# Idempotent: safe to re-run to upgrade an existing install.

set -eu

INSTALL_DIR="${HIVEPLANE_INSTALL_DIR:-$HOME/.hiveplane/install}"
BIN_DIR="${HIVEPLANE_BIN_DIR:-$HOME/.local/bin}"
REPO_URL="${HIVEPLANE_REPO_URL:-https://github.com/AustinNChristensen/HivePlane.git}"
REPO_REF="${HIVEPLANE_REPO_REF:-main}"

color_info='\033[1;36m'
color_warn='\033[1;33m'
color_err='\033[1;31m'
color_off='\033[0m'

log()  { printf '%b[bee install]%b %s\n' "$color_info" "$color_off" "$1"; }
warn() { printf '%b[bee install]%b %s\n' "$color_warn" "$color_off" "$1"; }
err()  { printf '%b[bee install error]%b %s\n' "$color_err" "$color_off" "$1" >&2; exit 1; }

# --- prerequisites ---------------------------------------------------------
command -v node >/dev/null 2>&1 || err "Node 20+ is required. Install from https://nodejs.org/ or via your package manager, then re-run."
node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt 20 ]; then
  err "Node 20+ required (you have $(node -v))."
fi
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

# --- clone / update --------------------------------------------------------
mkdir -p "$(dirname "$INSTALL_DIR")"
if [ -d "$INSTALL_DIR/.git" ]; then
  log "updating existing install at $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --quiet origin "$REPO_REF"
  git -C "$INSTALL_DIR" reset --hard "origin/$REPO_REF"
else
  log "cloning $REPO_URL → $INSTALL_DIR"
  git clone --quiet --branch "$REPO_REF" "$REPO_URL" "$INSTALL_DIR"
fi

# --- dependencies ----------------------------------------------------------
log "installing dependencies (this may take a minute on first run)..."
(cd "$INSTALL_DIR" && pnpm install --frozen-lockfile --silent)

# --- bin shims -------------------------------------------------------------
# v0.0.5 split the CLI into two binaries:
#   bee — worker-daemon operations on this machine (login/start/logs/...)
#   hive — control-plane operations (installed by hive.sh on the Hive box)
# A Bee install only drops the `bee` user-facing binary; the daemon entry
# (`hiveplane-bee`) stays for launchd/systemd to exec.
mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/bee" <<EOF
#!/bin/sh
cd "$INSTALL_DIR" && exec pnpm --silent --filter @hiveplane/cli bee "\$@"
EOF
chmod +x "$BIN_DIR/bee"

cat > "$BIN_DIR/hiveplane-bee" <<EOF
#!/bin/sh
cd "$INSTALL_DIR" && exec pnpm --silent --filter @hiveplane/daemon start "\$@"
EOF
chmod +x "$BIN_DIR/hiveplane-bee"

cat > "$BIN_DIR/hiveplane-rescue" <<EOF
#!/bin/sh
cd "$INSTALL_DIR" && exec pnpm --silent --filter @hiveplane/daemon rescue "\$@"
EOF
chmod +x "$BIN_DIR/hiveplane-rescue"

# --- identity --------------------------------------------------------------
log "ensuring Bee identity exists..."
"$BIN_DIR/bee" identity init >/dev/null

# --- summary ---------------------------------------------------------------
log "Bee installed."
echo
echo "  Install dir: $INSTALL_DIR"
echo "  bee CLI:     $BIN_DIR/bee"
echo "  daemon:      $BIN_DIR/hiveplane-bee"
echo "  rescue:      $BIN_DIR/hiveplane-rescue"
echo
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on \$PATH. Add to your shell rc:"
     echo "    export PATH=\"$BIN_DIR:\$PATH\""
     echo
     ;;
esac

if [ -n "${HIVEPLANE_HIVE_URL:-}" ] || [ -n "${HIVEPLANE_PAIRING_KEY:-}" ] || [ -n "${HIVEPLANE_BOOTSTRAP_TOKEN:-}" ]; then
  [ -n "${HIVEPLANE_HIVE_URL:-}" ] || err "HIVEPLANE_HIVE_URL is required for one-command pairing."
  if [ -n "${HIVEPLANE_PAIRING_KEY:-}" ] && [ -n "${HIVEPLANE_BOOTSTRAP_TOKEN:-}" ]; then
    err "Set only one of HIVEPLANE_PAIRING_KEY or HIVEPLANE_BOOTSTRAP_TOKEN."
  fi
  if [ -z "${HIVEPLANE_PAIRING_KEY:-}" ] && [ -z "${HIVEPLANE_BOOTSTRAP_TOKEN:-}" ]; then
    err "HIVEPLANE_PAIRING_KEY or HIVEPLANE_BOOTSTRAP_TOKEN is required for one-command pairing."
  fi

  log "pairing with Hive at $HIVEPLANE_HIVE_URL..."
  set -- "$HIVEPLANE_HIVE_URL"
  if [ -n "${HIVEPLANE_BEE_NAME:-}" ]; then
    set -- "$@" --name "$HIVEPLANE_BEE_NAME"
  fi
  if [ -n "${HIVEPLANE_PAIRING_KEY:-}" ]; then
    set -- "$@" --pairing-key "$HIVEPLANE_PAIRING_KEY"
  else
    set -- "$@" --token "$HIVEPLANE_BOOTSTRAP_TOKEN"
  fi
  if [ "${HIVEPLANE_NO_START:-}" = "1" ] || [ "${HIVEPLANE_NO_START:-}" = "true" ]; then
    set -- "$@" --no-start
  fi
  "$BIN_DIR/bee" login "$@"
  echo
  log "Bee paired."
  if [ "${HIVEPLANE_NO_START:-}" = "1" ] || [ "${HIVEPLANE_NO_START:-}" = "true" ]; then
    echo "Next:"
    echo "  bee start                 # auto-installs launchd/systemd unit + heartbeats"
  else
    echo "Next:"
    echo "  bee status                # confirm session + service state"
    echo "  bee logs -f               # follow daemon logs"
  fi
else
echo "Next:"
echo "  bee login <hive-url>      # e.g. http://hive.your-tailnet.ts.net:4483"
echo "  bee start                 # auto-installs launchd/systemd unit + heartbeats"
echo "  bee start --foreground    # or run as a child process for dev"
fi

# Reboot survival on Linux requires user-level systemd to keep running after
# logout. `bee start` will also warn at runtime if linger is off; mentioning
# it here lets the operator front-load the fix instead of being surprised
# after their first reboot.
if [ "$(uname -s)" = "Linux" ]; then
  echo
  echo "Linux: for the daemon to survive reboot you need linger enabled once:"
  echo "  loginctl enable-linger $(id -un)"
fi
