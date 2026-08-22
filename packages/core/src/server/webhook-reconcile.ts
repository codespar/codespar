/**
 * Bring existing GitHub webhooks up to the signed configuration.
 *
 * Provisioning the secret when a hook is CREATED only helps hooks created from
 * now on. Every install that already linked a repo has a hook registered
 * without a secret, delivering unsigned events forever, and nothing about
 * normal operation would ever call createWebhook for it again. Without this
 * pass the fix would apply only to new installs, and the honest instruction to
 * everyone else would be "re-register your webhooks by hand" — which is the
 * human step this whole design exists to avoid.
 *
 * So the runtime reconciles its own hooks at startup: for every linked repo,
 * set the signing secret on the hook it manages. Once a project is reconciled
 * it is marked, so this is a one-time cost per project rather than a burst of
 * GitHub calls on every boot.
 *
 * Everything here is best-effort. A runtime that cannot reach GitHub, has no
 * token, or has no configured base URL still has to start: the reconciliation
 * is a repair, not a precondition.
 *
 * This does NOT turn on strict mode. Deliveries become verifiable; whether
 * unsigned ones are rejected stays a separate, deliberate decision (#138).
 */

import { GitHubClient } from "../github/github-client.js";
import { createLogger } from "../observability/logger.js";
import type { ProjectConfig, StorageProvider } from "../storage/types.js";
import { writableBaseUrl } from "./base-url.js";
import { provisionWebhookSecret } from "./webhook-secret.js";

const log = createLogger("server/webhook-reconcile");

/**
 * Marker written onto the project config once its hook carries our secret.
 * Absent on every project that predates this, which is exactly the set that
 * needs the repair.
 */
export const RECONCILED_MARKER = "webhookSecretProvisioned";

export interface ReconcileResult {
  /** Projects whose hook now carries the secret. */
  reconciled: number;
  /** Projects skipped because they were already done. */
  alreadyDone: number;
  /** Projects that could not be reconciled this time. */
  failed: number;
  /** Why the whole pass did nothing, when that is the case. */
  skippedReason?: string;
}

/**
 * Set the signing secret on the webhook of every linked repo that lacks it.
 *
 * Never throws. Returns a summary so a caller (or a test) can tell the
 * difference between "nothing needed doing" and "nothing was done".
 */
export async function reconcileWebhookSecrets(
  storage: StorageProvider | null,
  orgId: string = "default",
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReconcileResult> {
  const result: ReconcileResult = { reconciled: 0, alreadyDone: 0, failed: 0 };

  if (!storage) {
    result.skippedReason = "no storage";
    return result;
  }

  const github = new GitHubClient();
  if (!github.isConfigured()) {
    // No token means no GitHub API. Not an error: plenty of installs never
    // link a repo at all.
    result.skippedReason = "no GitHub token configured";
    return result;
  }

  const baseUrl = writableBaseUrl();
  if (!baseUrl) {
    // The hook is identified by its delivery URL, and that URL is only known
    // from the operator's explicit WEBHOOK_BASE_URL — never guessed from a
    // request, for the reasons in base-url.ts.
    result.skippedReason = "WEBHOOK_BASE_URL is not configured";
    return result;
  }
  const webhookUrl = `${baseUrl}/webhooks/github`;

  let projects: Awaited<ReturnType<StorageProvider["getProjectsList"]>>;
  try {
    projects = await storage.getProjectsList();
  } catch (err) {
    log.warn("Could not list projects, skipping webhook reconciliation", {
      error: err instanceof Error ? err.message : String(err),
    });
    result.skippedReason = "project list unavailable";
    return result;
  }

  if (projects.length === 0) {
    result.skippedReason = "no linked projects";
    return result;
  }

  const { secret } = await provisionWebhookSecret(storage, orgId, env);
  if (!secret) {
    result.skippedReason = "no webhook secret available";
    return result;
  }

  for (const project of projects) {
    let config: ProjectConfig | null = null;
    try {
      config = await storage.getProjectConfig(project.agentId);
    } catch {
      config = null;
    }

    if (config?.webhookSecretProvisioned) {
      result.alreadyDone++;
      continue;
    }

    const owner = config?.repoOwner ?? project.repo?.split("/")[0];
    const name = config?.repoName ?? project.repo?.split("/")[1];
    if (!owner || !name) {
      result.failed++;
      continue;
    }

    try {
      // createWebhook is idempotent and, given a secret, patches the existing
      // hook's config rather than only reporting that it exists.
      const hook = await github.createWebhook(owner, name, webhookUrl, undefined, secret);
      if (!hook || !hook.secretConfigured) {
        // Not marked, so the next boot tries again. Recording success here
        // would leave the install permanently unsigned while the marker
        // claimed the repair had been done.
        result.failed++;
        continue;
      }

      if (config) {
        await storage.setProjectConfig(project.agentId, {
          ...config,
          webhookSecretProvisioned: true,
        });
      }
      result.reconciled++;
    } catch (err) {
      log.warn("Could not reconcile the webhook secret for a project", {
        project: project.id,
        error: err instanceof Error ? err.message : String(err),
      });
      result.failed++;
    }
  }

  if (result.reconciled > 0 || result.failed > 0) {
    log.info("Webhook signing secrets reconciled", {
      reconciled: result.reconciled,
      alreadyDone: result.alreadyDone,
      failed: result.failed,
    });
  }
  return result;
}
