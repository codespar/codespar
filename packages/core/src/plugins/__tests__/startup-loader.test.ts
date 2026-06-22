import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadStartupPlugins,
  parsePluginSpecifiers,
  validatePluginSpecifier,
} from "../startup-loader.js";
import { PluginRegistry } from "../registry.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string): string => join(FIXTURES, name);

describe("parsePluginSpecifiers", () => {
  it("splits on commas, trims, and drops empties", () => {
    expect(parsePluginSpecifiers(" a , b ,, c ")).toEqual(["a", "b", "c"]);
  });
  it("returns [] for undefined or blank", () => {
    expect(parsePluginSpecifiers(undefined)).toEqual([]);
    expect(parsePluginSpecifiers("   ")).toEqual([]);
  });
});

describe("validatePluginSpecifier", () => {
  it("accepts bare packages and paths", () => {
    for (const ok of ["@codespar/plugin", "my-plugin", "./local.mjs", "/abs/plugin.mjs"]) {
      expect(() => validatePluginSpecifier(ok)).not.toThrow();
    }
  });
  it("rejects every URL scheme (the eval-equivalent vectors)", () => {
    for (const bad of [
      "data:text/javascript,console.log(1)",
      "node:fs",
      "file:///etc/passwd",
      "http://evil.test/p.mjs",
      "https://evil.test/p.mjs",
    ]) {
      expect(() => validatePluginSpecifier(bad)).toThrow(/URL-scheme/);
    }
  });
});

describe("loadStartupPlugins", () => {
  it("registers nothing when CODESPAR_PLUGINS is unset (raw-tools-only)", async () => {
    const reg = new PluginRegistry();
    const loaded = await loadStartupPlugins(reg, {});
    expect(loaded).toEqual([]);
    expect(reg.metaToolDefinitions()).toHaveLength(0);
    expect(reg.getMetaTool("codespar_demo")).toBeNull();
  });

  it("imports a configured plugin and registers its meta-tool", async () => {
    const reg = new PluginRegistry();
    const loaded = await loadStartupPlugins(reg, { CODESPAR_PLUGINS: fixture("good-plugin.mjs") });
    expect(loaded).toHaveLength(1);
    expect(reg.getMetaTool("codespar_demo")).not.toBeNull();
  });

  it("fails closed when a meta-tool name contains the raw separator '__'", async () => {
    const reg = new PluginRegistry();
    await expect(
      loadStartupPlugins(reg, { CODESPAR_PLUGINS: fixture("bad-name-plugin.mjs") }),
    ).rejects.toThrow(/must not contain "__"/);
  });

  it("fails closed when two plugins claim the same meta-tool name", async () => {
    const reg = new PluginRegistry();
    await expect(
      loadStartupPlugins(reg, {
        CODESPAR_PLUGINS: `${fixture("good-plugin.mjs")},${fixture("dup-plugin.mjs")}`,
      }),
    ).rejects.toThrow(/registered by two plugins/);
  });

  it("fails closed when a module has no register export", async () => {
    const reg = new PluginRegistry();
    await expect(
      loadStartupPlugins(reg, { CODESPAR_PLUGINS: fixture("no-register.mjs") }),
    ).rejects.toThrow(/must export a default \(or "register"\) function/);
  });

  it("fails closed when a specifier cannot be imported", async () => {
    const reg = new PluginRegistry();
    await expect(
      loadStartupPlugins(reg, { CODESPAR_PLUGINS: fixture("does-not-exist.mjs") }),
    ).rejects.toThrow(/failed to import/);
  });

  it("rejects a URL-scheme specifier before importing", async () => {
    const reg = new PluginRegistry();
    await expect(
      loadStartupPlugins(reg, { CODESPAR_PLUGINS: "data:text/javascript,1" }),
    ).rejects.toThrow(/URL-scheme/);
  });
});
