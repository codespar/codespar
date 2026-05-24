/**
 * Strict-at-shape, lenient-on-membership validation for the optional
 * `mocks` field on POST /sessions.
 *
 * Three rules, applied AFTER the size cap:
 *   1. Top-level type — a non-null JSON object, not an array.
 *   2. Each key matches `^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9_-]*$`
 *      (canonical "server/tool" form).
 *   3. Each value is either a non-null JSON object (single-shot) or an
 *      array of non-null JSON objects (stateful sequence).
 *
 * Failures return `{ code: "mocks_invalid", field, message }` where
 * `field` is an RFC 6901 JSON Pointer rooted at the request body and
 * always starting `/mocks`. The `/` inside canonical keys is escaped
 * as `~1` per RFC 6901.
 *
 * The validator does not consult any catalog at create time
 * (lenient-on-membership). Unknown but canonical-shape tool names are
 * accepted at create and only surface their failure at tool dispatch
 * as `tool_not_mocked`.
 *
 * `message` MUST NOT echo the customer's submitted key or value bytes
 * verbatim — the templates here are generic, with the precise location
 * delivered via the RFC 6901 pointer instead.
 */

export interface MocksInvalidEnvelope {
  code: "mocks_invalid";
  field: string;
  message: string;
}

export interface MocksSizeError {
  code: "mocks_payload_too_large";
  message: string;
}

const CANONICAL_KEY_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9_-]*$/;

const MSG_TOP_LEVEL_TYPE =
  "mocks field must be a JSON object; see field for location";
const MSG_KEY_CANONICAL =
  "key fails canonical server/tool form regex; see field for location";
const MSG_VALUE_SHAPE =
  "mock value must be a non-null JSON object or an array of non-null JSON objects; see field for location";
const MSG_ARRAY_ENTRY =
  "stateful array entry must be a non-null JSON object; see field for location";

/** Stringified-byte cap on the `mocks` payload. 64 KiB matches the
 *  ceiling the managed runtime enforces — keeps a runaway client from
 *  shipping a multi-megabyte mock blob in a single POST. */
export const MOCKS_PAYLOAD_TOO_LARGE_BYTES = 64 * 1024;

/**
 * RFC 6901 encoding for a reference token: `~` -> `~0`, `/` -> `~1`.
 * Applied to canonical keys so `asaas/create_payment` lands at
 * `/mocks/asaas~1create_payment`.
 */
function rfc6901(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Validate the `mocks` field. Returns the first failure (short-circuit)
 * or `null` when the shape passes. The caller has already confirmed
 * `value !== undefined`.
 */
export function validateMocksShape(value: unknown): MocksInvalidEnvelope | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return { code: "mocks_invalid", field: "/mocks", message: MSG_TOP_LEVEL_TYPE };
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!CANONICAL_KEY_RE.test(key)) {
      return {
        code: "mocks_invalid",
        field: `/mocks/${rfc6901(key)}`,
        message: MSG_KEY_CANONICAL,
      };
    }
    if (Array.isArray(entry)) {
      for (let i = 0; i < entry.length; i++) {
        const item = entry[i];
        if (
          item === null ||
          typeof item !== "object" ||
          Array.isArray(item)
        ) {
          return {
            code: "mocks_invalid",
            field: `/mocks/${rfc6901(key)}/${i}`,
            message: MSG_ARRAY_ENTRY,
          };
        }
      }
      continue;
    }
    if (entry === null || typeof entry !== "object") {
      return {
        code: "mocks_invalid",
        field: `/mocks/${rfc6901(key)}`,
        message: MSG_VALUE_SHAPE,
      };
    }
  }
  return null;
}

/**
 * Apply the 64 KiB cap on `JSON.stringify(mocks).length`. Returns the
 * failure envelope on cap exceed; null on success.
 */
export function checkMocksSize(value: unknown): MocksSizeError | null {
  const serialized = JSON.stringify(value);
  if (serialized !== undefined && serialized.length > MOCKS_PAYLOAD_TOO_LARGE_BYTES) {
    return {
      code: "mocks_payload_too_large",
      message: `mocks payload exceeds ${MOCKS_PAYLOAD_TOO_LARGE_BYTES} bytes when JSON-encoded`,
    };
  }
  return null;
}
