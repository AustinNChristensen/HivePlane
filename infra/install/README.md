# HivePlane install scripts

Two POSIX-`sh` scripts for setting up a HivePlane machine without remembering
flags or paths.

## Bee (worker node)

Three commands total: install, login, start.

```sh
# 1. install (no args needed)
curl -fsSL https://hive.your-tailnet.ts.net:8787/install/bee.sh | sh

# 2. point at a Hive
hive login http://hive.your-tailnet.ts.net:8787

# 3. start (auto-installs the service unit on first run; survives reboot)
hive start
```

What `bee.sh` does:

- checks for Node 20+, git, and pnpm (installs pnpm via corepack if missing);
- clones (or updates) this repo to `~/.hiveplane/install`;
- runs `pnpm install`;
- writes `hive` and `hiveplane-bee` shims into `~/.local/bin`;
- generates a persistent Ed25519 Bee identity under `~/.hiveplane`.

It does **not** start anything or contact a Hive — that happens via
`hive login <url>` followed by `hive start`.

The script is idempotent. Re-running it pulls the latest `main` and reinstalls
deps, but keeps your identity and config.

### Auto-start

`hive start` is smart: if no service unit exists yet, it installs one and starts it. If one is already there, it loads / kicks the existing unit. Either way, the daemon survives reboots and crashes:

- **macOS**: `~/Library/LaunchAgents/com.hiveplane.bee.plist` (launchd, user-level — no sudo)
- **Linux**: `~/.config/systemd/user/hiveplane-bee.service` (systemd user unit)

Logs land in `~/.hiveplane/logs/`.

`hive stop` stops the running service. `hive disable` removes the unit. `hive status` reports whether the service is loaded and running. `hive logs -f` tails the daemon output. `hive start --foreground` runs the daemon as a child process for dev.

On Linux, run `loginctl enable-linger $USER` if you want the daemon to keep running after you log out.

## Hive (control plane)

```sh
# defaults: host 0.0.0.0, port 8787
curl -fsSL https://raw.githubusercontent.com/AustinNChristensen/HivePlane/main/infra/install/hive.sh | sh

# or with custom host/port
curl -fsSL .../hive.sh | sh -s -- --host 0.0.0.0 --port 9090

# install only, don't start
curl -fsSL .../hive.sh | sh -s -- --no-start
```

What `hive.sh` does:

- same prereq + clone + install steps as `bee.sh`;
- by default starts the Hive in the foreground on `0.0.0.0:8787` so Bees on
  the Tailnet/LAN can reach it (Ctrl-C stops it);
- `--no-start` skips startup and prints the manual command.

Once the Hive is running, it serves these scripts itself at
`GET /install/bee.sh` and `GET /install/hive.sh`, so other machines can do:

```sh
curl -fsSL http://hive.your-tailnet.ts.net:8787/install/bee.sh | sh
```

## Environment overrides

Both scripts respect:

- `HIVEPLANE_INSTALL_DIR` (default `~/.hiveplane/install`)
- `HIVEPLANE_REPO_URL` and `HIVEPLANE_REPO_REF` for installing from a fork or
  a non-`main` branch.
- `HIVEPLANE_BIN_DIR` (Bee only, default `~/.local/bin`).

## Roadmap

- generate launchd plist (macOS) and systemd user unit (linux) so the daemon
  survives reboots;
- pin to released tags instead of `main` once we cut releases;
- ship as a single signed binary so `node`/`pnpm`/`git` aren't required on
  the target machine.
