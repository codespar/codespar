/**
 * The shared secret GitHub signs webhook deliveries with.
 *
 * Same problem as the API credential, and the same answer. A webhook route
 * that accepts unverified payloads is unauthenticated input into a runtime
 * that acts on it: an accepted event is written to the audit log, broadcast
 * over SSE, and dispatched to every registered event handler. Rejecting
 * unsigned deliveries is the obvious fix and it was not available, because
 * turning it on would have rejected the webhook the runtime creates for
 * itself.
 *
 * The reason is worth stating plainly, because it made the situation worse
 * than a plain gap: `GitHubClient.createWebhook` registered hooks with no
 * `secret` in the config, so GitHub sent them unsigned. An operator who did
 * the responsible thing and set `GITHUB_WEBHOOK_SECRET` made it *worse* —
 * verification switched on, GitHub still sent nothing to verify, and every
 * delivery started failing with a missing-signature error. Trying to secure
 * it broke it.
 *
 * So the runtime provisions the secret itself: generated on demand, stored,
 * and handed to GitHub when the hook is created or reconciled. Both ends then
 * know it with nobody configuring anything, which is what makes rejecting
 * unsigned deliveries possible at all. Flipping that default is a separate,
 * informed decision (see #138) and is deliberately NOT done here.
 *
 * Precedence, most explicit first:
 *
 *   1. `webhookSecret` in the org's channel config — the operator set this
 *      through the API for this org.
 *   2. `GITHUB_WEBHOOK_SECRET_<ORG>` / `GITHUB_WEBHOOK_SECRET` — the operator
 *      set this in the environment.
 *   3. `webhookSecretGenerated` in the org's channel config — ours.
 *
 * An operator-supplied value always wins, exactly as `ENGINE_API_TOKEN` wins
 * over the generated API credential. The generated one is a floor, not an
 * override.
 *
 * Nothing here logs the secret, only where it came from.
 */

import { randomBytes } from "node:crypto";
import type { StorageProvider } from "../storage/types.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("server/webhook-secret");

/** Channel-config key holding the secret this runtime generated. */
export const GENERATED_SECRET_KEY = "webhookSecretGenerated";

/** Channel-config key holding a secret the operator configured. */
export const OPERATOR_SECRET_KEY = "webhookSecret";

/** Channel the GitHub webhook config lives under. */
const CHANNEL = "github";

const SECRET_BYTES = 32;

export type WebhookSecretSource = "operator_storage" | "operator_env" | "generated" | "none";

export interface ResolvedWebhookSecret {
  secret: string | undefined;
  source: WebhookSecretSource;
}

function envSecret(orgId: string, env: NodeJS.ProcessEnv): string | undefined {
  const orgSpecific =
    orgId !== "default"
      ? env[`GITHUB_WEBHOOK_SECRET_${orgId.toUpperCase().replace(/-/g, "_")}`]
      : undefined;
  return orgSpecific?.trim() || env["GITHUB_WEBHOOK_SECRET"]?.trim() || undefined;
}

/**
 * Resolve the secret without creating one.
 *
 * This is what the webhook handler uses. It must never provision: a request
 * arriving on an unauthenticated route must not be able to make the runtime
 * generate and persist anything.
 *
 * Unlike the previous inline lookup, storage is consulted for the "default"
 * org too. Skipping it there meant a single-tenant install — which is what
 * `docker compose up` produces — could never see a stored secret at all, so
 * provisioning one would have been writing to a slot nothing ever read.
 */
export async function resolveWebhookSecret(
  storage: StorageProvider | null,
  orgId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedWebhookSecret> {
  let config: Record<string, string> | null = null;
  if (storage) {
    try {
      config = await storage.getChannelConfig(CHANNEL);
    } catch (err) {
      log.warn("Could not read the GitHub channel config; falling back to the environment", {
        orgId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const operatorStored = config?.[OPERATOR_SECRET_KEY]?.trim();
  if (operatorStored) return { secret: operatorStored, source: "operator_storage" };

  const fromEnv = envSecret(orgId, env);
  if (fromEnv) return { secret: fromEnv, source: "operator_env" };

  const generated = config?.[GENERATED_SECRET_KEY]?.trim();
  if (generated) return { secret: generated, source: "generated" };

  return { secret: undefined, source: "none" };
}

/**
 * Resolve the secret, generating and persisting one when there is none.
 *
 * Called only from paths that are already registering a webhook with GitHub,
 * never from request handling. When this returns, the value it gives back is
 * the one that must be handed to GitHub, or the two ends will disagree and
 * every delivery will fail its signature check.
 *
 * If persistence fails the secret is NOT returned: a secret GitHub knows and
 * this runtime cannot look up again is worse than none, because deliveries
 * would then arrive signed with something unverifiable and be rejected the
 * moment strict mode is turned on.
 */
export async function provisionWebhookSecret(
  storage: StorageProvider | null,
  orgId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedWebhookSecret> {
  const existing = await resolveWebhookSecret(storage, orgId, env);
  if (existing.secret) return existing;

  if (!storage) {
    log.warn(
      "No storage available, so a webhook secret cannot be persisted and none " +
        "will be registered with GitHub. Set GITHUB_WEBHOOK_SECRET to verify " +
        "deliveries on this install.",
      { orgId },
    );
    return { secret: undefined, source: "none" };
  }

  const secret = randomBytes(SECRET_BYTES).toString("hex");
  try {
    const config = (await storage.getChannelConfig(CHANNEL)) ?? {};
    await storage.saveChannelConfig(CHANNEL, { ...config, [GENERATED_SECRET_KEY]: secret });
  } catch (err) {
    log.error(
      "Could not persist a generated webhook secret, so none will be registered " +
        "with GitHub. Deliveries stay unverified until this is fixed or " +
        "GITHUB_WEBHOOK_SECRET is set.",
      { orgId, error: err instanceof Error ? err.message : String(err) },
    );
    return { secret: undefined, source: "none" };
  }

  log.info("Generated a webhook secret for this install and stored it", { orgId });
  return { secret, source: "generated" };
}
