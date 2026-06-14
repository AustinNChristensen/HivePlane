# MVP Demo Script

This is the first end-to-end HivePlane demo. It is meant to prove the control-plane value proposition and expose the next engineering gaps.

## Demo Promise

In under 10 minutes, an operator can:

1. start a Hive;
2. pair a Bee from another machine;
3. verify runtime/model capability reporting;
4. run a safe healthcheck/job;
5. delegate one OpenClaw-backed task;
6. break and recover the Bee;
7. inspect the job, incident, recovery, and audit trail in the dashboard.

## Setup

- Two machines on the same Tailscale tailnet, or one machine plus a second test account/session.
- Node 20+ and git installed on both machines.
- OpenClaw installed on the Bee for the task delegation step.
- Ollama installed on the Bee for the model capability step. If Ollama is unavailable, use the mocked note below.

## Script

### 1. Install And Start Hive

On the control-plane machine:

```bash
curl -fsSL https://raw.githubusercontent.com/AustinNChristensen/HivePlane/main/infra/install/hive.sh | sh
hive status
```

Open the dashboard at the printed Hive URL. Save the admin token from `~/.hiveplane/hive-config.json`.

Real signal: `/healthz` returns `ok`, and the dashboard loads.

### 2. Pair A Bee

In the dashboard, paste the admin token, open **Bees**, and click **Copy Install** from **Pair a new Bee**.

Run the copied command on the Bee machine.

Real signal: the Bee appears online with Rescue online and a heartbeat counter that increments.

### 3. Verify Capabilities

Open the Bee detail modal.

Expected:

- runtime capability includes `openclaw` if OpenClaw is installed;
- model backend includes `ollama` if Ollama is installed;
- model list includes locally pulled models if any exist;
- tools include safe local capabilities such as `openclaw`.

Mock if needed: if Ollama is not installed, run the `ollama_status` job and show the normalized "not installed" result. The point is that missing model infrastructure is visible, not silent.

### 4. Run A Healthcheck

Click **Healthcheck** on the Bee.

Real signal:

- job moves through queued/assigned/succeeded;
- the job detail shows payload, output, and event stream;
- Activity shows the job lifecycle.

### 5. Delegate An Agent Task

Open **Tasks**.

Create a task with:

- preferred Bee: the online Bee;
- runtime: `openclaw`;
- title: `Demo task`;
- instructions: `Reply with exactly: HivePlane delegated task succeeded.`;

Real signal:

- task assigns to the Bee;
- backing `agent_task` job runs through OpenClaw;
- final text is visible in task detail;
- job events include OpenClaw stdout/stderr and compact result metadata.

### 6. Break And Recover

On the Bee machine, stop the Bee but leave Rescue running:

```bash
bee stop
```

In the dashboard, wait for the Bee profile grace window to trip, or temporarily set the Bee profile to `always_on` with a short grace window.

Real signal:

- incident is created;
- Rescue queues or runs `restart_bee`;
- verification healthcheck runs after repair;
- incident resolves.

### 7. Inspect The Recovery Trail

Open **Incidents** and expand the incident row.

Expected:

- diagnosis/summary is visible;
- repair action is visible;
- repair job output/error is visible when admin jobs are loaded;
- verification job/status is visible;
- the Bee detail modal **Recovery** tab shows the same incident in that Bee's history.

## What Must Be Real

- Hive install/start.
- Bee install/pair/start.
- signed Bee heartbeat.
- job creation, assignment, event append, and completion.
- dashboard job detail.
- at least one safe command or healthcheck.
- Rescue-based Bee restart.

## What Can Be Mocked For Now

- Ollama model inventory if the demo machine has no local models.
- Hermes adapter behavior.
- production auth/org separation.
- TLS/reverse-proxy setup.
- cloud-hosted HivePlane.

## Engineering Priority From The Demo

Any step that takes more than one copy-paste, lacks a clear error, or requires reading source code should become a GitHub issue before widening the alpha.
