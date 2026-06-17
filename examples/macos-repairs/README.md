# macOS repair scripts

These scripts are examples for a Mac Bee that runs OpenClaw, imsg/Messages.app, HivePlane, and Ollama. Install only the scripts needed on a given machine:

```bash
mkdir -p ~/.hiveplane/repairs
cp examples/macos-repairs/*.sh ~/.hiveplane/repairs/
for script in ~/.hiveplane/repairs/*.sh; do
  ln -sf "$(basename "$script")" "${script%.sh}"
done
chmod 755 ~/.hiveplane/repairs/*
```

Allowlist the installed absolute paths in the Bee's local policy as needed. Do not allowlist `/bin/sh` on a production bot Mac just to run these.

The scripts prefer bounded diagnostics and explicit exit codes:

- `0`: healthy or repaired.
- `1`: repair attempted but still failing.
- `2`: needs remote GUI, account owner, or install-time permission.
