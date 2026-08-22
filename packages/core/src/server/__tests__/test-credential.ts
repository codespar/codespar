/**
 * Shared credential for suites that drive protected routes.
 *
 * Every `/api/*`, `/sessions/*` and `/a2a/*` route requires a bearer token
 * (BLOCKER oss-sdk#5). Suites that exercise something else through those
 * routes still have to authenticate, so they set ENGINE_API_TOKEN to the
 * constant below and send `authHeaders()`.
 *
 * Setting the variable also keeps the suite hermetic: with it set, the
 * runtime uses it verbatim and never mints or reads a credential file, so
 * tests neither write into the checkout nor inherit a token left behind by
 * an earlier run.
 *
 * This is not a fixture standing in for the real check. The token here is
 * verified by exactly the same comparison a production token goes through;
 * the auth behaviour itself is pinned in api-auth.test.ts and
 * anonymous-access.test.ts.
 */

/**
 * The literal is "test" because the session suites already send
 * `Bearer test` on every request. Naming that value here makes those
 * headers correct credentials rather than leftovers from the era when any
 * string was accepted.
 */
export const TEST_API_TOKEN = "test";

/** `authorization` header for TEST_API_TOKEN, merged with anything extra. */
export function authHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return { authorization: `Bearer ${TEST_API_TOKEN}`, ...extra };
}
