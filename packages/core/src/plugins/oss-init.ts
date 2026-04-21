import type { PluginRegistry } from "./registry.js";
import { OSSPolicyHook } from "./oss-policy-hook.js";

/**
 * Wire the OSS deny-list policy hook into the plugin registry.
 *
 * Call this once, synchronously, before the server starts accepting requests.
 * After registration the registry is sealed so no subsequent call can replace
 * the hook — accidental double-registration throws immediately.
 *
 * If you have registered your own PolicyHook before calling this, the sealed
 * registry will throw. Register only one hook per process.
 */
export function initOSSPolicies(registry: PluginRegistry): void {
  registry.registerPolicy(new OSSPolicyHook());
  registry.seal();
}
