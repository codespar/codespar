import type { PluginRegistry } from "./registry.js";
import { OSSPolicyHook } from "./oss-policy-hook.js";

/**
 * Wire the OSS deny-list policy hook into the plugin registry.
 *
 * Call this once, synchronously, before the server starts accepting requests.
 * After registration the registry is sealed so no subsequent call can replace
 * the hook — accidental double-registration throws immediately.
 *
 * In a managed deployment, the enterprise bootstrap calls its own init
 * function instead of this one. The two init functions are mutually exclusive
 * by design: this one is for self-hosted OSS runtimes only.
 */
export function initOSSPolicies(registry: PluginRegistry): void {
  registry.registerPolicy(new OSSPolicyHook());
  registry.seal();
}
