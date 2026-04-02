/**
 * Webhook routes — GitHub, Vercel, deploy, Sentry incoming webhooks + status/URL endpoints.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { parseGitHubWebhook } from "../../webhooks/github-handler.js";
import { createLogger } from "../../observability/logger.js";
import { metrics } from "../../observability/metrics.js";
import { GitHubClient } from "../../github/github-client.js";
import { broadcastEvent } from "../webhook-server.js";
import type { RouteFn, ServerContext } from "./types.js";

const log = createLogger("routes/webhooks");

function verifyGitHubSignature(payload: string, signature: string, secret: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function registerWebhookRoutes(route: RouteFn, ctx: ServerContext): void {
    // GitHub webhook receiver
    route("post", "/webhooks/github", async (request: any, reply: any) => {
      metrics.increment("webhook.received");
      const orgId = (request.query as Record<string, string>).orgId || (request.headers["x-org-id"] as string) || "default";
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === "string") {
          headers[key.toLowerCase()] = value;
        }
      }

      // Verify GitHub webhook signature when secret is configured.
      // Priority: org storage secret > env GITHUB_WEBHOOK_SECRET_<ORGID> > env GITHUB_WEBHOOK_SECRET.
      let webhookSecret: string | undefined;
      if (ctx.storageProvider && orgId !== "default") {
        try {
          const orgStorage = ctx.getOrgStorage(orgId);
          const ghConfig = await orgStorage.getChannelConfig("github");
          if (ghConfig?.webhookSecret) {
            webhookSecret = ghConfig.webhookSecret;
          }
        } catch (err) {
          log.warn("Failed to load org GitHub webhook secret, using env fallback", { orgId, error: String(err) });
        }
      }
      if (!webhookSecret) {
        const orgSpecificSecret = orgId !== "default"
          ? process.env[`GITHUB_WEBHOOK_SECRET_${orgId.toUpperCase().replace(/-/g, "_")}`]
          : undefined;
        webhookSecret = orgSpecificSecret || process.env["GITHUB_WEBHOOK_SECRET"];
      }
      if (webhookSecret) {
        const signature = headers["x-hub-signature-256"];
        if (!signature) {
          return reply.status(401).send({ error: "Missing x-hub-signature-256 header" });
        }

        const rawBody = typeof request.body === "string"
          ? request.body
          : JSON.stringify(request.body);

        if (!verifyGitHubSignature(rawBody, signature, webhookSecret)) {
          return reply.status(401).send({ error: "Invalid webhook signature" });
        }
      } else {
        log.warn("GITHUB_WEBHOOK_SECRET is not set — skipping signature verification");
      }

      const event = parseGitHubWebhook(headers, request.body);

      if (!event) {
        return reply.status(200).send({ received: true, processed: false });
      }

      // Skip intermediate workflow_run states -- only log the final result
      // (a single push generates queued, in_progress, and completed events)
      if (event.type === "workflow_run" && (event.status === "in_progress" || event.status === "queued")) {
        return reply.status(200).send({ received: true, processed: false, reason: "intermediate_state" });
      }

      // Resolve the agent that owns this repo
      const repoName = event.repo.split("/")[1] || event.repo;
      const agentStatuses = ctx.agentSupervisor?.getAgentStatuses() ?? [];
      const matchingAgent = agentStatuses.find((a) =>
        a.projectId === repoName || a.id.includes(repoName)
      );
      const resolvedAgentId = matchingAgent?.id ?? "agent-default";

      // Log to audit with org-scoped storage
      const ghStorage = ctx.getOrgStorage(orgId);
      await ghStorage.appendAudit({
        actorType: "system",
        actorId: "github",
        action: `ci.${event.type}`,
        result: event.status === "failure" ? "error" : event.status === "success" ? "success" : "pending",
        metadata: {
          repo: event.repo,
          branch: event.branch,
          project: event.repo.split("/")[1] || event.repo,
          title: event.details.title,
          commitSha: event.details.sha,
          commitMessage: event.details.title || "",
          commitAuthor: "",
          url: event.details.url || "",
          inspectorUrl: event.details.url || "",
          risk: event.status === "failure" ? "critical" : "low",
          detail: `${event.repo}: ${event.details.title || event.type}${event.branch ? ` (${event.branch})` : ""}`,
          source: "github",
          agentId: resolvedAgentId,
          orgId,
        },
      });

      // Broadcast to SSE clients scoped to org
      broadcastEvent({
        type: "ci.event",
        data: { repo: event.repo, type: event.type, status: event.status, branch: event.branch, orgId, agentId: resolvedAgentId },
      }, orgId);

      // Dispatch to all registered handlers
      const errors: Error[] = [];
      for (const handler of ctx.eventHandlers) {
        try {
          await handler(event);
        } catch (err) {
          const error =
            err instanceof Error ? err : new Error(String(err));
          errors.push(error);
          log.error("Handler error", { error: error.message });
        }
      }

      if (errors.length > 0) {
        return reply.status(500).send({
          received: true,
          processed: true,
          errors: errors.map((e) => e.message),
        });
      }

      return reply.status(200).send({ received: true, processed: true });
    });

    // ── Vercel deploy webhook ──────────────────────────────────────
    route("post", "/webhooks/vercel", async (request: any, reply: any) => {
      const orgId = (request.query as Record<string, string>).orgId || (request.headers["x-org-id"] as string) || "default";

      // Verify Vercel webhook signature if secret is configured.
      // Prefer org-specific secret from storage, fall back to env var.
      let vercelSecret = process.env.VERCEL_WEBHOOK_SECRET;
      if (ctx.storageProvider && orgId !== "default") {
        try {
          const orgStorage = ctx.getOrgStorage(orgId);
          const vercelConfig = await orgStorage.getChannelConfig("vercel");
          if (vercelConfig?.webhookSecret) {
            vercelSecret = vercelConfig.webhookSecret;
          }
        } catch (err) {
          log.warn("Failed to load org Vercel webhook secret, using global", { orgId, error: String(err) });
        }
      }
      if (vercelSecret) {
        const signature = request.headers["x-vercel-signature"] as string;
        if (!signature) {
          reply.code(401).send({ error: "Missing x-vercel-signature header" });
          return;
        }
        const rawBody = typeof request.body === "string"
          ? request.body
          : JSON.stringify(request.body);
        const expected = createHmac("sha1", vercelSecret).update(rawBody).digest("hex");
        if (signature !== expected) {
          log.warn("Vercel signature mismatch");
          reply.code(401).send({ error: "Invalid signature" });
          return;
        }
      }

      const payload = request.body as Record<string, unknown>;

      // Vercel sends different event types
      // Docs: https://vercel.com/docs/webhooks
      const type = String(payload.type || ""); // "deployment.created", "deployment.succeeded", "deployment.error", "deployment.canceled"
      const innerPayload = (payload.payload as Record<string, unknown>) || payload;

      // Vercel nests deployment data under payload.deployment or directly in payload
      const deployment = (innerPayload.deployment as Record<string, unknown>) || innerPayload;

      const name = String(
        innerPayload.name ||
        deployment.name ||
        (innerPayload.project as Record<string, unknown> | undefined)?.name ||
        (deployment.project as Record<string, unknown> | undefined)?.name ||
        "unknown"
      );
      const url = String(innerPayload.url || deployment.url || "");
      const state = String(deployment.state || deployment.readyState || type.split(".")[1] || "unknown");
      const meta = (deployment.meta || innerPayload.meta) as Record<string, unknown> | undefined;
      const commitMessage = String(meta?.githubCommitMessage || meta?.gitlabCommitMessage || "");
      const branch = String(meta?.githubCommitRef || meta?.gitlabCommitRef || "main");
      const commitSha = String(meta?.githubCommitSha || meta?.gitlabCommitSha || "").slice(0, 7);
      const commitAuthor = String(meta?.githubCommitAuthorName || meta?.gitlabCommitAuthorName || "");
      const prId = String(meta?.githubPrId || "");
      const githubOrg = String(meta?.githubCommitOrg || meta?.githubOrg || "");
      const githubRepo = String(meta?.githubCommitRepo || meta?.githubRepo || "");
      const errorMessage = String(deployment.errorMessage || deployment.buildError || (deployment as any).errorStep || innerPayload.errorMessage || "");
      const inspectorUrl = String(deployment.inspectorUrl || innerPayload.inspectorUrl || "");

      const target = String(innerPayload.target || deployment.target || "");
      const buildingAt = Number(deployment.buildingAt || 0);
      const readyAt = Number(deployment.ready || deployment.readyAt || 0);
      const buildDurationMs = buildingAt && readyAt ? (readyAt - buildingAt) : 0;

      const deploymentId = String(deployment.id || deployment.uid || "");
      log.info("Vercel webhook event", { type, project: name, state, deploymentId });

      // Skip intermediate deploy states
      if (type === "deployment.created" || state === "BUILDING" || state === "INITIALIZING" || state === "QUEUED") {
        return reply.send({ received: true, processed: false, reason: "intermediate_state" });
      }

      // Dedup: two layers — in-memory (fast) + audit log (survives restarts)
      if (!ctx._vercelDedup) ctx._vercelDedup = new Map();
      const dedupKey = `${deploymentId || name}-${state}`;
      const MEMORY_DEDUP_MS = 60 * 60 * 1000; // 1 hour in-memory
      const lastSeen = ctx._vercelDedup.get(dedupKey);
      if (lastSeen && Date.now() - lastSeen < MEMORY_DEDUP_MS) {
        return reply.send({ received: true, processed: false, reason: "duplicate" });
      }

      const vercelStorage = ctx.getOrgStorage(orgId);
      const isError = state === "ERROR" || state === "error";
      const isSuccess = state === "READY" || state === "succeeded";

      // Persistent dedup: check ALL recent audit entries (no time window — Vercel
      // can retry for hours). Match by deploymentId or project+action+commitSha.
      try {
        const { entries: recent } = await vercelStorage.queryAudit("", 200, 0);
        const isDup = recent.some((e) => {
          if (e.actorId !== "vercel") return false;
          const m = e.metadata as Record<string, unknown> | undefined;
          if (deploymentId && m?.["deploymentId"] === deploymentId && e.action === `deploy.${state}`) return true;
          if (m?.["project"] === name && e.action === `deploy.${state}` && commitSha && m?.["commitSha"] === commitSha) return true;
          return false;
        });
        if (isDup) {
          ctx._vercelDedup.set(dedupKey, Date.now());
          return reply.send({ received: true, processed: false, reason: "duplicate_persistent" });
        }
      } catch (err) {
        log.warn("Dedup audit check failed, proceeding", { error: String(err) });
      }

      // Record in memory dedup
      ctx._vercelDedup.set(dedupKey, Date.now());

      await vercelStorage.appendAudit({
        actorType: "system",
        actorId: "vercel",
        action: `deploy.${state}`,
        result: isError ? "error" : isSuccess ? "success" : "pending",
        metadata: {
          project: name,
          url,
          branch,
          commitSha,
          commitAuthor,
          prId,
          inspectorUrl,
          commitMessage: commitMessage.slice(0, 200),
          errorMessage: errorMessage.slice(0, 500),
          risk: isError ? "medium" : "low",
          detail: (() => {
            const parts: string[] = [name];

            if (isSuccess) {
              parts.push("deployed");
              if (branch && branch !== "main") parts.push(branch);
              if (commitMessage) parts.push(`"${commitMessage.slice(0, 60)}"`);
              if (commitSha) parts.push(`(${commitSha})`);
              if (commitAuthor) parts.push(`by ${commitAuthor}`);
              return parts.join(" ");
            }
            if (isError) {
              parts.push("· Build failed");
              if (branch) parts.push(`on ${branch}`);
              if (commitSha) parts.push(`(${commitSha})`);
              if (commitAuthor) parts.push(`by ${commitAuthor}`);
              if (errorMessage) parts.push(`· ${errorMessage.slice(0, 150)}`);
              return parts.join(" ");
            }
            return `${name} deploying ${branch || ""}`.trim();
          })(),
          deploymentId,
          repo: githubOrg && githubRepo ? `${githubOrg}/${githubRepo}` : "",
          source: "vercel",
          target,
          buildDurationMs,
          orgId,
        },
      });

      // Broadcast to SSE clients scoped to org
      broadcastEvent({
        type: "deploy.status",
        data: { project: name, state, url, error: errorMessage || undefined, orgId },
      }, orgId);

      // Publish to event bus for cross-service subscribers
      if (ctx.eventBus) {
        ctx.eventBus.publish("deploy:status", {
          type: "deploy:status",
          projectId: name,
          timestamp: Date.now(),
          payload: { project: name, state, url, error: errorMessage || undefined, source: "vercel", orgId },
        }).catch(() => {});
      }

      // For failures, notify connected channels
      if (state === "ERROR" || state === "error" || type === "deployment.error") {
        if (ctx.alertHandler) {
          await ctx.alertHandler({
            project: name,
            branch,
            commitSha,
            commitMessage,
            commitAuthor,
            errorMessage,
            url,
            repo: githubOrg && githubRepo ? `${githubOrg}/${githubRepo}` : "",
            type: "deploy-failure",
            orgId,
            inspectorUrl,
            deploymentId,
          });
        }
      }

      // For successes, also notify
      if (state === "READY" || state === "succeeded" || type === "deployment.succeeded") {
        if (ctx.alertHandler) {
          await ctx.alertHandler({
            project: name,
            branch,
            commitSha,
            commitMessage,
            commitAuthor,
            errorMessage: "",
            url,
            repo: githubOrg && githubRepo ? `${githubOrg}/${githubRepo}` : "",
            type: "deploy-success",
            orgId,
            inspectorUrl,
            deploymentId,
          });
        }
      }

      reply.send({ received: true, type, state });
    });

    // ── Generic deploy webhook ─────────────────────────────────────
    route("post", "/webhooks/deploy", async (request: any, reply: any) => {
      const orgId = (request.query as Record<string, string>).orgId || (request.headers["x-org-id"] as string) || "default";
      const body = request.body as {
        project?: string;
        status: "success" | "failure" | "pending";
        message?: string;
        url?: string;
        error?: string;
        source?: string;
      };

      const project = body.project || "unknown";
      const status = body.status || "pending";
      const source = body.source || "generic";

      log.info("Deploy webhook event", { project, status, source });

      const deployStorage = ctx.getOrgStorage(orgId);
      await deployStorage.appendAudit({
        actorType: "system",
        actorId: source,
        action: `deploy.${status}`,
        result: status === "failure" ? "error" : status === "success" ? "success" : "pending",
        metadata: {
          project,
          url: body.url,
          error: body.error,
          message: body.message,
          detail:
            status === "success"
              ? `${project}: deployed${body.url ? ` (${body.url})` : ""}`
              : status === "failure"
                ? `${project}: ${body.error || "deploy failed"}`
                : `${project}: deploying${body.message ? ` - ${body.message.slice(0, 60)}` : ""}`,
          source,
          orgId,
        },
      });

      broadcastEvent({ type: "deploy.status", data: { project, status, source, orgId } }, orgId);

      // Publish to event bus for cross-service subscribers
      if (ctx.eventBus) {
        ctx.eventBus.publish("deploy:status", {
          type: "deploy:status",
          projectId: project,
          timestamp: Date.now(),
          payload: { project, status, source, orgId },
        }).catch(() => {});
      }

      if (status === "failure" && ctx.alertHandler) {
        await ctx.alertHandler({
          project,
          branch: "",
          commitSha: "",
          commitMessage: body.message || "",
          commitAuthor: "",
          errorMessage: body.error || "",
          url: body.url || "",
          repo: "",
          type: "deploy-failure",
          orgId,
          inspectorUrl: "",
          deploymentId: "",
        });
      }

      if (status === "success" && ctx.alertHandler) {
        await ctx.alertHandler({
          project,
          branch: "",
          commitSha: "",
          commitMessage: body.message || "",
          commitAuthor: "",
          errorMessage: "",
          url: body.url || "",
          repo: "",
          type: "deploy-success",
          orgId,
          inspectorUrl: "",
          deploymentId: "",
        });
      }

      reply.send({ received: true, status });
    });

    // ── Sentry webhook — receives error/issue events ──────────────
    route("post", "/webhooks/sentry", async (request: any, reply: any) => {
      const orgId = (request.query as Record<string, string>).orgId || (request.headers["x-org-id"] as string) || "default";

      const payload = request.body as Record<string, unknown>;
      const action = String(payload.action || ""); // "created", "resolved", "assigned"
      const data = (payload.data || {}) as Record<string, unknown>;
      const issue = (data.issue || data.event || {}) as Record<string, unknown>;

      const title = String(issue.title || "Unknown error");
      const culprit = String(issue.culprit || "");
      const level = String(issue.level || "error");
      const platform = String(issue.platform || "");
      const firstSeen = String(issue.firstSeen || "");
      const count = Number(issue.count || 1);
      const userCount = Number(issue.userCount || 0);
      const project = ((issue.project || {}) as Record<string, unknown>);
      const projectName = String(project.name || project.slug || "unknown");

      // Extract stack trace if available
      const entries = ((issue.entries || []) as Array<Record<string, unknown>>);
      const exceptionEntry = entries.find(e => e.type === "exception");
      let stackTrace = "";
      if (exceptionEntry) {
        const values = ((exceptionEntry.data as Record<string, unknown>)?.values as Array<Record<string, unknown>>) || [];
        for (const exc of values.slice(0, 1)) {
          const frames = ((exc.stacktrace as Record<string, unknown>)?.frames as Array<Record<string, unknown>>) || [];
          const relevantFrames = frames.filter(f => f.inApp).slice(-5);
          stackTrace = relevantFrames.map(f =>
            `  ${f.filename}:${f.lineNo} in ${f.function}`
          ).join("\n");
        }
      }

      log.info("Sentry webhook received", { action, title, project: projectName, level });

      // Only process new errors
      if (action !== "created" && action !== "triggered") {
        return reply.send({ received: true, processed: false, reason: "action_not_relevant" });
      }

      // Log to audit
      const sentryStorage = ctx.getOrgStorage(orgId);
      await sentryStorage.appendAudit({
        actorType: "system",
        actorId: "sentry",
        action: `error.${level}`,
        result: "error",
        metadata: {
          project: projectName,
          risk: level === "fatal" ? "critical" : level === "error" ? "high" : "medium",
          detail: `${title}${culprit ? ` in ${culprit}` : ""}`,
          errorTitle: title,
          culprit,
          stackTrace,
          platform,
          count,
          userCount,
          firstSeen,
          source: "sentry",
          orgId,
        },
      });

      // Feed into self-healing pipeline via alert handler
      if (ctx.alertHandler && (level === "error" || level === "fatal")) {
        await ctx.alertHandler({
          project: projectName,
          branch: "main",
          commitSha: "",
          commitMessage: "",
          commitAuthor: "",
          errorMessage: `${title}\n${stackTrace}`,
          url: String(issue.permalink || ""),
          repo: "",
          type: "sentry-error",
          orgId,
          inspectorUrl: String(issue.permalink || ""),
          deploymentId: String(issue.id || ""),
        });
      }

      // Broadcast to SSE
      broadcastEvent({
        type: "sentry.error",
        data: { title, culprit, level, project: projectName, count, userCount },
      }, orgId);

      reply.send({ received: true, processed: true });
    });

    // ── Webhook URL generator (org-scoped) ────────────────────────
    route("get", "/api/webhooks/status", async (request: any, reply: any) => {
      const orgId = ctx.getOrgId(request);
      const orgStorage = ctx.getOrgStorage(orgId);

      // Check which services have secrets configured
      const vercelConfig = await orgStorage.getChannelConfig("vercel");
      const githubConfig = await orgStorage.getChannelConfig("github");

      reply.send({
        vercel: { secretConfigured: !!vercelConfig?.webhookSecret },
        github: { secretConfigured: !!githubConfig?.webhookSecret },
      });
    });

    route("get", "/api/webhooks/url", async (request: any, reply: any) => {
      const orgId = (request.headers["x-org-id"] as string) || "default";
      const baseUrl = process.env.WEBHOOK_BASE_URL || "https://codespar-production.up.railway.app";

      reply.send({
        vercel: `${baseUrl}/webhooks/vercel?orgId=${orgId}`,
        github: `${baseUrl}/webhooks/github?orgId=${orgId}`,
        deploy: `${baseUrl}/webhooks/deploy?orgId=${orgId}`,
        sentry: `${baseUrl}/webhooks/sentry?orgId=${orgId}`,
        instructions: {
          vercel: "Add this URL in Vercel > Settings > Webhooks. Select: Deployment Created, Succeeded, Error.",
          github: "Add this URL in GitHub > Repo > Settings > Webhooks. Select: push, pull_request, workflow_run.",
          deploy: "POST to this URL with { project, status, message, error, url, source }.",
          sentry: "Add this URL in Sentry > Settings > Webhooks. Select: issue, error.",
        },
      });
    });

}
