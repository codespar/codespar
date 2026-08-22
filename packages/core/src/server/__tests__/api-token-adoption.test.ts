/**
 * The runtime must not adopt a credential somebody else planted.
 *
 * Generating a credential on first boot is what keeps an unattended install
 * alive, but it means the runtime READS a file at startup and trusts what it
 * finds. If an attacker can arrange for that file to exist first, they do not
 * need to steal the credential: they choose it.
 *
 * That was reachable. With CODESPAR_STATE_DIR unset, the search included
 * `os.tmpdir()/codespar`, and on Linux os.tmpdir() is /tmp, mode 1777. Any
 * local user could create /tmp/codespar/api-token before the runtime's first
 * boot and the runtime would adopt the value. Knowing the credential gets you
 * past the API guard AND past the check in sessions.ts, which is the route
 * that spawns a command, so an unprivileged local account ended up with code
 * execution as the service account. Docker was unaffected; the bare-metal
 * install the README documents was not.
 *
 * Two independent defences, because either alone leaves a gap: the
 * world-writable directory is not searched at all, and any file that is
 * adopted has to look like something this process wrote.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  adoptionRefusalReason,
  resolveApiToken,
  stateDirCandidates,
  API_TOKEN_FILENAME,
} from "../api-token.js";

const PLANTED = "planted-token-chosen-by-an-attacker";

function freshDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `codespar-${label}-`));
}

function plant(dir: string, mode: number): string {
  const file = path.join(dir, API_TOKEN_FILENAME);
  fs.writeFileSync(file, `${PLANTED}\n`);
  fs.chmodSync(file, mode);
  return file;
}

describe("api-token: a planted credential is never adopted", () => {
  const created: string[] = [];

  afterEach(() => {
    while (created.length) {
      fs.rmSync(created.pop()!, { recursive: true, force: true });
    }
  });

  it("does not search a world-writable temp directory", () => {
    // The direct fix for the reported vector. os.tmpdir() must not appear as
    // a candidate at all, in either direction: a directory the runtime wrote
    // to but never read back would mint a new credential every boot and hand
    // every existing client a 401, which is the outage this design exists to
    // avoid. So it is simply not part of the search.
    const candidates = stateDirCandidates({} as NodeJS.ProcessEnv);
    const tmpRoot = os.tmpdir();
    for (const candidate of candidates) {
      expect(
        candidate.startsWith(tmpRoot),
        `${candidate} is inside the temp directory, which any local user can write to`,
      ).toBe(false);
    }
  });

  it("ignores a token file that other accounts can read", () => {
    // Mode is the half we can exercise for real: an attacker who plants a
    // file has to leave it readable to be useful to them, and a credential
    // other accounts can read is not a credential.
    const dir = freshDir("mode");
    created.push(dir);
    plant(dir, 0o644);

    const resolved = resolveApiToken({ CODESPAR_STATE_DIR: dir } as NodeJS.ProcessEnv);

    expect(resolved.token).not.toBe(PLANTED);
    expect(resolved.source).toBe("generated");
  });

  it("replaces the planted file rather than leaving it in place", () => {
    // Ignoring it is not enough on its own: left behind, it would be re-read
    // and re-rejected on every boot, and the operator would never learn why.
    const dir = freshDir("replace");
    created.push(dir);
    const file = plant(dir, 0o666);

    const resolved = resolveApiToken({ CODESPAR_STATE_DIR: dir } as NodeJS.ProcessEnv);
    const onDisk = fs.readFileSync(file, "utf8").trim();

    expect(onDisk).not.toBe(PLANTED);
    expect(onDisk).toBe(resolved.token);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("refuses a token file owned by another user", () => {
    // A file owned by another uid cannot be created here without privileges,
    // so the decision is tested directly instead of mocking the filesystem
    // and then asserting on the mock. This is the real predicate the read
    // path calls, given the stat the OS would have reported.
    const foreign = { isFile: () => true, uid: 4242, mode: 0o600 };
    expect(adoptionRefusalReason(foreign, 1000)).toMatch(/owned by another user/);

    // Same file, owned by us: adoptable.
    expect(adoptionRefusalReason({ ...foreign, uid: 1000 }, 1000)).toBeNull();

    // Platforms without uids skip the ownership question entirely.
    expect(adoptionRefusalReason(foreign, null)).toBeNull();
  });

  it("refuses a file that is not a regular file, and one open to others", () => {
    expect(adoptionRefusalReason({ isFile: () => false, uid: 1000, mode: 0o600 }, 1000)).toMatch(
      /not a regular file/,
    );
    for (const mode of [0o640, 0o604, 0o666, 0o700 | 0o007]) {
      expect(
        adoptionRefusalReason({ isFile: () => true, uid: 1000, mode }, 1000),
        `mode ${mode.toString(8)}`,
      ).toMatch(/beyond its owner/);
    }
  });

  it("ignores a symlink pointing at a file the attacker controls", () => {
    // lstat, not stat, so the link itself is inspected. Following it would
    // read a file whose ownership and mode say nothing about the link.
    const dir = freshDir("symlink");
    const elsewhere = freshDir("symlink-target");
    created.push(dir, elsewhere);
    const target = path.join(elsewhere, "attacker-file");
    fs.writeFileSync(target, `${PLANTED}\n`, { mode: 0o600 });
    fs.symlinkSync(target, path.join(dir, API_TOKEN_FILENAME));

    const resolved = resolveApiToken({ CODESPAR_STATE_DIR: dir } as NodeJS.ProcessEnv);

    expect(resolved.token).not.toBe(PLANTED);
  });

  it("still adopts a credential it wrote itself", () => {
    // The defences must not cost the property they protect: a restart has to
    // find the same credential, or every client gets a 401.
    const dir = freshDir("legit");
    created.push(dir);

    const first = resolveApiToken({ CODESPAR_STATE_DIR: dir } as NodeJS.ProcessEnv);
    const second = resolveApiToken({ CODESPAR_STATE_DIR: dir } as NodeJS.ProcessEnv);

    expect(first.source).toBe("generated");
    expect(second.source).toBe("file");
    expect(second.token).toBe(first.token);
  });
});
