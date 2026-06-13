#!/usr/bin/env node
const { spawn } = require("node:child_process");

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(raw));
  });
}

function parseArgs(argv) {
  const parsed = {
    target: process.env.HIVEPLANE_INCIDENT_IMESSAGE_TARGET,
    channel: process.env.HIVEPLANE_INCIDENT_MESSAGE_CHANNEL ?? "imessage",
    openclaw: process.env.OPENCLAW_BIN ?? "/opt/homebrew/bin/openclaw",
    dashboardUrl: process.env.HIVEPLANE_DASHBOARD_URL ?? "http://localhost:4483",
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--target") parsed.target = argv[++i];
    else if (arg === "--channel") parsed.channel = argv[++i];
    else if (arg === "--openclaw") parsed.openclaw = argv[++i];
    else if (arg === "--dashboard-url") parsed.dashboardUrl = argv[++i];
    else if (arg === "--dry-run") parsed.dryRun = true;
    else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!parsed.target) {
    throw new Error("Missing --target or HIVEPLANE_INCIDENT_IMESSAGE_TARGET.");
  }
  return parsed;
}

function asText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildMessage(payload, dashboardUrl) {
  const incident = payload?.incident ?? {};
  const notification = payload?.notification ?? {};
  const bee = payload?.bee ?? {};
  const beeName =
    asText(bee.beeName) ?? asText(bee.beeId) ?? asText(incident.beeId) ?? "Unknown Bee";
  const status = asText(notification.status) ?? asText(incident.status) ?? "incident";
  const severity = asText(incident.severity) ?? "warning";
  const summary =
    asText(incident.summary) ??
    asText(notification.message) ??
    "HivePlane incident needs attention.";
  const diagnosis = asText(incident.lastDiagnosis);
  const nextAction = asText(incident.nextAction);

  const lines = [
    `HivePlane alert: ${status.replaceAll("_", " ")} (${severity})`,
    `${beeName}: ${summary}`,
  ];
  if (diagnosis) lines.push(`Diagnosis: ${diagnosis}`);
  if (nextAction) lines.push(`Next: ${nextAction}`);
  if (dashboardUrl) lines.push(`Dashboard: ${dashboardUrl}`);
  return lines.join("\n");
}

function sendMessage({ openclaw, channel, target, message, dryRun }) {
  if (dryRun) {
    process.stdout.write(`${message}\n`);
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const child = spawn(
      openclaw,
      ["message", "send", "--channel", channel, "--target", target, "--message", message],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-2000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`openclaw exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

try {
  const options = parseArgs(process.argv.slice(2));
  readStdin()
    .then((raw) => {
      const payload = raw.trim() ? JSON.parse(raw) : {};
      const message = buildMessage(payload, options.dashboardUrl);
      return sendMessage({ ...options, message });
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
