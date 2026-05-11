# HivePlane install scripts

Two POSIX-`sh` scripts for setting up a HivePlane machine without remembering
flags or paths.

## Bee (worker node)

Three commands total: install, login, start.

```sh
# 1. install (no args needed)
curl -fsSL https://hive.your-tailnet.ts.net:4483/install/bee.sh | sh

# 2. log in (no args runs an interactive prompt: Hive URL + pairing key)
bee login

# 3. start (auto-installs the service unit on first run; survives reboot)
bee start
```

The pairing key is the 8-character code shown on the Hive dashboard (admin
section of the **Bees** tab). It's single-use and rotates after each pair.
For unattended/scripted installs, pass everything inline:

```sh
bee login http://hive.your-tailnet.ts.net:4483 \
  --name laptop-1 \
  --pairing-key K7RQ-2P9X            # from the dashboard
# or, for fully-automated installs:
bee login <url> --token hp_boot_…    # long bootstrap token
```

What `bee.sh` does:

- checks for Node 20+, git, and pnpm (installs pnpm via corepack if missing);
- clones (or updates) this repo to `~/.hiveplane/install`;
- runs `pnpm install`;
- writes `bee` and `hiveplane-bee` shims into `~/.local/bin`;
- generates a persistent Ed25519 Bee identity under `~/.hiveplane`.

It does **not** start anything or contact a Hive — that happens via
`bee login <url>` followed by `bee start`.

The script is idempotent. Re-running it pulls the latest `main` and reinstalls
deps, but keeps your identity and config.

### Auto-start

`bee start` is smart: if no service unit exists yet, it installs one and starts it. If one is already there, it loads / kicks the existing unit. Either way, the daemon survives reboots and crashes:

- **macOS**: `~/Library/LaunchAgents/com.hiveplane.bee.plist` (launchd, user-level — no sudo)
- **Linux**: `~/.config/systemd/user/hiveplane-bee.service` (systemd user unit)

Logs land in `~/.hiveplane/logs/`.

`bee stop` stops the running service. `bee disable` removes the unit. `bee status` reports whether the service is loaded and running. `bee logs -f` tails the daemon output. `bee start --foreground` runs the daemon as a child process for dev.

On Linux, run `loginctl enable-linger $USER` if you want the daemon to keep running after you log out.

## Hive (control plane)

```sh
# defaults: host 0.0.0.0, port 4483, install as a service
curl -fsSL https://raw.githubusercontent.com/AustinNChristensen/HivePlane/main/infra/install/hive.sh | sh

# custom host/port
curl -fsSL .../hive.sh | sh -s -- --host 0.0.0.0 --port 9090

# foreground (dev mode — no service unit, no reboot survival)
curl -fsSL .../hive.sh | sh -s -- --foreground

# install only, don't start
curl -fsSL .../hive.sh | sh -s -- --no-start
```

What `hive.sh` does:

- same prereq + clone + install steps as `bee.sh`;
- drops the `hive` shim into `~/.local/bin` (so `hive <verb>` is on PATH);
- pre-flights the chosen port — refuses to install if anything else is
  listening there, with `lsof`/`ss` output naming the squatter;
- writes `~/.hiveplane/hive-config.json` (mode 0600) with a freshly-generated
  `adminToken` and the chosen bind host/port;
- installs a launchd plist (`~/Library/LaunchAgents/com.hiveplane.hive.plist`)
  on macOS or a systemd user unit
  (`~/.config/systemd/user/hiveplane-hive.service`) on Linux;
- starts the service. The Hive will come back automatically after reboots and
  crashes.

Manage the service afterwards with the `hive` CLI:

```sh
hive status               # installed/running, /version health probe, log paths
hive logs -f              # tail the Hive's stdout (or `stderr` for stderr)
hive stop
hive restart
hive uninstall            # remove the launchd/systemd unit
hive init --rotate-admin-token   # mint a fresh admin token
```

Once the Hive is running it serves these scripts itself at `GET /install/bee.sh`
and `GET /install/hive.sh`, so other machines can do:

```sh
curl -fsSL http://hive.your-tailnet.ts.net:4483/install/bee.sh | sh
```

### `hive-config.json`

`hive-config.json` (default `~/.hiveplane/hive-config.json`, mode 0600) is the
on-disk source of truth for `adminToken`, `host`, `port`, `authRequired`, and
`openBrowser`. The Hive runtime reads it at boot. Env vars still override:

- `HIVEPLANE_ADMIN_TOKEN`
- `HIVEPLANE_AUTH_REQUIRED` (`true` / `1`)
- `HIVEPLANE_HIVE_HOST`, `HIVEPLANE_HIVE_PORT`
- `HIVEPLANE_OPEN_BROWSER`

So an operator running the Hive interactively can `HIVEPLANE_AUTH_REQUIRED=true
pnpm --filter @hiveplane/web start` and have it win over whatever's in the
file, without editing JSON.

## Environment overrides

Both scripts respect:

- `HIVEPLANE_INSTALL_DIR` (default `~/.hiveplane/install`)
- `HIVEPLANE_CONFIG_DIR` (default `~/.hiveplane`)
- `HIVEPLANE_BIN_DIR` (default `~/.local/bin`)
- `HIVEPLANE_REPO_URL` and `HIVEPLANE_REPO_REF` for installing from a fork or
  a non-`main` branch.

## Roadmap

- pin to released tags instead of `main` once we cut releases;
- ship as a single signed binary so `node`/`pnpm`/`git` aren't required on
  the target machine.
