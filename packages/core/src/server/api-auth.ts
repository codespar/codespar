/**
 * Shared pieces of the API auth boundary: which path a request will be routed
 * by, and what a refusal looks like on the wire.
 *
 * Both live here because both were places where two copies of the same idea
 * had already drifted apart. The guard matched one spelling of the path while
 * the router used another, and the two refusal sites returned two different
 * JSON shapes for the same condition.
 */

/** Stable code: no usable `Authorization: Bearer <token>` header was sent. */
export const API_TOKEN_REQUIRED = "api_token_required";

/** Stable code: a well-formed bearer token was sent and it is not the one. */
export const API_TOKEN_INVALID = "api_token_invalid";

export type ApiAuthErrorCode = typeof API_TOKEN_REQUIRED | typeof API_TOKEN_INVALID;

/**
 * Operator-facing recovery text, one per code.
 *
 * Deliberately static and generic about the location. The resolved state
 * directory can be `~/.codespar`, which expands to a real home directory, and
 * echoing that to an unauthenticated caller would leak a username and the
 * filesystem layout. The startup log names the real path for whoever runs the
 * install, which is the person who needs it.
 *
 * The two strings differ because the two situations call for different
 * actions: one caller forgot the header, the other is holding a credential
 * that no longer matches and needs to re-read it. Withholding that
 * distinction would buy nothing, since the `code` field already carries it.
 * Neither string contains the token, any part of it, or its length.
 */
const REMEDIATION: Record<ApiAuthErrorCode, string> = {
  [API_TOKEN_REQUIRED]:
    "Send an Authorization header of the form 'Bearer <token>'. If you did not " +
    "set ENGINE_API_TOKEN, this runtime generated a credential on first boot and " +
    "stored it as 'api-token' in its state directory; read the token from that " +
    "file. The path in use is named in the runtime's startup log.",
  [API_TOKEN_INVALID]:
    "The presented token is not valid for this runtime. Re-read the credential " +
    "from the 'api-token' file in the runtime's state directory; if it was " +
    "regenerated, the path in use is named in the runtime's startup log. If you " +
    "set ENGINE_API_TOKEN, send that value instead.",
};

export interface ApiAuthErrorBody {
  error: string;
  code: ApiAuthErrorCode;
  remediation: string;
}

/**
 * The 401 body. `error` keeps the string the `/api/*` hook has always sent, so
 * anything already parsing that field keeps working; `code` and `remediation`
 * are additions.
 *
 * The session routes used to answer the same condition with
 * `{"error":"Missing or invalid Bearer token"}`. That divergence was an
 * accident of the two checks growing separately, and it is gone: one
 * condition, one envelope.
 */
export function apiAuthError(code: ApiAuthErrorCode): ApiAuthErrorBody {
  return { error: "Unauthorized", code, remediation: REMEDIATION[code] };
}

/**
 * The routes that answer without a credential, on purpose.
 *
 * Keys are `<METHOD> <route url as Fastify registered it>` — `/api/agents/:id`,
 * never a concrete target — because the question is about the handler that is
 * going to run, and the router is the only thing that knows which one that is.
 *
 * This map is the ONLY thing that opens a route. Everything the server
 * registers, today or tomorrow, needs the bearer credential unless it is
 * named here; registerApiAuth() in webhook-server.ts reads nothing else. It
 * used to work the other way round: the guard protected the `/api`,
 * `/sessions` and `/a2a` prefixes, so a route was public whenever it happened
 * to be registered somewhere else in the tree. Nothing made a new route
 * declare an access level, and the author who forgot got a working, open
 * endpoint instead of an error (oss#137). This is a published MIT runtime, so
 * "somewhere else in the tree" includes every route an embedder registers on
 * the Fastify instance it is handed.
 *
 * Adding an entry here is now the one way to make a route public, and each
 * entry carries the reason a reviewer will ask for. The `/v1` mirrors are
 * spelled out rather than derived, so publishing a route does not silently
 * publish its mirror as well.
 *
 * Exported because route-coverage.test.ts drives every registered route
 * against this list. It reads the list; it does not re-implement the rule.
 */
export const PUBLIC_ROUTES: ReadonlyMap<string, string> = new Map<string, string>([
  // Container healthchecks and load balancers cannot present a bearer token.
  // docker-compose.yml probes this with a bare node http.get.
  ["GET /health", "container healthcheck, no way to send a credential"],
  ["GET /v1/health", "same, /v1 mirror"],

  // A2A discovery. Peers fetch this before any credential exists between
  // them; it advertises only this runtime's own name and address.
  ["GET /.well-known/agent.json", "A2A discovery, pre-credential by design"],

  // OAuth install/callback: a browser arrives here mid-redirect, and the
  // provider calls back with a code. Neither can attach a bearer token.
  ["GET /api/slack/install", "OAuth redirect, browser cannot send a token"],
  ["GET /v1/api/slack/install", "same, /v1 mirror"],
  ["GET /api/slack/callback", "OAuth callback from the provider"],
  ["GET /v1/api/slack/callback", "same, /v1 mirror"],
  ["GET /api/discord/install", "OAuth redirect, browser cannot send a token"],
  ["GET /v1/api/discord/install", "same, /v1 mirror"],
  ["GET /api/github/install", "OAuth redirect, browser cannot send a token"],
  ["GET /v1/api/github/install", "same, /v1 mirror"],
  ["GET /api/github/callback", "OAuth callback from the provider"],
  ["GET /v1/api/github/callback", "same, /v1 mirror"],

  // Provider webhooks are exempt from the bearer credential because the
  // providers cannot send one; they sign instead. That signature is only
  // verified once a secret is configured, and the default install has none,
  // so on a fresh install these four accept unverified payloads (#138). They
  // are listed here as "not bearer-authenticated", which is all this list
  // claims; do not read the entries below as "verified".
  ["POST /webhooks/github", "provider signs; verified only when a secret is set (#138)"],
  ["POST /v1/webhooks/github", "same, /v1 mirror"],
  ["POST /webhooks/vercel", "provider signs; verified only when a secret is set (#138)"],
  ["POST /v1/webhooks/vercel", "same, /v1 mirror"],
  ["POST /webhooks/sentry", "provider signs; verified only when a secret is set (#138)"],
  ["POST /v1/webhooks/sentry", "same, /v1 mirror"],
  ["POST /webhooks/deploy", "shared-secret signature; verified only when a secret is set (#138)"],
  ["POST /v1/webhooks/deploy", "same, /v1 mirror"],
]);

/**
 * Did the router match a route that is declared public?
 *
 * `matchedRoute` is `request.routeOptions.url`, and `undefined` means the
 * router matched nothing. That answers false: a target with no route has no
 * handler to be public, and treating "I cannot tell" as public is the shape
 * of every bypass this file exists to prevent.
 *
 * HEAD asks the GET question. Fastify auto-registers a HEAD for every GET
 * route (exposeHeadRoutes) pointing at the same handler and reports it as a
 * separate entry in the route table, so a list that spelled out only GET
 * would answer 401 to a load balancer probing HEAD /health and mark the
 * container unhealthy. The access class belongs to the handler, and the
 * handler is the GET one.
 */
export function isPublicRoute(method: string, matchedRoute: string | undefined): boolean {
  if (matchedRoute === undefined) return false;
  const verb = method === "HEAD" ? "GET" : method;
  return PUBLIC_ROUTES.has(`${verb} ${matchedRoute}`);
}

/** Placeholder origin: only the path component of the result is ever read. */
const PATH_BASE = "http://path.invalid";

/**
 * Strip query and fragment without interpreting anything else.
 */
function stripQuery(url: string): string {
  return url.split("?")[0].split("#")[0];
}

/**
 * The single path the router will dispatch on, decoded, or `null` when that
 * cannot be determined.
 *
 * Used for the "is this route deliberately public" decision, which has to be
 * about the handler that will actually run.
 */
export function routedPath(rawUrl: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(rawUrl, PATH_BASE).pathname;
  } catch {
    return null;
  }
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

/**
 * Every spelling of the path this request could plausibly be matched by.
 * `null` means "cannot tell", and the caller must treat that as protected.
 *
 * There are more spellings than there look to be, and each one has already
 * been a bypass in this file:
 *
 *   - The raw request-target. What the guard used to match on, alone.
 *   - The percent-decoded form. Fastify routes on the decoded path, so
 *     `GET /%61pi/agents` reached the `/api/agents` handler while a guard
 *     matching the raw string saw something starting with `/%61` and let it
 *     through.
 *   - The pathname of the request-target parsed as a URL. A client may send
 *     an absolute-form request-target (RFC 7230 5.3.2), which any HTTP proxy
 *     does: `DELETE http://host/api/audit` arrives with `request.url` set to
 *     the whole URI. `startsWith("/api")` is false for a string beginning
 *     `http://`, so the guard returned early while the router dispatched on
 *     the path component and cleared the audit log for an anonymous caller.
 *
 * Since oss#137 the guard no longer decides protection from these spellings:
 * it refuses everything the router did not match to a route in PUBLIC_ROUTES,
 * so a new spelling has nothing left to walk into. What survives here is the
 * `null` case — a target this cannot parse or decode is one whose routed path
 * is unknown, and unknown is refused. The derivations themselves are kept and
 * still pinned by request-target-forms.test.ts, because they document the
 * four forms that were live bypasses and because `null` is computed from them.
 */
export function candidatePaths(rawUrl: string): string[] | null {
  const candidates = new Set<string>([stripQuery(rawUrl)]);

  try {
    candidates.add(new URL(rawUrl, PATH_BASE).pathname);
  } catch {
    return null;
  }

  for (const candidate of [...candidates]) {
    try {
      candidates.add(decodeURIComponent(candidate));
    } catch {
      return null;
    }
  }

  return [...candidates];
}
