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
 *
 * That chain exists so a read-only or wrongly-owned state directory costs the
 * install its credential rather than its ability to boot.
 *
 * Scope, because an earlier version of this comment overstated it: the
 * fallback covers THIS file only. FileStorage writes to the same directory
 * and has nowhere else to go, so on a wrongly-owned directory it still throws
 * and takes the process with it. Dropping root in the Dockerfile is therefore
 * not made safe by this fallback alone; the entrypoint runs an explicit
 * preflight (preflightStateDir in server/start.mjs) that catches the case up
 * front and prints the chown that fixes it.
 *
 * A world-writable temp directory is deliberately not in that chain, in
 * either direction; see stateDirCandidates for why. An existing file is only
 * adopted when it is a regular file owned by this uid with no group or other
 * permission bits, so a credential planted by another account is ignored
 * rather than trusted.
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

  // os.tmpdir() is deliberately NOT a candidate, in either direction.
  //
  // On Linux it is /tmp, mode 1777. Any local user could create
  // /tmp/codespar/api-token holding a value of their choosing before the
  // runtime's first boot, and the runtime would adopt it: the read loop
  // reached tmp before anything had been written anywhere. Knowing the
  // credential gets you past this hook AND past the check in sessions.ts,
  // which is the route that spawns a command, so an unprivileged local user
  // ended up with code execution as the service account.
  //
  // It is dropped from writes too, not just reads. A directory the runtime
  // writes to but never reads back would mint a fresh credential on every
  // boot and hand every existing client a 401, which is the availability
  // failure this whole design exists to avoid. If neither candidate above
  // works, resolveApiToken falls through to the in-memory branch and says so
  // loudly, which is honest rather than quietly broken.

  return [...new Set(candidates)];
}

/** The parts of `fs.Stats` the adoption decision depends on. */
export interface AdoptionStat {
  isFile(): boolean;
  uid: number;
  mode: number;
}

/**
 * Whether an existing `api-token` file may be trusted, or the reason not.
 *
 * Adopting a file means trusting whoever wrote it, so it has to look like
 * something this process wrote: a regular file (the caller uses lstat, so a
 * symlink is rejected rather than followed somewhere else), owned by this
 * uid, and with no permission bits for group or other. A planted credential
 * fails the ownership check even in a directory the attacker fully controls,
 * and a credential other accounts can read is not a credential.
 *
 * Exported as a pure function on purpose: a file owned by another user cannot
 * be created without privileges, so this is the only way to test that branch
 * for real rather than by mocking the filesystem and asserting on the mock.
 *
 * `currentUid` is null on platforms without uids, where the check does not
 * apply.
 */
export function adoptionRefusalReason(
  st: AdoptionStat,
  currentUid: number | null,
): string | null {
  if (!st.isFile()) return "not a regular file";
  if (currentUid !== null && st.uid !== currentUid) {
    return "owned by another user, so it was not written by this runtime";
  }
  if ((st.mode & 0o077) !== 0) {
    return "readable or writable beyond its owner";
  }
  return null;
}

/** Read a persisted token, or null when there is nothing safe to adopt. */
function readToken(file: string): string | null {
  try {
    const st = fs.lstatSync(file);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    const refusal = adoptionRefusalReason(st, uid);

    if (refusal !== null) {
      log.warn(
        `Ignoring an existing api-token file: ${refusal}. It is not trusted, ` +
          "and a new credential will be generated in its place. Set " +
          "ENGINE_API_TOKEN to choose the credential explicitly.",
        { path: file, mode: (st.mode & 0o777).toString(8) },
      );
      return null;
    }

    const raw = fs.readFileSync(file, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Write `token` to `file` with 0600, creating the directory 0700.
 *
 * Written to a uniquely-named temporary file and renamed, so a reader on the
 * same host never observes a half-written credential, and two writers never
 * share the temporary. The explicit chmod is not
 * redundant with the `mode` option: `mode` is masked by the process umask,
 * and a runtime started with a permissive umask would otherwise leave the
 * credential group- or world-readable.
 */
function writeToken(dir: string, token: string): string | null {
  const file = path.join(dir, API_TOKEN_FILENAME);
  // Random, not just the pid. In Docker every container is PID 1, and this
  // release mounts a shared named volume across replicas, so two of them
  // writing at once would both pick `api-token.1.tmp` and interleave into one
  // file. The pid stays because it is useful when reading a directory by hand;
  // the randomness is what actually makes the name unique.
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
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
 * What the file said after we wrote it.
 *
 *   "ours"       the value on disk is the one generated here.
 *   "lost_race"  a different value is there, so another instance wrote first.
 *   "unreadable" nothing adoptable came back.
 *
 * Pure and exported so the lost-race branch can be tested at all. Staging a
 * real interleaving of two writers from inside one process is not possible
 * here: resolveApiToken reads before it writes, so a second call in the same
 * process finds the file and returns early, never reaching this decision. A
 * test that drove it that way would look like it covered the race while
 * exercising a different branch entirely.
 */
export function classifyWriteBack(
  onDisk: string | null,
  generated: string,
): "ours" | "lost_race" | "unreadable" {
  if (onDisk === null) return "unreadable";
  return onDisk === generated ? "ours" : "lost_race";
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
    if (!file) continue;

    // Read back what is actually on disk before trusting the value in hand.
    //
    // Two replicas sharing a state directory and starting together both find
    // no credential, both generate one, and both write. The rename is atomic,
    // so one of them wins the file and the other is left holding a token that
    // matches nothing. Without this read-back that replica serves 401 to every
    // caller while logging that all is well: the failure is silent, and it is
    // silent at three in the morning with no human watching, which is the
    // scenario this whole design exists for.
    //
    // A replica that finds a different value here adopts it, and the two
    // converge. Be precise about how much that buys, because an earlier
    // version of this comment was not:
    //
    // This NARROWS the window. It does not make losing the race loud. The
    // dominant ordering is the one this check cannot see — A writes, reads
    // back, finds its own value, logs a normal boot and returns, and only
    // THEN B renames over it. A is now stale having never had anything to
    // detect. Measured under a clock barrier (15 runs, 12 processes on one
    // state directory): every run diverged, and 78% of the stale replicas
    // logged an ordinary "using the stored credential" boot.
    //
    // The consequence is availability, not access: a stale replica answers
    // 401 to legitimate callers, and no invalid token becomes valid. The
    // supported way to run more than one replica is ENGINE_API_TOKEN, which
    // removes the race rather than narrowing it.
    const onDisk = readToken(file);
    const outcome = classifyWriteBack(onDisk, token);

    if (outcome === "lost_race") {
      log.warn(
        "Another instance wrote this credential first, so its value is being " +
          "used instead of the one generated here. That is expected when " +
          "several replicas share a state directory and start together. Set " +
          "ENGINE_API_TOKEN to give every replica the same credential " +
          "explicitly, which removes the race.",
        { path: file },
      );
      return { token: onDisk as string, source: "file", path: file };
    }

    if (outcome === "unreadable") {
      // Written, then unreadable: a different owner, a stricter mode, or the
      // file removed between the two operations. Not fatal, but the credential
      // will not survive a restart, and nobody can read it back to call the
      // API, so it must not pass as a normal boot.
      log.error(
        "Wrote an API credential but could not read it back, so it will not " +
          "survive a restart and cannot be read by a local client. Set " +
          "ENGINE_API_TOKEN, or check the ownership and permissions of the " +
          "state directory.",
        { path: file },
      );
      return { token, source: "generated", path: null };
    }

    log.warn(
      "No ENGINE_API_TOKEN set — generated an API credential for this install. " +
        "Read it from the file named below to call the API; set ENGINE_API_TOKEN " +
        "to manage it yourself.",
      { path: file },
    );
    return { token, source: "generated", path: file };
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
