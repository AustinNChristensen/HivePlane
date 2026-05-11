import { describe, expect, it, beforeEach } from "vitest";
import { _resetHiveInfoCache, getHiveInfo } from "./hive-info.js";

beforeEach(() => {
  _resetHiveInfoCache();
});

describe("getHiveInfo", () => {
  it("falls back to the OS hostname when bind is 0.0.0.0 and Tailscale is absent", async () => {
    const info = await getHiveInfo("0.0.0.0", 4483);
    // We can't assert tailscaleDetected either way because the test machine
    // may have Tailscale installed. But we CAN assert the URL is well-formed
    // and the bindHost/bindPort echo back correctly.
    expect(info.bindHost).toBe("0.0.0.0");
    expect(info.bindPort).toBe(4483);
    expect(info.recommendedUrl).toMatch(/^http:\/\/.+:4483$/);
    expect(info.recommendedUrl).not.toMatch(/^http:\/\/0\.0\.0\.0:/);
    expect(info.recommendedUrl).not.toMatch(/^http:\/\/127\.0\.0\.1:/);
  });

  it("echoes a non-wildcard bind host directly when Tailscale isn't found", async () => {
    // We can't guarantee tailscale is absent — but we can assert that if it
    // IS detected the URL still ends with :4483 and isn't a wildcard, and if
    // it ISN'T detected the URL substitutes the OS hostname rather than the
    // explicit IP. (Skipping the explicit-IP assertion here keeps the test
    // robust to Tailscale being present on the dev box.)
    const info = await getHiveInfo("192.168.1.50", 4483);
    expect(info.recommendedUrl).toMatch(/^http:\/\/.+:4483$/);
    if (!info.tailscaleDetected) {
      // Tailscale absent → falls back to the explicit bind host.
      expect(info.recommendedUrl).toBe("http://192.168.1.50:4483");
    }
  });

  it("caches the result across calls", async () => {
    const first = await getHiveInfo("0.0.0.0", 4483);
    const second = await getHiveInfo("0.0.0.0", 4483);
    expect(second).toBe(first); // same object reference — cache hit
  });
});
