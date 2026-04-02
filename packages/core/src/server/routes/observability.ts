/**
 * Observability routes — metrics, Vercel, Railway, logs, Sentry proxy.
 */

import { createLogger } from "../../observability/logger.js";
import type { RouteFn, ServerContext } from "./types.js";

const log = createLogger("routes/observability");

export function registerObservabilityRoutes(route: RouteFn, ctx: ServerContext): void {
    // ── Observability endpoint ────────────────────────────────────

    route("get", "/api/observability", async (request: any, _reply: any) => {
      const orgId = ctx.getOrgId(request);
      const storage = ctx.getOrgStorage(orgId);
      const period = String(
        (request.query as Record<string, string>).period || "24h"
      );

      // Calculate time window
      const periodMs: Record<string, number> = {
        "1h": 60 * 60 * 1000,
        "24h": 24 * 60 * 60 * 1000,
        "7d": 7 * 24 * 60 * 60 * 1000,
        "30d": 30 * 24 * 60 * 60 * 1000,
      };
      const windowMs = periodMs[period] || periodMs["24h"];
      const since = new Date(Date.now() - windowMs);

      // Query audit entries within the time window
      const { entries: allEntries } = await storage.queryAudit("", 10000, 0);
      const entries = allEntries.filter((e) => e.timestamp >= since);

      // Classify entries by action type
      const apiEntries = entries.filter(
        (e) => String(e.action) === "api.claude"
      );
      const deployEntries = entries.filter((e) =>
        String(e.action).startsWith("deploy.")
      );
      const toolEntries = entries.filter(
        (e) =>
          e.metadata?.latency_ms !== undefined && e.actorType !== "system"
      );
      const healthEntries = entries.filter(
        (e) => String(e.action) === "system.health_snapshot"
      );
      const errorEntries = entries.filter(
        (e) => e.result === "error" || e.result === "failure"
      );

      // ── Summary metrics ──
      const totalLatencies = apiEntries
        .map((e) => Number(e.metadata?.latency_ms || 0))
        .filter(Boolean);
      const avgLatencyMs =
        totalLatencies.length > 0
          ? Math.round(
              totalLatencies.reduce((a, b) => a + b, 0) /
                totalLatencies.length
            )
          : 0;
      const totalCostUsd = apiEntries.reduce(
        (sum, e) => sum + Number(e.metadata?.cost_usd || 0),
        0
      );
      const successfulApi = apiEntries.filter(
        (e) => e.result === "success"
      ).length;
      const successfulTools = toolEntries.filter(
        (e) => e.result === "success"
      ).length;

      const deploySuccess = deployEntries.filter(
        (e) => e.result === "success"
      ).length;
      const deployError = deployEntries.filter(
        (e) => e.result === "error"
      ).length;

      const totalCalls = apiEntries.length + toolEntries.length;

      // ── Tool stats ──
      const toolMap = new Map<
        string,
        {
          calls: number;
          successes: number;
          latencies: number[];
          cost: number;
        }
      >();

      for (const e of toolEntries) {
        const name = String(e.action).split(".")[0] || "unknown";
        const existing = toolMap.get(name) || {
          calls: 0,
          successes: 0,
          latencies: [],
          cost: 0,
        };
        existing.calls++;
        if (e.result === "success") existing.successes++;
        const lat = Number(e.metadata?.latency_ms || 0);
        if (lat > 0) existing.latencies.push(lat);
        existing.cost += Number(e.metadata?.cost_usd || 0);
        toolMap.set(name, existing);
      }

      for (const e of apiEntries) {
        const name = String(e.metadata?.method || "claude-api");
        const existing = toolMap.get(name) || {
          calls: 0,
          successes: 0,
          latencies: [],
          cost: 0,
        };
        existing.calls++;
        if (e.result === "success") existing.successes++;
        const lat = Number(e.metadata?.latency_ms || 0);
        if (lat > 0) existing.latencies.push(lat);
        existing.cost += Number(e.metadata?.cost_usd || 0);
        toolMap.set(name, existing);
      }

      const toolStats = Array.from(toolMap.entries())
        .map(([name, stats]) => {
          const sorted = [...stats.latencies].sort((a, b) => a - b);
          const p95Index = Math.floor(sorted.length * 0.95);
          return {
            name,
            calls: stats.calls,
            successRate:
              stats.calls > 0
                ? Math.round((stats.successes / stats.calls) * 1000) / 10
                : 100,
            avgLatencyMs:
              sorted.length > 0
                ? Math.round(
                    sorted.reduce((a, b) => a + b, 0) / sorted.length
                  )
                : 0,
            p95LatencyMs:
              sorted.length > 0
                ? sorted[p95Index] || sorted[sorted.length - 1]
                : 0,
            costUsd: Math.round(stats.cost * 100) / 100,
            trend: "stable" as const,
          };
        })
        .sort((a, b) => b.calls - a.calls);

      // ── Hallucinations (agent errors) ──
      const hallucinations = errorEntries
        .filter(
          (e) =>
            e.actorType === "agent" || String(e.action).startsWith("api.")
        )
        .slice(0, 20)
        .map((e) => ({
          agentId: e.actorId,
          tool: String(e.action),
          reason: String(
            e.metadata?.detail || e.metadata?.errorMessage || e.result
          ),
          time: e.timestamp.toISOString(),
        }));

      // ── Cost by agent ──
      const costMap = new Map<string, { cost: number; calls: number }>();
      for (const e of [...apiEntries, ...toolEntries]) {
        const agent = String(
          e.metadata?.agentId || e.actorId || "unknown"
        );
        const existing = costMap.get(agent) || { cost: 0, calls: 0 };
        existing.cost += Number(e.metadata?.cost_usd || 0);
        existing.calls++;
        costMap.set(agent, existing);
      }
      const costByAgent = Array.from(costMap.entries())
        .map(([agent, stats]) => ({
          agent,
          costUsd: Math.round(stats.cost * 100) / 100,
          calls: stats.calls,
        }))
        .sort((a, b) => b.costUsd - a.costUsd);

      // ── Deploy events ──
      const deployEvents = deployEntries.slice(0, 20).map((e) => ({
        id: e.id,
        project: String(e.metadata?.project || "unknown"),
        status: (e.result === "success" ? "success" : "error") as
          | "success"
          | "error",
        source: String(e.metadata?.source || "unknown"),
        branch: String(e.metadata?.branch || ""),
        message: String(
          e.metadata?.commitMessage || e.metadata?.detail || ""
        ),
        time: e.timestamp.toISOString(),
        url: String(e.metadata?.url || ""),
        error: String(e.metadata?.errorMessage || ""),
        buildDurationMs:
          Number(e.metadata?.buildDurationMs || 0) || undefined,
        target: String(e.metadata?.target || ""),
      }));

      // ── Health snapshot ──
      const latestHealth =
        healthEntries.length > 0 ? healthEntries[0] : null;
      const health = latestHealth
        ? {
            heapUsedMB: Number(latestHealth.metadata?.heapUsedMB || 0),
            rssMB: Number(latestHealth.metadata?.rssMB || 0),
            uptimeMs: Number(latestHealth.metadata?.uptimeMs || 0),
            activeConnections: ctx.sseConnections.size,
          }
        : {
            heapUsedMB: Math.round(
              process.memoryUsage().heapUsed / 1024 / 1024
            ),
            rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
            uptimeMs: Date.now() - ctx.startedAt.getTime(),
            activeConnections: ctx.sseConnections.size,
          };

      // ── Health trend (last 5 snapshots) ──
      const healthTrend = healthEntries.slice(0, 5).map((e) => ({
        time: e.timestamp.toISOString(),
        heapUsedMB: Number(e.metadata?.heapUsedMB || 0),
        rssMB: Number(e.metadata?.rssMB || 0),
      }));

      // ── Time series for charts ──
      const bucketMs: Record<string, number> = {
        "1h": 5 * 60 * 1000, // 5 min
        "24h": 60 * 60 * 1000, // 1 hour
        "7d": 6 * 60 * 60 * 1000, // 6 hours
        "30d": 24 * 60 * 60 * 1000, // 1 day
      };
      const bucket = bucketMs[period] || bucketMs["24h"];
      const now = Date.now();
      const bucketCount = Math.ceil(windowMs / bucket);
      const timeSeries: Array<{
        time: string;
        deploys: number;
        errors: number;
        apiCalls: number;
        avgLatencyMs: number;
        costUsd: number;
      }> = [];

      for (let i = 0; i < bucketCount; i++) {
        const bucketStart = new Date(now - windowMs + i * bucket);
        const bucketEnd = new Date(bucketStart.getTime() + bucket);

        const bucketEntries = entries.filter(
          (e) => e.timestamp >= bucketStart && e.timestamp < bucketEnd
        );

        const bDeploys = bucketEntries.filter((e) =>
          String(e.action).startsWith("deploy.")
        ).length;
        const bErrors = bucketEntries.filter(
          (e) => e.result === "error"
        ).length;
        const bApiCalls = bucketEntries.filter(
          (e) =>
            String(e.action) === "api.claude" ||
            (e.metadata as Record<string, unknown>)?.latency_ms !== undefined
        ).length;
        const bLatencies = bucketEntries
          .map((e) =>
            Number(
              (e.metadata as Record<string, unknown>)?.latency_ms || 0
            )
          )
          .filter((l) => l > 0);
        const bAvgLatency =
          bLatencies.length > 0
            ? Math.round(
                bLatencies.reduce((a, b) => a + b, 0) / bLatencies.length
              )
            : 0;
        const bCost = bucketEntries.reduce(
          (sum, e) =>
            sum +
            Number((e.metadata as Record<string, unknown>)?.cost_usd || 0),
          0
        );

        timeSeries.push({
          time: bucketStart.toISOString(),
          deploys: bDeploys,
          errors: bErrors,
          apiCalls: bApiCalls,
          avgLatencyMs: bAvgLatency,
          costUsd: Math.round(bCost * 100) / 100,
        });
      }

      // ── Recent logs for live log viewer ──
      const recentLogs = entries.slice(0, 20).map((e) => ({
        time: e.timestamp.toISOString(),
        action: e.action,
        actor: e.actorId,
        actorType: e.actorType,
        result: e.result,
        detail: String(
          (e.metadata as Record<string, unknown>)?.detail || ""
        ),
        latencyMs: Number(
          (e.metadata as Record<string, unknown>)?.latency_ms || 0
        ),
      }));

      // ── Build diagnostics ──
      const buildDiagnostics = {
        totalDeploys: deployEntries.length,
        successRate:
          deployEntries.length > 0
            ? Math.round(
                (deployEntries.filter((e) => e.result === "success").length /
                  deployEntries.length) *
                  100
              )
            : 100,
        avgBuildTimeMs: (() => {
          const durations = deployEntries
            .map((e) =>
              Number(
                (e.metadata as Record<string, unknown>)?.buildDurationMs || 0
              )
            )
            .filter((d) => d > 0);
          return durations.length > 0
            ? Math.round(
                durations.reduce((a, b) => a + b, 0) / durations.length
              )
            : 0;
        })(),
        recentDeploys: deployEntries.slice(0, 10).map((e) => ({
          id: e.id,
          project: String(
            (e.metadata as Record<string, unknown>)?.project || "unknown"
          ),
          status: e.result,
          buildTimeMs: Number(
            (e.metadata as Record<string, unknown>)?.buildDurationMs || 0
          ),
          commitMessage: String(
            (e.metadata as Record<string, unknown>)?.commitMessage || ""
          ).slice(0, 80),
          commitSha: String(
            (e.metadata as Record<string, unknown>)?.commitSha || ""
          ),
          time: e.timestamp.toISOString(),
        })),
      };

      return {
        summary: {
          totalApiCalls: totalCalls,
          avgLatencyMs,
          successRate:
            totalCalls > 0
              ? Math.round(
                  ((successfulApi + successfulTools) / totalCalls) * 1000
                ) / 10
              : 100,
          totalCostUsd: Math.round(totalCostUsd * 100) / 100,
          totalDeploys: deployEntries.length,
          deploySuccessCount: deploySuccess,
          deployErrorCount: deployError,
        },
        toolStats,
        hallucinations,
        costByAgent,
        deployEvents,
        health,
        healthTrend,
        timeSeries,
        recentLogs,
        buildDiagnostics,
      };
    });

    // ── Vercel Analytics proxy ──────────────────────────────
    route("get", "/api/observability/vercel", async (request: any, reply: any) => {
      const orgId = ctx.getOrgId(request);
      const orgStorage = ctx.getOrgStorage(orgId);

      // Try org-specific token first, fall back to global env
      let vercelToken = process.env.VERCEL_API_TOKEN;
      let teamId = process.env.VERCEL_TEAM_ID;
      try {
        const integrationConfig = await orgStorage.getChannelConfig("vercel-api");
        if (integrationConfig?.token) vercelToken = integrationConfig.token;
        if (integrationConfig?.teamId) teamId = integrationConfig.teamId;
      } catch { /* use global fallback */ }

      if (!vercelToken) {
        return reply.send({ error: "VERCEL_API_TOKEN not configured", data: null });
      }

      const period = String((request.query as Record<string, string>).period || "24h");
      const projectId = String((request.query as Record<string, string>).projectId || "");

      // Calculate time range
      const periodMs: Record<string, number> = { "1h": 3600000, "24h": 86400000, "7d": 604800000, "30d": 2592000000 };
      const from = Date.now() - (periodMs[period] || periodMs["24h"]);

      const headers = {
        Authorization: `Bearer ${vercelToken}`,
        "Content-Type": "application/json",
      };
      const teamParam = teamId ? `&teamId=${teamId}` : "";

      try {
        // Fetch multiple Vercel API endpoints in parallel
        const [deploymentsRes, projectsRes] = await Promise.all([
          fetch(`https://api.vercel.com/v6/deployments?limit=50${teamParam}${projectId ? `&projectId=${projectId}` : ""}`, { headers }),
          fetch(`https://api.vercel.com/v9/projects?limit=20${teamParam}`, { headers }),
        ]);

        const deployments = (deploymentsRes.ok ? await deploymentsRes.json() : { deployments: [] }) as Record<string, unknown>;
        const projects = (projectsRes.ok ? await projectsRes.json() : { projects: [] }) as Record<string, unknown>;

        // Process deployments for charts
        const deploys = ((deployments.deployments || []) as Record<string, unknown>[]).map((d: Record<string, unknown>) => ({
          id: d.uid || d.id,
          name: d.name,
          url: d.url,
          state: d.state || d.readyState,
          created: d.created || d.createdAt,
          buildingAt: d.buildingAt,
          ready: d.ready,
          buildDurationMs: d.buildingAt && d.ready ? Number(d.ready) - Number(d.buildingAt) : 0,
          target: d.target,
          meta: d.meta,
          source: d.source,
        }));

        // Process projects
        const projectList = ((projects.projects || []) as Record<string, unknown>[]).map((p: Record<string, unknown>) => ({
          id: p.id,
          name: p.name,
          framework: p.framework,
          updatedAt: p.updatedAt,
          latestDeployments: p.latestDeployments,
        }));

        reply.send({
          deploys,
          projects: projectList,
          totalDeploys: deploys.length,
          successCount: deploys.filter((d: Record<string, unknown>) => d.state === "READY").length,
          errorCount: deploys.filter((d: Record<string, unknown>) => d.state === "ERROR").length,
        });
      } catch (err) {
        log.error("Vercel API proxy error", { error: err instanceof Error ? err.message : String(err) });
        reply.code(500).send({ error: "Failed to fetch Vercel data" });
      }
    });

    // ── Railway Metrics proxy ──────────────────────────────
    route("get", "/api/observability/railway", async (request: any, reply: any) => {
      const orgId = ctx.getOrgId(request);
      const orgStorage = ctx.getOrgStorage(orgId);

      // Try org-specific token first, fall back to global env
      let railwayToken = process.env.RAILWAY_API_TOKEN;
      let railwayProjectId = "";
      try {
        const integrationConfig = await orgStorage.getChannelConfig("railway-api");
        if (integrationConfig?.token) railwayToken = integrationConfig.token;
        if (integrationConfig?.projectId) railwayProjectId = integrationConfig.projectId;
      } catch { /* use global fallback */ }

      if (!railwayToken) {
        return reply.send({ error: "RAILWAY_API_TOKEN not configured", data: null });
      }

      try {
        // Railway uses GraphQL API — filter by projectId if configured
        const query = railwayProjectId
          ? `query { project(id: "${railwayProjectId}") { id name services { edges { node { id name } } } } }`
          : `query { me { projects(first: 3) { edges { node { id name services { edges { node { id name } } } } } } } }`;

        const res = await fetch("https://backboard.railway.app/graphql/v2", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${railwayToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query }),
          signal: AbortSignal.timeout(12_000), // 12s timeout to avoid Railway 503
        });

        if (!res.ok) {
          return reply.send({ error: `Railway API returned ${res.status}`, data: null });
        }

        const data = (await res.json()) as Record<string, unknown>;

        // Also get current health from our own endpoint
        const mem = process.memoryUsage();
        const uptimeMs = Date.now() - ctx.startedAt.getTime();

        reply.send({
          railway: data.data,
          health: {
            heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
            heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
            rssMB: Math.round(mem.rss / 1024 / 1024),
            uptimeMs,
            nodeVersion: process.version,
            activeConnections: ctx.sseConnections.size,
          },
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error("Railway API proxy error", { error: errMsg });

        // Fallback: return health data even if Railway API fails
        const mem = process.memoryUsage();
        const uptimeMs = Date.now() - ctx.startedAt.getTime();
        reply.send({
          railway: null,
          error: errMsg.includes("abort") ? "Railway API timeout — data from local process only" : errMsg,
          health: {
            heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
            heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
            rssMB: Math.round(mem.rss / 1024 / 1024),
            uptimeMs,
            nodeVersion: process.version,
            activeConnections: ctx.sseConnections.size,
          },
        });
      }
    });

    // ── Vercel deployment logs ──────────────────────────────
    route("get", "/api/observability/logs", async (request: any, reply: any) => {
      const logsOrgId = ctx.getOrgId(request);
      const logsOrgStorage = ctx.getOrgStorage(logsOrgId);

      // Always include audit trail logs as primary source
      const allLogs: Array<Record<string, unknown>> = [];

      // 1. Audit trail logs (always available)
      try {
        const { entries } = await logsOrgStorage.queryAudit("", 50, 0);
        for (const e of entries) {
          const meta = (e.metadata || {}) as Record<string, unknown>;
          allLogs.push({
            time: e.timestamp.toISOString(),
            level: e.result === "error" ? "error" : e.result === "pending" ? "warn" : "info",
            source: e.actorType === "system" ? String(meta.source || "system") : e.actorId,
            action: e.action,
            message: String(meta.detail || meta.commitMessage || e.action),
            detail: String(meta.project || meta.agentId || ""),
          });
        }
      } catch { /* no audit data */ }

      // 2. Vercel deployment events (if token configured)
      let vercelToken = process.env.VERCEL_API_TOKEN;
      let teamId = process.env.VERCEL_TEAM_ID;
      try {
        const integrationConfig = await logsOrgStorage.getChannelConfig("vercel-api");
        if (integrationConfig?.token) vercelToken = integrationConfig.token;
        if (integrationConfig?.teamId) teamId = integrationConfig.teamId;
      } catch { /* use global */ }

      if (vercelToken) {
        try {
          const teamParam = teamId ? `&teamId=${teamId}` : "";
          const res = await fetch(
            `https://api.vercel.com/v6/deployments?limit=10${teamParam}`,
            { headers: { Authorization: `Bearer ${vercelToken}` } }
          );
          if (res.ok) {
            const data = await res.json() as Record<string, unknown>;
            const deps = (data.deployments || []) as Array<Record<string, unknown>>;
            for (const d of deps) {
              const meta = (d.meta || {}) as Record<string, unknown>;
              const state = String(d.state || d.readyState || "");
              allLogs.push({
                time: new Date(Number(d.created || 0)).toISOString(),
                level: state === "ERROR" ? "error" : state === "READY" ? "info" : "warn",
                source: "vercel",
                action: `deploy.${state.toLowerCase()}`,
                message: `${d.name} — ${String(meta.githubCommitMessage || "").slice(0, 60)}`,
                detail: String(meta.githubCommitSha || "").slice(0, 7),
              });
            }
          }
        } catch { /* Vercel API unavailable */ }
      }

      // Sort by time (newest first) and limit
      allLogs.sort((a, b) => new Date(String(b.time)).getTime() - new Date(String(a.time)).getTime());

      reply.send({ logs: allLogs.slice(0, 50), source: "combined" });
    });

    // ── Route metrics ──────────────────────────────
    route("get", "/api/observability/routes", async (request: any, reply: any) => {
      const routesOrgId = ctx.getOrgId(request);
      const routesOrgStorage = ctx.getOrgStorage(routesOrgId);

      // Try org-specific token first, fall back to global env
      let vercelToken = process.env.VERCEL_API_TOKEN;
      let teamId = process.env.VERCEL_TEAM_ID;
      try {
        const integrationConfig = await routesOrgStorage.getChannelConfig("vercel-api");
        if (integrationConfig?.token) vercelToken = integrationConfig.token;
        if (integrationConfig?.teamId) teamId = integrationConfig.teamId;
      } catch { /* use global fallback */ }

      if (!vercelToken) {
        return reply.send({ error: "VERCEL_API_TOKEN not configured", routes: [] });
      }

      const projectId = String((request.query as Record<string, string>).projectId || "");
      const teamParam = teamId ? `&teamId=${teamId}` : "";

      try {
        // Vercel doesn't have a direct routes metrics endpoint in public API,
        // but we can infer from deployment checks and serverless functions
        const res = await fetch(
          `https://api.vercel.com/v6/deployments?limit=1&state=READY${teamParam}${projectId ? `&projectId=${projectId}` : ""}`,
          { headers: { Authorization: `Bearer ${vercelToken}` } }
        );

        if (!res.ok) {
          return reply.send({ routes: [], error: `API returned ${res.status}` });
        }

        const data = (await res.json()) as Record<string, unknown>;
        const deploymentsArr = data.deployments as Record<string, unknown>[] | undefined;
        const latestDeploy = deploymentsArr?.[0];

        if (!latestDeploy) {
          return reply.send({ routes: [] });
        }

        // Get deployment details including functions
        const detailRes = await fetch(
          `https://api.vercel.com/v13/deployments/${latestDeploy.uid}${teamId ? `?teamId=${teamId}` : ""}`,
          { headers: { Authorization: `Bearer ${vercelToken}` } }
        );

        const detail = (detailRes.ok ? await detailRes.json() : {}) as Record<string, unknown>;
        const functions = (detail.lambdas || detail.functions || []) as Record<string, unknown>[];

        reply.send({
          deployment: {
            id: latestDeploy.uid,
            url: latestDeploy.url,
            state: latestDeploy.state,
            created: latestDeploy.created,
          },
          routes: functions.map((fn: Record<string, unknown>) => ({
            path: fn.path || fn.entrypoint,
            runtime: fn.runtime,
            region: fn.regions,
            memory: fn.memory,
            maxDuration: fn.maxDuration,
          })),
        });
      } catch (err) {
        log.error("Routes proxy error", { error: err instanceof Error ? err.message : String(err) });
        reply.code(500).send({ error: "Failed to fetch route metrics" });
      }
    });

    // ── Sentry API proxy — fetch recent issues ──────────────────
    route("get", "/api/observability/sentry", async (request: any, reply: any) => {
      const sentryOrgId = ctx.getOrgId(request);
      const sentryOrgStorage = ctx.getOrgStorage(sentryOrgId);

      // Get Sentry config from org storage
      let authToken = "";
      let orgSlug = "";
      let projectSlug = "";
      try {
        const config = await sentryOrgStorage.getChannelConfig("sentry");
        authToken = config?.authToken || config?.token || "";
        orgSlug = config?.org || "";
        projectSlug = config?.project || "";
      } catch { /* no config */ }

      if (!authToken || !orgSlug) {
        return reply.send({ error: "Sentry not configured", issues: [] });
      }

      try {
        const projectFilter = projectSlug ? `&project=${projectSlug}` : "";
        const res = await fetch(
          `https://sentry.io/api/0/organizations/${orgSlug}/issues/?query=is:unresolved&sort=date${projectFilter}&limit=20`,
          { headers: { Authorization: `Bearer ${authToken}` } }
        );

        if (!res.ok) {
          return reply.send({ error: `Sentry API returned ${res.status}`, issues: [] });
        }

        const issues = (await res.json()) as Array<Record<string, unknown>>;

        reply.send({
          issues: issues.map(issue => ({
            id: issue.id,
            title: issue.title,
            culprit: issue.culprit,
            level: issue.level,
            status: issue.status,
            count: issue.count,
            userCount: issue.userCount,
            firstSeen: issue.firstSeen,
            lastSeen: issue.lastSeen,
            permalink: issue.permalink,
            project: (issue.project as Record<string, unknown>)?.name || projectSlug,
            platform: issue.platform,
          })),
          total: issues.length as number,
        });
      } catch (err) {
        log.error("Sentry proxy error", { error: err instanceof Error ? err.message : String(err) });
        reply.send({ error: String(err), issues: [] });
      }
    });

    // ── Incidents (grouped alerts) ─────────────────────────────────

    route("get", "/api/observability/incidents", async (_request: any, _reply: any) => {
      const { incidentGrouper } = await import("../../observability/incident-grouper.js");
      return { incidents: incidentGrouper.getActive() };
    });

    route("post", "/api/observability/incidents/:id/acknowledge", async (request: any, reply: any) => {
      const { id } = request.params;
      const { incidentGrouper } = await import("../../observability/incident-grouper.js");
      const ok = incidentGrouper.acknowledge(id);
      if (!ok) return reply.status(404).send({ error: "Incident not found" });
      return { acknowledged: true };
    });

}
