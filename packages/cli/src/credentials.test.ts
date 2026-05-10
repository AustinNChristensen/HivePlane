import { describe, expect, it } from "vitest";
import { classifyCredential } from "./credentials.js";

describe("classifyCredential", () => {
  it("recognizes a long bootstrap token", () => {
    expect(classifyCredential("hp_boot_AbCdEf123456")).toEqual({
      kind: "bootstrap",
      value: "hp_boot_AbCdEf123456",
    });
    expect(classifyCredential("  HP_BOOT_xyz  ")).toEqual({
      kind: "bootstrap",
      value: "HP_BOOT_xyz",
    });
  });

  it("normalizes a dashed pairing key", () => {
    expect(classifyCredential("K7RQ-2P9X")).toEqual({
      kind: "pairing",
      value: "hp_pair_K7RQ2P9X",
    });
  });

  it("normalizes a lowercased pairing key", () => {
    expect(classifyCredential("k7rq2p9x")).toEqual({
      kind: "pairing",
      value: "hp_pair_K7RQ2P9X",
    });
  });

  it("accepts the prefixed form", () => {
    expect(classifyCredential("hp_pair_K7RQ2P9X")).toEqual({
      kind: "pairing",
      value: "hp_pair_K7RQ2P9X",
    });
  });

  it("rejects ambiguous chars (0/O/1/I/L/U) and bad lengths", () => {
    // O excluded
    expect(classifyCredential("K7RQ2POX")).toBeUndefined();
    // 0 not in alphabet
    expect(classifyCredential("K7RQ2P0X")).toBeUndefined();
    // too short
    expect(classifyCredential("K7RQ2P9")).toBeUndefined();
    // too long
    expect(classifyCredential("K7RQ2P9XX")).toBeUndefined();
    // garbage
    expect(classifyCredential("not-a-key")).toBeUndefined();
    expect(classifyCredential("")).toBeUndefined();
  });
});
