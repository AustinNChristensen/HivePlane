# @hiveplane/daemon

Worker node daemon package.

This package will own local node lifecycle concerns:

- node identity;
- control-plane connection;
- heartbeat reporting;
- job execution;
- recipe execution;
- runtime/model adapters;
- local policy enforcement.

Current implementation is a small skeleton for config parsing, hardware detection, daemon state, and heartbeat creation.
