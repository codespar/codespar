/**
 * Example meta-tool adapter — demonstrates the `MetaToolHook` registration
 * seam end-to-end on a fresh self-hosted install, with nothing beyond the
 * framework.
 *
 * The adapter registers a single neutral meta-tool (`example_echo`) that
 * echoes and transforms its input. It exists to show the registration and
 * dispatch wiring, not to model any particular domain: it is typed only
 * against the seam's `Record<string, unknown>` input and returns a plain
 * object, so it takes no dependency on any vertical-specific contract types.
 * The runtime dispatches it by name through the standard execute path.
 *
 * A registered hook runs arbitrary in-process code on the execute path, so
 * treat any registrant with the same scrutiny as a dependency you import and
 * call. The seam does not sandbox registrants.
 */

import type {
  MetaToolHook,
  MetaToolDefinition,
  MetaToolExecutionContext,
  MetaToolResult,
} from "@codespar/core";

/** The single meta-tool name this example serves. */
export const EXAMPLE_TOOL_NAME = "example_echo";

const DEFINITIONS: MetaToolDefinition[] = [
  {
    name: EXAMPLE_TOOL_NAME,
    description:
      'Example meta-tool. Echoes the given message; action "uppercase" returns it upper-cased and action "ping" returns a fixed pong.',
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["echo", "uppercase", "ping"],
        },
        message: {
          type: "string",
        },
      },
    },
  },
];

/**
 * Build the example meta-tool hook. `id` is overridable so a test (or a
 * self-hoster experimenting with override semantics) can register two
 * distinct instances.
 */
export function createExampleMetaToolHook(id = "example"): MetaToolHook {
  return {
    id,
    handles: [EXAMPLE_TOOL_NAME],
    definitions(): MetaToolDefinition[] {
      return DEFINITIONS;
    },
    async execute(
      name: string,
      input: Record<string, unknown>,
      _ctx: MetaToolExecutionContext,
    ): Promise<MetaToolResult> {
      const start = Date.now();

      const action = typeof input["action"] === "string" ? input["action"] : "echo";
      const message = typeof input["message"] === "string" ? input["message"] : "";

      let output: unknown;
      if (action === "ping") {
        output = { pong: true };
      } else if (action === "uppercase") {
        output = { message: message.toUpperCase() };
      } else {
        output = { message };
      }

      return {
        server_id: id,
        output,
        duration_ms: Date.now() - start,
      };
    },
  };
}

/**
 * Register the example adapter on a registry exposing `registerMetaTool`
 * (the `pluginRegistry` singleton from `@codespar/core`, or a fresh
 * `PluginRegistry`). Call this during bootstrap, before `seal()`.
 */
export function registerExampleMetaTool(
  registry: { registerMetaTool(hook: MetaToolHook): void },
  id?: string,
): void {
  registry.registerMetaTool(createExampleMetaToolHook(id));
}
