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
 * Matching the union of these fails closed: a request is protected if ANY
 * spelling looks protected, so a form nobody thought of has to defeat every
 * derivation at once rather than just the one that was checked.
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
