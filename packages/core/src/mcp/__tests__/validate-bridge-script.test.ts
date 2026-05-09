/**
 * Validate-bridge script syntax check — runs `bash -n` over the
 * canonical integration script so a typo lands a unit-test failure
 * rather than only surfacing on opt-in `MCP_DEMO=true` runs.
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "validate-bridge.sh");

describe("scripts/validate-bridge.sh", () => {
  it("[T-07.A] passes bash -n syntax check", () => {
    const result = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
