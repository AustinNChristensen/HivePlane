# HivePlane install scripts

Two POSIX-`sh` scripts for setting up a HivePlane machine without remembering
flags or paths.

## Bee (worker node)

Two-step flow: install once, then connect with `hive login`.

```sh
# 1. install (no args needed)
curl -fsSL https://hive.your-tailnet.ts.net:8787/install/bee.sh | sh

# 2. connect to a Hive
hive login http://hive.your-tailnet.ts.net:8787
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
