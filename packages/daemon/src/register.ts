import { hostname } from "node:os";
import {
  BeeRegistrationRequestSchema,
  BeeRegistrationResponseSchema,
  type BeeRegistrationRequest,
  type BeeRegistrationResponse,
} from "@hiveplane/protocol";
import { getHardwareSnapshot } from "./index.js";
import type { BeeIdentity } from "./identity.js";

export type RegisterBeeOptions = {
  hiveUrl: string;
  bootstrapToken: string;
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

  const body: BeeRegistrationRequest = BeeRegistrationRequestSchema.parse({
    type: "bee.registration.request",
    bootstrapToken: options.bootstrapToken,
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
