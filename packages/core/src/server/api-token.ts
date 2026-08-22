/**
 * The credential that guards this runtime's control surfaces.
 *
 * The runtime is unattended infrastructure. Nobody is watching it start, and
 * an install that comes back from `docker pull` demanding a token a human
 * has to invent is an outage, not a fix. So authentication is mandatory and
 * the credential is the runtime's own problem: if the operator did not
 * supply one, the runtime mints one on first boot and writes it to its state
 * directory, where a client on the same host reads it back.
 *
 * Precedence:
 *
 *   1. ENGINE_API_TOKEN — the operator manages the credential. Nothing is
 *      generated and nothing is written to disk: a second, also-valid
 *      credential sitting in a file would widen the surface for no reason.
 *   2. An existing `api-token` file in the state directory — this boot is a
 *      restart, and whatever the operator's client already read must keep
 *      working.
 *   3. Otherwise mint 32 random bytes, persist them 0600, and use them.
 *
 * State directory. CODESPAR_STATE_DIR, when set, is used and nothing else.
 * Unset, the first writable of these wins:
 *
 *   <CODESPAR_WORK_DIR or cwd>/.codespar   — the container's volume mount
 *   ~/.codespar                            — bare-metal installs
 *   <tmpdir>/codespar                      — last resort
 *
 * That chain exists so a read-only or wrongly-owned state directory degrades
 * into a different directory rather than into a dead runtime. It matters more
 * than it looks: it is what makes it safe to drop root in the Dockerfile,
 * because the failure mode of an unwritable /app becomes a warning and a
 * fallback rather than a crash loop.
 *
 * Nothing here ever logs the token itself, only where it lives.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { createLogger } from "../observability/logger.js";

const log = createLogger("server/api-token");

/** Filename of the persisted credential inside the state directory. */
export const API_TOKEN_FILENAME = "api-token";

/** Bytes of entropy in a generated token. 32 bytes -> 64 hex characters. */
const TOKEN_BYTES = 32;

export interface ResolvedApiToken {
  /** The bearer token every protected route requires. */
  token: string;
  /** Where it came from. `env` means the operator manages it. */
  source: "env" | "file" | "generated";
  /** File holding it, or null when the operator supplied it via the env. */
  path: string | null;
}

/**
 * Candidate state directories, most specific first.
 *
 * CODESPAR_STATE_DIR, when set, is the ONLY candidate. An operator who names
 * a directory means that directory: consulting others as well would let a
 * stale credential somewhere else silently win, and would make the location
 * of the live credential depend on the working directory the runtime happened
 * to start in. An unusable configured directory is a misconfiguration to
 * report, not one to route around.
 *
 * Unset, the chain below applies. This is the path the container takes, and
 * the one that has to keep an unattended install alive.
 */
export function stateDirCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.CODESPAR_STATE_DIR?.trim();
  if (configured) return [path.resolve(configured)];

  const workDir = env.CODESPAR_WORK_DIR?.trim();
  const candidates = [path.resolve(workDir || process.cwd(), ".codespar")];

  try {
    candidates.push(path.join(os.homedir(), ".codespar"));
  } catch {
    // homedir() throws on hosts with no resolvable home. Skip it.
  }
  candidates.push(path.join(os.tmpdir(), "codespar"));

  return [...new Set(candidates)];
}

/** Read a persisted token, or null when there is nothing usable there. */
function readToken(file: string): string | null {
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Write `token` to `file` with 0600, creating the directory 0700.
 *
 * Written to a temporary name and renamed, so a reader on the same host
 * never observes a half-written credential. The explicit chmod is not
 * redundant with the `mode` option: `mode` is masked by the process umask,
 * and a runtime started with a permissive umask would otherwise leave the
 * credential group- or world-readable.
 */
function writeToken(dir: string, token: string): string | null {
  const file = path.join(dir, API_TOKEN_FILENAME);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    return file;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best effort; the caller is already moving on to the next candidate.
    }
    return null;
  }
}

/**
 * Resolve the credential for this process, materializing it if needed.
 *
 * Called once per WebhookServer construction rather than memoized at module
 * scope, so a process that constructs more than one server (tests, embedded
 * use) sees the environment it actually set.
 */
export function resolveApiToken(env: NodeJS.ProcessEnv = process.env): ResolvedApiToken {
  const supplied = env.ENGINE_API_TOKEN?.trim();
  if (supplied) {
    log.info("API auth enabled using ENGINE_API_TOKEN");
    return { token: supplied, source: "env", path: null };
  }

  const candidates = stateDirCandidates(env);

  // Read across every candidate before writing anywhere. A runtime restarted
  // from a different working directory must find the credential it minted
  // last time rather than mint a second one and lock out the operator's
  // client.
  for (const dir of candidates) {
    const file = path.join(dir, API_TOKEN_FILENAME);
    const existing = readToken(file);
    if (existing) {
      log.info("API auth enabled using the stored credential", { path: file });
      return { token: existing, source: "file", path: file };
    }
  }

  const token = randomBytes(TOKEN_BYTES).toString("hex");
  for (const dir of candidates) {
    const file = writeToken(dir, token);
    if (file) {
      log.warn(
        "No ENGINE_API_TOKEN set — generated an API credential for this install. " +
          "Read it from the file named below to call the API; set ENGINE_API_TOKEN " +
          "to manage it yourself.",
        { path: file },
      );
      return { token, source: "generated", path: file };
    }
  }

  // Every candidate refused a write. The runtime still starts and is still
  // closed to the network, but nobody can read the credential back, so the
  // API is effectively unreachable until the operator acts. Say so plainly,
  // and name the directories that were tried.
  log.error(
    "Could not persist an API credential in any state directory. The runtime " +
      "is running with a credential that exists only in memory, so the API " +
      "cannot be called until you set ENGINE_API_TOKEN or make one of these " +
      "directories writable.",
    { candidates },
  );
  return { token, source: "generated", path: null };
}
