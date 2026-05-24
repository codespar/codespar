/**
 * Unit tests for the mocks-validation module.
 *
 * Covers the three gates in order — size cap, top-level shape, key
 * canonical form, value shape — and asserts the RFC 6901 field
 * pointer the dispatcher returns on each failure.
 */

import { describe, it, expect } from "vitest";
import {
  checkMocksSize,
  validateMocksShape,
  MOCKS_PAYLOAD_TOO_LARGE_BYTES,
} from "../mocks-validation.js";

describe("validateMocksShape", () => {
  it("accepts a valid single-shot object value", () => {
    const result = validateMocksShape({
      "asaas/create_payment": { id: "pay_test", status: "PENDING" },
    });
    expect(result).toBeNull();
  });

  it("accepts a valid stateful array of objects", () => {
    const result = validateMocksShape({
      "asaas/get_payment": [
        { id: "pay_test", status: "PENDING" },
        { id: "pay_test", status: "CONFIRMED" },
      ],
    });
    expect(result).toBeNull();
  });

  it("accepts an empty object (lenient at create-time)", () => {
    expect(validateMocksShape({})).toBeNull();
  });

  it("rejects null at the top level", () => {
    expect(validateMocksShape(null)).toEqual({
      code: "mocks_invalid",
      field: "/mocks",
      message: expect.stringContaining("JSON object"),
    });
  });

  it("rejects an array at the top level", () => {
    expect(validateMocksShape([])).toEqual({
      code: "mocks_invalid",
      field: "/mocks",
      message: expect.stringContaining("JSON object"),
    });
  });

  it("rejects keys that fail canonical-form regex", () => {
    const result = validateMocksShape({ "BAD/Tool": {} });
    expect(result?.code).toBe("mocks_invalid");
    expect(result?.field).toBe("/mocks/BAD~1Tool");
  });

  it("rejects keys without the `/` separator", () => {
    const result = validateMocksShape({ noseparator: {} });
    expect(result?.code).toBe("mocks_invalid");
    expect(result?.field).toBe("/mocks/noseparator");
  });

  it("rejects null values", () => {
    const result = validateMocksShape({ "asaas/foo": null });
    expect(result?.code).toBe("mocks_invalid");
    expect(result?.field).toBe("/mocks/asaas~1foo");
  });

  it("rejects primitive values (strings/numbers/booleans)", () => {
    for (const v of [1, "x", true]) {
      const result = validateMocksShape({ "asaas/foo": v });
      expect(result?.code).toBe("mocks_invalid");
    }
  });

  it("rejects null array entries", () => {
    const result = validateMocksShape({
      "asaas/foo": [{ ok: true }, null],
    });
    expect(result?.code).toBe("mocks_invalid");
    expect(result?.field).toBe("/mocks/asaas~1foo/1");
  });

  it("rejects nested array values inside arrays", () => {
    const result = validateMocksShape({
      "asaas/foo": [[]],
    });
    expect(result?.code).toBe("mocks_invalid");
    expect(result?.field).toBe("/mocks/asaas~1foo/0");
  });
});

describe("checkMocksSize", () => {
  it("accepts payloads under the cap", () => {
    expect(checkMocksSize({ "asaas/foo": { id: "x" } })).toBeNull();
  });

  it("rejects payloads over 64 KiB once serialized", () => {
    const big = { "asaas/foo": { blob: "x".repeat(MOCKS_PAYLOAD_TOO_LARGE_BYTES) } };
    const result = checkMocksSize(big);
    expect(result?.code).toBe("mocks_payload_too_large");
    expect(result?.message).toContain(String(MOCKS_PAYLOAD_TOO_LARGE_BYTES));
  });
});
