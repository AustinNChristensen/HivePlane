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
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Bee registration failed (${response.status}): ${text}`);
  }

  return BeeRegistrationResponseSchema.parse(await response.json());
}
