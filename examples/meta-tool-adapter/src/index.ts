/**
 * Example MIT meta-tool adapter — proves the MetaToolHook registration
 * seam works end-to-end on a fresh self-hosted install, with nothing
 * beyond the framework.
 *
 * !! DO NOT USE THIS AS A SKELETON FOR A REAL ADAPTER. !!
 *
 * This adapter is deliberately trivial and deliberately UNSAFE for live
 * traffic. It implements NONE of the input-validation obligations a real
 * registrant must honor (SSRF normalization, host allow-listing, DoS
 * bounds, PII/secret redaction). To make the "fork the example" path safe
 * by construction, it REJECTS any request that carries a real `url` or
 * `merchant` outright — so a copy-paste self-hoster cannot accidentally
 * ship an adapter that dereferences an agent-supplied URL without guards.
 *
 * The sample payment code it returns is an obviously-fake, non-settling
 * marker. It mints no real payment and moves no money. Register a real
 * implementation against the seam for live coverage.
 *
 * The adapter is generic: it is typed only against the seam's
 * `Record<string, unknown>` input and returns a plain object, so it takes
 * no dependency on any vertical-specific contract types. The runtime
 * dispatches it by name through the standard execute path.
 */

import type {
  MetaToolHook,
  MetaToolDefinition,
  MetaToolExecutionContext,
  MetaToolResult,
} from "@codespar/core";

/** A clearly-fake, non-settling sample marker. Never a real payment code. */
export const SAMPLE_NON_PAYABLE_CODE =
  "EXAMPLE-NON-PAYABLE-DO-NOT-PAY-0000000000000000";

/** The single meta-tool name this example serves. */
export const EXAMPLE_TOOL_NAME = "codespar_shop";

/**
 * Reject any value that looks like a real, dereferenceable target. The
 * example performs no SSRF normalization, so the only safe stance is to
 * refuse these inputs entirely rather than dereference them.
 */
function carriesRealTarget(input: Record<string, unknown>): boolean {
  const url = input["url"];
  const merchant = input["merchant"];
  const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
  return nonEmpty(url) || nonEmpty(merchant);
}

const DEFINITIONS: MetaToolDefinition[] = [
  {
    name: EXAMPLE_TOOL_NAME,
    description:
      "Example meta-tool. Returns a fixed sample offer and a non-payable sample code. Illustrative only; not production coverage.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["search", "checkout", "checkout_status"],
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

      // Hard refusal: the example makes no outbound call and validates
      // nothing, so it must never accept a real dereference target.
      if (carriesRealTarget(input)) {
        throw new Error(
          "example adapter rejects real url/merchant: it implements no SSRF/input validation and must not dereference agent-supplied targets",
        );
      }

      const action = typeof input["action"] === "string" ? input["action"] : "search";

      let output: unknown;
      if (action === "checkout_status") {
        output = {
          checkout_session_id: "example-session",
          status: "ready_for_payment",
          // Obviously non-payable — proves the seam, settles nothing.
          pix_copia_e_cola: SAMPLE_NON_PAYABLE_CODE,
          total_minor: 1000,
          currency: "BRL",
          note: "sample non-payable code from the example adapter",
        };
      } else if (action === "checkout") {
        output = {
          checkout_session_id: "example-session",
          status: "in_progress",
          message: "sample checkout started by the example adapter",
        };
      } else {
        output = {
          rail: "example",
          products: [
            {
              product_id: "example-001",
              sku_id: "example-sku-001",
              title: "Example product",
              price_minor: 1000,
              currency: "BRL",
              available: true,
              variants: [],
            },
          ],
        };
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
