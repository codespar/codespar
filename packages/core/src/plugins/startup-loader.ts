/**
 * Startup plugin loader.
 *
 * Lets a self-hoster register `MetaToolHook`s into a running OSS runtime
 * WITHOUT modifying core: set `CODESPAR_PLUGINS` to a comma-separated list of
 * module specifiers (bare package names or filesystem paths), and the server
 * imports each at boot and calls its exported `register(registry)` against the
 * global `pluginRegistry`, before it begins serving. With `CODESPAR_PLUGINS`
 * unset, nothing is registered and the tool catalog stays raw-tools-only.
 *
 * Trust model: `CODESPAR_PLUGINS` is set by whoever operates the runtime — the
 * same authority that chooses the image and every other env var — so this is
 * configuration, not a remote-code-execution vector. It is hardened anyway:
 *  - specifiers are validated to be bare packages or paths; every URL scheme
 *    (`data:`, `node:`, `file:`, `http(s):`, ...) is rejected, so the loader
 *    never fetches or inlines code;
 *  - it fails closed — any import error, a missing register export, a
 *    meta-tool name containing the raw-tool separator `__` (which would let a
 *    plugin shadow a raw `serverId__tool` the agent calls), or a name claimed
 *    by two plugins aborts startup with a diagnostic;
 *  - it never reads the plugin list from request input, only the boot-time env,
 *    and never evals a string.
 *
 * It is the caller's responsibility to invoke this AFTER secrets/policy/auth
 * bootstrap and BEFORE `listen()`, so plugin `register()` code inherits those
 * hooks and cannot pre-empt them.
 */

import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createLogger } from "../observability/logger.js";
import type { MetaToolHook } from "./types.js";
import type { PluginRegistry } from "./registry.js";

const log = createLogger("plugin-loader");

/** The raw-tool name separator; meta-tool names must not contain it. */
const RAW_TOOL_SEPARATOR = "__";

/** The minimal registry surface a startup plugin is handed. */
export interface PluginRegisterTarget {
  registerMetaTool(hook: MetaToolHook): void;
}

/** A startup plugin module: a default (or named `register`) registration fn. */
export interface StartupPluginModule {
  default?: (registry: PluginRegisterTarget) => void | Promise<void>;
  register?: (registry: PluginRegisterTarget) => void | Promise<void>;
}

/** Split the `CODESPAR_PLUGINS` value into trimmed, non-empty specifiers. */
export function parsePluginSpecifiers(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Reject anything that is not a bare package specifier or a filesystem path.
 * A real URL scheme is two-or-more characters followed by `:` (so a Windows
 * drive letter `C:\` — a single-char "scheme" — is allowed); `data:`/`node:`/
 * `file:`/`http(s):` all match and are refused. Control characters are refused.
 */
export function validatePluginSpecifier(spec: string): void {
  if (spec.includes("\n") || spec.includes("\0")) {
    throw new Error(`CODESPAR_PLUGINS: specifier contains a control character`);
  }
  if (/^[a-z][a-z0-9+.-]+:/i.test(spec)) {
    throw new Error(
      `CODESPAR_PLUGINS: refusing URL-scheme specifier "${spec}" — only bare packages or filesystem paths are allowed`,
    );
  }
}

/** Resolve a specifier to something `import()` accepts: paths become file URLs. */
function resolveSpecifier(spec: string): string {
  if (spec.startsWith(".") || spec.startsWith("/") || isAbsolute(spec)) {
    return pathToFileURL(resolve(process.cwd(), spec)).href;
  }
  return spec;
}

/**
 * Import each `CODESPAR_PLUGINS` module and register its meta-tools on
 * `registry`, fail-closed. Returns the list of specifiers loaded (empty when
 * `CODESPAR_PLUGINS` is unset). Throws on the first failure so a misconfigured
 * runtime never serves a partial or unsafe catalog.
 */
export async function loadStartupPlugins(
  registry: PluginRegistry,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const specs = parsePluginSpecifiers(env["CODESPAR_PLUGINS"]);
  if (specs.length === 0) return [];

  // name -> the specifier that first claimed it, for cross-plugin collision detection.
  const claimedBy = new Map<string, string>();
  let activeSpec = "";

  const guard: PluginRegisterTarget = {
    registerMetaTool(hook: MetaToolHook): void {
      for (const name of hook.handles) {
        if (name.includes(RAW_TOOL_SEPARATOR)) {
          throw new Error(
            `CODESPAR_PLUGINS: plugin "${activeSpec}" registered meta-tool "${name}" — names must not contain "${RAW_TOOL_SEPARATOR}" (reserved for raw server tools)`,
          );
        }
        const owner = claimedBy.get(name);
        if (owner && owner !== activeSpec) {
          throw new Error(
            `CODESPAR_PLUGINS: meta-tool "${name}" is registered by two plugins ("${owner}" and "${activeSpec}")`,
          );
        }
      }
      for (const name of hook.handles) claimedBy.set(name, activeSpec);
      registry.registerMetaTool(hook);
    },
  };

  const loaded: string[] = [];
  for (const spec of specs) {
    validatePluginSpecifier(spec);
    activeSpec = spec;

    let mod: StartupPluginModule;
    try {
      mod = (await import(resolveSpecifier(spec))) as StartupPluginModule;
    } catch (err) {
      throw new Error(
        `CODESPAR_PLUGINS: failed to import "${spec}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const register = mod.default ?? mod.register;
    if (typeof register !== "function") {
      throw new Error(
        `CODESPAR_PLUGINS: plugin "${spec}" must export a default (or "register") function that takes a registry`,
      );
    }

    await register(guard);
    loaded.push(spec);
  }

  log.info("Loaded startup plugins", { specifiers: loaded, metaTools: [...claimedBy.keys()] });
  return loaded;
}
