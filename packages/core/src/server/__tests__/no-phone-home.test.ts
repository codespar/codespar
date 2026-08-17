/**
 * BLOCKER oss-sdk#1 regression guard.
 *
 * The MIT runtime must not phone home. README.md promises "no phone-home,
 * fully operable without codespar infrastructure" (README.md:39, :352).
 *
 * The literal CodeSpar production host must never appear as a default in the
 * shipped MIT source, because it is used as a webhook target that is written
 * INTO the self-hoster's own GitHub repo (agents.ts POST /api/projects ->
 * github-client.createWebhook), delivering their repo events to CodeSpar.
 *
 * This test fails on HEAD (0d75873) because the literal is hardcoded as a
 * `process.env.WEBHOOK_BASE_URL || "https://codespar-production.up.railway.app"`
 * fallback in seven source sites.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN_HOST = "codespar-production.up.railway.app";

// Repo root: this file is packages/core/src/server/__tests__/no-phone-home.test.ts
const PACKAGES_DIR = join(import.meta.dirname, "..", "..", "..", "..");

function collectTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "node_modules" || entry === "dist" || entry === ".turbo") continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      collectTsFiles(full, acc);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      // Skip this guard file itself (it names the forbidden host on purpose).
      if (full.endsWith("no-phone-home.test.ts")) continue;
      acc.push(full);
    }
  }
  return acc;
}

describe("MIT runtime: no phone-home (BLOCKER oss-sdk#1)", () => {
  it("no source file hardcodes the CodeSpar production host as a default", () => {
    const files = collectTsFiles(PACKAGES_DIR);
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf-8");
      if (src.includes(FORBIDDEN_HOST)) {
        const line =
          src.split("\n").findIndex((l) => l.includes(FORBIDDEN_HOST)) + 1;
        offenders.push(`${f.replace(PACKAGES_DIR, "packages")}:${line}`);
      }
    }
    expect(
      offenders,
      `The MIT runtime must not embed the CodeSpar production host. ` +
        `Derive the base URL from the request host or require WEBHOOK_BASE_URL. ` +
        `Offending sites:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
