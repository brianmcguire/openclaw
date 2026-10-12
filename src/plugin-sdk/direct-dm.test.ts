import { describe, expect, it } from "vitest";
import { createDirectDmPreCryptoGuardPolicy } from "./channel-inbound.js";

describe("channel-inbound direct-message helpers", () => {
  it("defaults non-finite shared pre-crypto guard numeric overrides", () => {
    const policy = createDirectDmPreCryptoGuardPolicy({
      maxFutureSkewSec: Number.NaN,
      maxCiphertextBytes: Number.POSITIVE_INFINITY,
      maxPlaintextBytes: Number.NEGATIVE_INFINITY,
      rateLimit: {
        windowMs: Number.NaN,
        maxPerSenderPerWindow: Number.POSITIVE_INFINITY,
        maxGlobalPerWindow: Number.NEGATIVE_INFINITY,
        maxTrackedSenderKeys: Number.NaN,
      },
    });

    expect(policy.maxFutureSkewSec).toBe(120);
    expect(policy.maxCiphertextBytes).toBe(16 * 1024);
    expect(policy.maxPlaintextBytes).toBe(8 * 1024);
    expect(policy.rateLimit).toEqual({
      windowMs: 60_000,
      maxPerSenderPerWindow: 20,
      maxGlobalPerWindow: 200,
      maxTrackedSenderKeys: 4096,
    });
  });
});
