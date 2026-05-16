import { describe, it, expect } from "vitest";
import {
  constantTimeEqual,
  isStrictMode,
  verifyEvolutionSignature,
} from "../signature.js";

describe("constantTimeEqual", () => {
  it("returns true for matching strings", () => {
    expect(constantTimeEqual("hunter2", "hunter2")).toBe(true);
  });
  it("returns false for mismatched strings", () => {
    expect(constantTimeEqual("hunter2", "HUNTER2")).toBe(false);
  });
  it("returns false on length mismatch without throwing", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
  it("returns false for empty inputs", () => {
    expect(constantTimeEqual("", "")).toBe(false);
    expect(constantTimeEqual("x", "")).toBe(false);
    expect(constantTimeEqual("", "x")).toBe(false);
  });
});

describe("isStrictMode", () => {
  it.each([
    ["true", true],
    ["TRUE", true],
    ["1", true],
    ["yes", true],
    ["false", false],
    ["0", false],
    ["", false],
    [undefined, false],
  ])("isStrictMode(%j) === %s", (input, expected) => {
    expect(isStrictMode(input as string | undefined)).toBe(expected);
  });
});

describe("verifyEvolutionSignature — F10.M3 four-row table", () => {
  it.each([
    {
      name: "valid signature",
      providedHeader: "shared-secret",
      secret: "shared-secret",
      strict: false,
      expectOk: true,
      reason: "secret_match",
    },
    {
      name: "invalid signature → 401",
      providedHeader: "wrong",
      secret: "shared-secret",
      strict: true,
      expectOk: false,
      reason: "header_mismatch",
    },
    {
      name: "missing signature with strict mode on → 401",
      providedHeader: undefined,
      secret: undefined,
      strict: true,
      expectOk: false,
      reason: "no_secret_strict",
    },
    {
      name: "missing signature with strict mode off → accept (relaxed)",
      providedHeader: undefined,
      secret: undefined,
      strict: false,
      expectOk: true,
      reason: "no_secret_relaxed",
    },
  ])(
    "$name",
    ({ providedHeader, secret, strict, expectOk, reason }) => {
      const verdict = verifyEvolutionSignature({ providedHeader, secret, strict });
      expect(verdict.ok).toBe(expectOk);
      expect(verdict.reason).toBe(reason);
    },
  );

  it("missing header with secret set fails closed even when strict mode is off", () => {
    const verdict = verifyEvolutionSignature({
      providedHeader: undefined,
      secret: "shared-secret",
      strict: false,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("missing_header");
  });
});
