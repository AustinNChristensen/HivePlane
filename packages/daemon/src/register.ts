import { hostname } from "node:os";
import {
  BeeRegistrationRequestSchema,
  BeeRegistrationResponseSchema,
  type BeeRegistrationRequest,
  type BeeRegistrationResponse,
} from "@hiveplane/protocol";
import { getHardwareSnapshot } from "./index.js";
import type { BeeIdentity } from "./identity.js";

/**
 * Caller supplies exactly one of the two credentials. The Hive accepts both
 * paths interchangeably — `bootstrapToken` is the long admin-minted token used
 * by automation; `pairingKey` is the short human-typeable code surfaced in the
 * Hive dashboard.
 */
export type RegisterBeeOptions = {
  hiveUrl: string;
  bootstrapToken?: string;
  pairingKey?: string;
  identity: BeeIdentity;
  beeName?: string;
  daemonVersion: string;
  fetchImpl?: typeof fetch;
};

export async function registerBeeWithHive(
  options: RegisterBeeOptions,
): Promise<BeeRegistrationResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const hardware = getHardwareSnapshot();
  if (hardware.platform === "unsupported") {
    throw new Error(`registration: unsupported platform (${process.platform}/${process.arch})`);
  }

  if (!options.bootstrapToken && !options.pairingKey) {
    throw new Error("registration: either bootstrapToken or pairingKey is required");
  }
  if (options.bootstrapToken && options.pairingKey) {
    throw new Error("registration: supply only one of bootstrapToken / pairingKey");
  }

  const body: BeeRegistrationRequest = BeeRegistrationRequestSchema.parse({
    type: "bee.registration.request",
    ...(options.bootstrapToken ? { bootstrapToken: options.bootstrapToken } : {}),
    ...(options.pairingKey ? { pairingKey: options.pairingKey } : {}),
    publicKey: options.identity.publicKeyPem,
    beeName: options.beeName ?? hostname(),
    daemonVersion: options.daemonVersion,
    hiveUrl: options.hiveUrl,
    labels: {},
    capabilities: {
      runtimes: [],
      modelBackends: [],
      models: [],
      localModels: [],
      agentSessions: [],
      connectors: [],
      tools: [],
      networking: [],
      hardware: {
        platform: hardware.platform,
        hostname: hardware.hostname,
        cpuCores: hardware.cpuCores,
        memoryGb: hardware.memoryGb,
      },
    },
    requestedAt: new Date().toISOString(),
  });

  const url = new URL("/api/bees/register", options.hiveUrl);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    // Node's fetch normalises every network failure into a generic
    // `TypeError: fetch failed`. The real cause is stashed on `error.cause`
    // as a Node ENOENT / ECONNREFUSED / ETIMEDOUT etc. — surface a useful
    // hint based on it so an operator hitting this knows what to do next
    // instead of staring at "fetch failed".
    throw new Error(describeNetworkError(error, url));
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Bee registration failed (${response.status}): ${text}`);
  }

  return BeeRegistrationResponseSchema.parse(await response.json());
}

/**
 * Translate a thrown fetch error into a one-liner that names the network
 * failure mode and points the operator at a concrete next step. We inspect
 * `error.cause.code` (Node's standard errno tag) before falling back to
 * the raw message.
 */
function describeNetworkError(error: unknown, url: URL): string {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code;
  const target = `${url.host}`;

  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return (
        `could not resolve ${url.hostname}.\n` +
        `Hint: check the Hive URL. Try \`ping ${url.hostname}\` from this machine.`
      );
    case "ECONNREFUSED":
      return (
        `connection refused at ${target}.\n` +
        `Hint: is the Hive running? Try \`curl ${url.protocol}//${target}/healthz\` ` +
        `from this machine. If the curl works but registration doesn't, check the ` +
        `Hive's firewall.`
      );
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
      return (
        `timed out connecting to ${target}.\n` +
        `Hint: routing or firewall is dropping packets. Try \`ping ${url.hostname}\` — ` +
        `if that also fails the host is unreachable; if it works the firewall on the ` +
        `Hive is likely blocking port ${url.port}.`
      );
    case "ECONNRESET":
      return (
        `connection reset by ${target}.\n` +
        `Hint: the Hive accepted the TCP handshake then closed; usually a TLS-vs-plain-` +
        `HTTP mismatch (HivePlane v0.0.x is plain HTTP — make sure the URL is http://).`
      );
    case "CERT_HAS_EXPIRED":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
      return (
        `TLS certificate problem reaching ${target} (${code}).\n` +
        `Hint: HivePlane self-host is plain HTTP — drop the https:// from the Hive URL.`
      );
    default: {
      const detail = cause?.message ?? (error instanceof Error ? error.message : String(error));
      return (
        `could not reach Hive at ${target}: ${detail}.\n` +
        `Hint: try \`curl ${url.protocol}//${target}/healthz\` from this machine to ` +
        `narrow down where the failure is.`
      );
    }
  }
}
