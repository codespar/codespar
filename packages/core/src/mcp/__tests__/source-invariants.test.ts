/**
 * Source-level guard — fails loudly if anyone reintroduces `MCP_DEMO`
 * branching, a hard-coded server-id allowlist, or a hard-coded `npx`
 * literal in the bridge source. These are the single tripwires that
 * keep the data-driven contract honest.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_DIR = join(__dirname, "..");

function readSrc(file: string): string {
  return readFileSync(join(MCP_DIR, file), "utf8");
}

describe("mcp bridge source invariants", () => {
  it("[AC-08.1] no MCP_DEMO literal in process-manager.ts, registry.ts, or bridge.ts", () => {
    for (const file of ["process-manager.ts", "registry.ts", "bridge.ts"]) {
      const src = readSrc(file);
      expect(src, `${file} must not reference MCP_DEMO`).not.toContain(
        "MCP_DEMO",
      );
    }
  });

  it("[AC-08.2] process-manager.ts has no hard-coded server-id allowlist", () => {
    const src = readSrc("process-manager.ts");
    for (const id of ["asaas", "nuvem-fiscal", "z-api"]) {
      expect(
        src,
        `process-manager.ts must not reference server id "${id}"`,
      ).not.toContain(id);
    }
  });

  it('[AC-08.3] process-manager.ts has no hard-coded "npx" literal', () => {
    const src = readSrc("process-manager.ts");
    expect(src, 'process-manager.ts must not contain a hard-coded "npx" literal').not.toContain(
      "npx",
    );
  });
});
