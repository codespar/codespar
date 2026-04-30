/**
 * F2.M1.3 OSS reference MandateGenerator — unit tests.
 *
 * Mirrors the enterprise package's mandate.test.ts so a contract drift
 * between the two impls would surface here. Wire-compatibility (a
 * mandate created by either generator verifies under the other given
 * the same secret) is asserted in mandate-cross-impl-compat.test.ts
 * (out of scope for this hop).
 */

import { describe, it, expect } from "vitest";
import { MandateGenerator } from "../mandate-generator.js";

const TEST_SECRET = "test-secret-key-for-hmac-256";

function futureDate(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function pastDate(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

describe("MandateGenerator (OSS reference)", () => {
  it("rejects short secrets", () => {
    expect(() => new MandateGenerator("short")).toThrow("at least 16 characters");
  });

  it("creates a mandate with a valid HMAC signature", () => {
    const gen = new MandateGenerator(TEST_SECRET);
    const mandate = gen.create({
      id: "mnd-001",
      type: "payment",
      authorizedBy: "user-1",
      agentId: "agent-1",
      amount: 100,
      currency: "BRL",
      description: "Test payment",
      expiresAt: futureDate(60_000),
    });
    expect(mandate.id).toBe("mnd-001");
    expect(mandate.signature).toBeTruthy();
    expect(gen.verify(mandate)).toBe(true);
  });

  it("rejects amount <= 0", () => {
    const gen = new MandateGenerator(TEST_SECRET);
    expect(() =>
      gen.create({
        id: "mnd-bad",
        type: "payment",
        authorizedBy: "user-1",
        agentId: "agent-1",
        amount: 0,
        currency: "BRL",
        description: "Bad",
        expiresAt: futureDate(60_000),
      }),
    ).toThrow("must be positive");
  });

  it("rejects duplicate ids on create", () => {
    const gen = new MandateGenerator(TEST_SECRET);
    gen.create({
      id: "mnd-dup",
      type: "payment",
      authorizedBy: "u",
      agentId: "a",
      amount: 1,
      currency: "BRL",
      description: "x",
      expiresAt: futureDate(60_000),
    });
    expect(() =>
      gen.create({
        id: "mnd-dup",
        type: "payment",
        authorizedBy: "u",
        agentId: "a",
        amount: 1,
        currency: "BRL",
        description: "x",
        expiresAt: futureDate(60_000),
      }),
    ).toThrow("already exists");
  });

  it("verify returns false when the signature has been tampered", () => {
    const gen = new MandateGenerator(TEST_SECRET);
    const m = gen.create({
      id: "mnd-tamper",
      type: "payment",
      authorizedBy: "u",
      agentId: "a",
      amount: 100,
      currency: "BRL",
      description: "x",
      expiresAt: futureDate(60_000),
    });
    expect(gen.verify({ ...m, amount: 999 })).toBe(false);
  });

  it("use marks a mandate as used and prevents reuse", () => {
    const gen = new MandateGenerator(TEST_SECRET);
    gen.create({
      id: "mnd-use",
      type: "payment",
      authorizedBy: "u",
      agentId: "a",
      amount: 100,
      currency: "BRL",
      description: "x",
      expiresAt: futureDate(60_000),
    });
    const used = gen.use("mnd-use");
    expect(used.usedAt).toBeTruthy();
    expect(() => gen.use("mnd-use")).toThrow("already been used");
  });

  it("revoke prevents subsequent use", () => {
    const gen = new MandateGenerator(TEST_SECRET);
    gen.create({
      id: "mnd-rev",
      type: "payment",
      authorizedBy: "u",
      agentId: "a",
      amount: 100,
      currency: "BRL",
      description: "x",
      expiresAt: futureDate(60_000),
    });
    gen.revoke("mnd-rev");
    expect(() => gen.use("mnd-rev")).toThrow("has been revoked");
  });

  it("isValid returns false for expired mandates", () => {
    const gen = new MandateGenerator(TEST_SECRET);
    gen.create({
      id: "mnd-exp",
      type: "payment",
      authorizedBy: "u",
      agentId: "a",
      amount: 100,
      currency: "BRL",
      description: "x",
      expiresAt: pastDate(60_000),
    });
    expect(gen.isValid("mnd-exp")).toBe(false);
  });

  it("isValid enforces maxAmount on delegation type", () => {
    const gen = new MandateGenerator(TEST_SECRET);
    gen.create({
      id: "mnd-deleg",
      type: "delegation",
      authorizedBy: "u",
      agentId: "a",
      amount: 100,
      currency: "BRL",
      maxAmount: 50,
      description: "x",
      expiresAt: futureDate(60_000),
    });
    expect(gen.isValid("mnd-deleg", 30)).toBe(true);
    expect(gen.isValid("mnd-deleg", 70)).toBe(false);
  });

  it("getActive excludes used + revoked + expired", () => {
    const gen = new MandateGenerator(TEST_SECRET);
    gen.create({
      id: "active-1",
      type: "payment",
      authorizedBy: "u",
      agentId: "a",
      amount: 1,
      currency: "BRL",
      description: "active",
      expiresAt: futureDate(60_000),
    });
    gen.create({
      id: "used-1",
      type: "payment",
      authorizedBy: "u",
      agentId: "a",
      amount: 1,
      currency: "BRL",
      description: "used",
      expiresAt: futureDate(60_000),
    });
    gen.use("used-1");
    gen.create({
      id: "rev-1",
      type: "payment",
      authorizedBy: "u",
      agentId: "a",
      amount: 1,
      currency: "BRL",
      description: "rev",
      expiresAt: futureDate(60_000),
    });
    gen.revoke("rev-1");
    const active = gen.getActive();
    expect(active.map((m) => m.id)).toEqual(["active-1"]);
  });
});
