/**
 * Approval + Audit routes — vote on approvals, query/clear audit log.
 */

import { createLogger } from "../../observability/logger.js";
import type { RouteFn, ServerContext } from "./types.js";
import type { ChannelType } from "../../types/normalized-message.js";
import { broadcastEvent } from "../webhook-server.js";
import { approvalVoteBody, auditQuery, parseBody, parseQuery } from "./schemas.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const log = createLogger("routes/approval-audit");

export function registerApprovalAuditRoutes(route: RouteFn, ctx: ServerContext): void {
    // ── Approval vote ──
    route("post", "/api/approval/vote",
      async (request: any, reply: any) => {
        const { token, vote, userId } = request.body as {
          token?: string;
          vote?: string;
          userId?: string;
        };

        if (!token || !vote || !userId) {
          return reply.status(400).send({
            error: "token, vote, and userId are required",
          });
        }

        if (!["approve", "deny"].includes(vote)) {
          return reply.status(400).send({
            error: "vote must be 'approve' or 'deny'",
          });
        }

        if (!ctx.approvalManager) {
          return reply.status(500).send({ error: "Approval manager not configured" });
        }

        const result = ctx.approvalManager.vote(
          token,
          userId,
          "dashboard",
          vote as "approve" | "deny"
        );

        if (!result) {
          return reply.status(404).send({
            error: "Token not found, already resolved, or vote rejected",
          });
        }

        if (ctx.storageProvider) {
          await ctx.storageProvider.appendAudit({
            actorType: "user",
            actorId: userId,
            action: "approval.voted",
            result: result.status === "denied" ? "failure" : "success",
            metadata: {
              token,
              vote,
              approvalStatus: result.status,
              votesReceived: result.votesReceived,
              votesRequired: result.votesRequired,
              detail: `Vote '${vote}' via dashboard. Status: ${result.status}`,
            },
          });

          broadcastEvent({
            type: "audit.new",
            data: { action: "approval.voted", vote, status: result.status },
          });
        }

        return { success: true, result };
      }
    );

    // List audit entries (org-scoped via x-org-id header, paginated)
    route("get", "/api/audit",
      async (request: any, _reply: any) => {
        const rawLimit = parseInt(request.query.limit ?? "20", 10);
        const pageSize = Math.min(Math.max(rawLimit, 1), 100);
        const pageNum = Math.max(parseInt(request.query.page ?? "1", 10), 1);
        const riskFilter = request.query.risk ?? "all";
        const orgId = ctx.getOrgId(request);
        const storage = ctx.getOrgStorage(orgId);

        // Fetch all entries then deduplicate deploy events on read.
        // This handles historical duplicates from before persistent dedup was added.
        const { entries: rawEntries } = await storage.queryAudit("", 10000, 0);

        // Deduplicate: for deploy events, keep only the latest per project+action+commitSha
        const seen = new Set<string>();
        const allEntries = rawEntries.filter((e) => {
          if (e.actorId === "vercel" && e.action.startsWith("deploy.")) {
            const m = e.metadata as Record<string, unknown> | undefined;
            const key = `${m?.["project"] || ""}-${e.action}-${m?.["commitSha"] || ""}-${m?.["branch"] || ""}`;
            if (seen.has(key)) return false;
            seen.add(key);
          }
          return true;
        });

        const filtered =
          riskFilter === "all"
            ? allEntries
            : allEntries.filter(
                (e) =>
                  e.metadata?.["risk"] === riskFilter
              );

        const total = filtered.length;
        const totalPages = Math.max(Math.ceil(total / pageSize), 1);
        const offset = (pageNum - 1) * pageSize;
        const page = filtered.slice(offset, offset + pageSize);

        return {
          entries: page.map((e) => {
            // Resolve display name from identity store when available
            let displayName: string | undefined;
            if (ctx.identityStore && e.actorType === "user") {
              const channel = (e.metadata?.["channel"] as ChannelType) ?? "cli";
              displayName = ctx.identityStore.getDisplayName(channel, e.actorId);
              // Only include if it differs from the raw actorId
              if (displayName === e.actorId) displayName = undefined;
            }

            return {
              id: e.id,
              ts: e.timestamp.toISOString(),
              actor: e.actorId,
              actorType: e.actorType,
              displayName,
              action: e.action,
              result: e.result,
              detail: e.metadata?.["detail"] ?? "",
              risk: e.metadata?.["risk"] ?? "low",
              project: e.metadata?.["project"] ?? "unknown",
              hash: e.metadata?.["hash"] ?? "",
              classifiedBy: e.metadata?.["classifiedBy"] ?? undefined,
              confidence: e.metadata?.["confidence"] ?? undefined,
              commitSha: e.metadata?.["commitSha"] ?? "",
              commitAuthor: e.metadata?.["commitAuthor"] ?? "",
              commitMessage: e.metadata?.["commitMessage"] ?? "",
              branch: e.metadata?.["branch"] ?? "",
              errorMessage: e.metadata?.["errorMessage"] ?? "",
              inspectorUrl: e.metadata?.["inspectorUrl"] ?? "",
              prId: e.metadata?.["prId"] ?? "",
              url: e.metadata?.["url"] ?? "",
              repo: e.metadata?.["repo"] ?? "",
              source: e.metadata?.["source"] ?? "",
            };
          }),
          total,
          page: pageNum,
          pageSize,
          totalPages,
          hasMore: pageNum < totalPages,
        };
      }
    );

    // Clear audit log for an org (admin action)
    route("delete", "/api/audit", async (request: any, reply: any) => {
      const orgId = ctx.getOrgId(request);
      const storage = ctx.getOrgStorage(orgId);
      try {
        // Overwrite audit file with empty structure
        const auditPath = path.join(ctx.storageBaseDir, orgId === "default" ? "" : `orgs/${orgId}`, "audit.json");
        await fs.writeFile(auditPath, JSON.stringify({ entries: [] }), "utf-8");
        log.info("Audit log cleared", { orgId });
        reply.send({ success: true, message: "Audit log cleared" });
      } catch (err) {
        log.warn("Failed to clear audit log", { orgId, error: String(err) });
        reply.code(500).send({ error: "Failed to clear audit log" });
      }
    });


}
