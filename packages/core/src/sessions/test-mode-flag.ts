/**
 * Runtime gate for the session-mocks feature.
 *
 * OSS deployments opt in to test-mode by setting
 * `CODESPAR_TEST_MODE_ENABLED=true` (or `=1`, case-insensitive). When
 * the flag is off — the default — two surfaces refuse the feature:
 *
 *   1. `POST /sessions` rejects bodies that carry `mocks` with HTTP
 *      501 and a `mocks_not_permitted` envelope. The env-flag check
 *      runs first in the route's validation chain (before size and
 *      shape), so the rejection reason is always the gate, never a
 *      derivative validation error.
 *   2. The dispatch seam (`tryMockedDispatch`) returns `null`
 *      (passthrough) regardless of what mocks may sit on the session,
 *      so the bridge handles every call as if mocks were absent.
 *      Defense in depth for the "operator flipped the flag off after
 *      sessions were already running with mocks" scenario.
 *
 * Read on every call (matching the per-request env-read pattern used
 * by `checkBearerAuth` in `server/routes/sessions.ts`). The overhead
 * of one env read per session create or per tool dispatch is trivial,
 * and per-call reads let tests flip the flag without re-importing
 * modules.
 */

const TEST_MODE_ENV_KEY = "CODESPAR_TEST_MODE_ENABLED";

/**
 * Returns true when the operator has opted the deployment in to
 * test-mode. Truthy values are `"true"` and `"1"` (case-insensitive,
 * with surrounding whitespace trimmed). Every other value — including
 * unset — returns false.
 */
export function isTestModeEnabled(): boolean {
  const raw = process.env[TEST_MODE_ENV_KEY];
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
}

/** Wire envelope returned by the session-create route when the flag
 *  is off and the request body carries `mocks`. The status code is
 *  HTTP 501 (Not Implemented) — semantically accurate for "this
 *  deployment does not implement the mocks feature". */
export interface MocksNotPermittedEnvelope {
  code: "mocks_not_permitted";
  message: string;
}

export const MOCKS_NOT_PERMITTED_ENVELOPE: MocksNotPermittedEnvelope = {
  code: "mocks_not_permitted",
  message:
    "Mocks are not permitted in this deployment. Set CODESPAR_TEST_MODE_ENABLED=true to enable.",
};
