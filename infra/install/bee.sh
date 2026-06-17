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
# Guided mode prompts for the Hive URL, pairing key/bootstrap token, Bee name,
# and start method when run from a TTY.
#
# One-command mode installs, pairs, and starts when these flags or env vars are
# supplied:
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
START_METHOD="${HIVEPLANE_INSTALL_METHOD:-${HIVEPLANE_BEE_START_METHOD:-auto}}"

color_info='\033[1;36m'
color_warn='\033[1;33m'
color_err='\033[1;31m'
color_off='\033[0m'

log()  { printf '%b[bee install]%b %s\n' "$color_info" "$color_off" "$1"; }
warn() { printf '%b[bee install]%b %s\n' "$color_warn" "$color_off" "$1"; }
err()  { printf '%b[bee install error]%b %s\n' "$color_err" "$color_off" "$1" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Install a HivePlane Bee.

Guided install:
  infra/install/bee.sh

Non-interactive install + pair + start:
  infra/install/bee.sh \
    --hive-url http://hive.example:4483 \
    --pairing-key K7RQ-2P9X \
    --name laptop-bee \
    --method auto

Options:
  --hive-url <url>        Hive URL this Bee should connect to
  --pairing-key <key>     Dashboard pairing key, e.g. K7RQ-2P9X
  --token <token>         Bootstrap token, e.g. hp_boot_...
  --bootstrap-token <t>   Alias for --token
  --name <name>           Bee display name in Hive
  --method <method>       auto, service, foreground, manual
  --install-dir <path>    Install directory (default: ~/.hiveplane/install)
  --bin-dir <path>        CLI shim directory (default: ~/.local/bin)
  --repo-url <url>        Git repository URL
  --repo-ref <ref>        Git branch/tag/ref to install
  --no-start              Pair but do not start the Bee
  --foreground            Start in the foreground after pairing
  --help                  Show this help

Environment equivalents:
  HIVEPLANE_HIVE_URL
  HIVEPLANE_PAIRING_KEY
  HIVEPLANE_BOOTSTRAP_TOKEN
  HIVEPLANE_BEE_NAME
  HIVEPLANE_INSTALL_METHOD=auto|service|foreground|manual
  HIVEPLANE_INSTALL_DIR
  HIVEPLANE_BIN_DIR
  HIVEPLANE_REPO_URL
  HIVEPLANE_REPO_REF
  HIVEPLANE_NO_START=1

Methods:
  auto        Start as a service when launchd/systemd-user is supported.
  service     Same as auto; durable launchd/systemd-user where supported.
  foreground  Pair, then run the Bee as a foreground child process.
  manual      Install and pair only; print the next command to run.
USAGE
}

is_tty() {
  [ -r /dev/tty ] && [ -w /dev/tty ]
}

prompt() {
  prompt_text="$1"
  current="$2"
  default_value="${3:-}"

  if [ -n "$current" ]; then
    printf '%s\n' "$current"
    return
  fi
  if ! is_tty; then
    printf '%s\n' "$default_value"
    return
  fi
  if [ -n "$default_value" ]; then
    printf '%s [%s]: ' "$prompt_text" "$default_value" > /dev/tty
  else
    printf '%s: ' "$prompt_text" > /dev/tty
  fi
  IFS= read -r value < /dev/tty || value=""
  if [ -n "$value" ]; then
    printf '%s\n' "$value"
  else
    printf '%s\n' "$default_value"
  fi
}

prompt_method() {
  current="$1"
  if [ -n "$current" ] && [ "$current" != "auto" ]; then
    printf '%s\n' "$current"
    return
  fi
  if ! is_tty; then
    printf '%s\n' "$current"
    return
  fi
  cat > /dev/tty <<'EOF'
Start method:
  1) auto/service
  2) foreground
  3) manual/no start
EOF
  printf 'Choose start method [1]: ' > /dev/tty
  IFS= read -r choice < /dev/tty || choice=""
  case "${choice:-1}" in
    1|auto|service) printf 'auto\n' ;;
    2|foreground) printf 'foreground\n' ;;
    3|manual|no-start) printf 'manual\n' ;;
    *) err "Invalid start method: $choice" ;;
  esac
}

default_bee_name() {
  hostname -s 2>/dev/null || hostname 2>/dev/null || printf 'bee'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --hive-url)
      HIVEPLANE_HIVE_URL="${2:-}"; shift 2 ;;
    --pairing-key)
      HIVEPLANE_PAIRING_KEY="${2:-}"; shift 2 ;;
    --token|--bootstrap-token)
      HIVEPLANE_BOOTSTRAP_TOKEN="${2:-}"; shift 2 ;;
    --name)
      HIVEPLANE_BEE_NAME="${2:-}"; shift 2 ;;
    --method)
      START_METHOD="${2:-}"; shift 2 ;;
    --install-dir)
      INSTALL_DIR="${2:-}"; shift 2 ;;
    --bin-dir)
      BIN_DIR="${2:-}"; shift 2 ;;
    --repo-url)
      REPO_URL="${2:-}"; shift 2 ;;
    --repo-ref)
      REPO_REF="${2:-}"; shift 2 ;;
    --no-start)
      HIVEPLANE_NO_START=1; START_METHOD=manual; shift ;;
    --foreground)
      START_METHOD=foreground; shift ;;
    --help|-h)
      usage; exit 0 ;;
    *)
      err "Unknown argument: $1" ;;
  esac
done

case "$START_METHOD" in
  auto|service|foreground|manual) ;;
  *) err "Invalid --method: $START_METHOD" ;;
esac

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

if is_tty && [ -z "${HIVEPLANE_HIVE_URL:-}" ]; then
  HIVEPLANE_HIVE_URL="$(prompt "Hive URL (blank to configure later)" "" "")"
fi

if [ -n "${HIVEPLANE_HIVE_URL:-}" ] || [ -n "${HIVEPLANE_PAIRING_KEY:-}" ] || [ -n "${HIVEPLANE_BOOTSTRAP_TOKEN:-}" ]; then
  [ -n "${HIVEPLANE_HIVE_URL:-}" ] || err "HIVEPLANE_HIVE_URL is required for one-command pairing."
  if [ -n "${HIVEPLANE_PAIRING_KEY:-}" ] && [ -n "${HIVEPLANE_BOOTSTRAP_TOKEN:-}" ]; then
    err "Set only one of HIVEPLANE_PAIRING_KEY or HIVEPLANE_BOOTSTRAP_TOKEN."
  fi
  if is_tty && [ -z "${HIVEPLANE_PAIRING_KEY:-}" ] && [ -z "${HIVEPLANE_BOOTSTRAP_TOKEN:-}" ]; then
    credential="$(prompt "Pairing key or bootstrap token" "" "")"
    case "$credential" in
      hp_boot_*) HIVEPLANE_BOOTSTRAP_TOKEN="$credential" ;;
      "") ;;
      *) HIVEPLANE_PAIRING_KEY="$credential" ;;
    esac
  fi
  if [ -z "${HIVEPLANE_PAIRING_KEY:-}" ] && [ -z "${HIVEPLANE_BOOTSTRAP_TOKEN:-}" ]; then
    err "HIVEPLANE_PAIRING_KEY or HIVEPLANE_BOOTSTRAP_TOKEN is required for one-command pairing."
  fi

  if is_tty && [ -z "${HIVEPLANE_BEE_NAME:-}" ]; then
    HIVEPLANE_BEE_NAME="$(prompt "Bee name in Hive" "" "$(default_bee_name)")"
  fi
  START_METHOD="$(prompt_method "$START_METHOD")"

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
  if [ "$START_METHOD" = "manual" ]; then
    set -- "$@" --no-start
  elif [ "$START_METHOD" = "foreground" ]; then
    set -- "$@" --foreground
  fi
  "$BIN_DIR/bee" login "$@"
  echo
  log "Bee paired."
  if [ "$START_METHOD" = "manual" ] || [ "${HIVEPLANE_NO_START:-}" = "1" ] || [ "${HIVEPLANE_NO_START:-}" = "true" ]; then
    echo "Next:"
    echo "  bee start                 # auto-installs launchd/systemd unit + heartbeats"
  elif [ "$START_METHOD" = "foreground" ]; then
    echo "Next:"
    echo "  bee status                # confirm session state"
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
