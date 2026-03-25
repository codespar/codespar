/**
 * OAuth & GitHub routes — Slack/Discord/GitHub OAuth, GitHub tree/file, GitHub status.
 */

import { createLogger } from "../../observability/logger.js";
import { GitHubClient } from "../../github/github-client.js";
import type { RouteFn, ServerContext } from "./types.js";
import type { SlackInstallation } from "../../storage/types.js";

const log = createLogger("routes/oauth-github");

export function registerOAuthGitHubRoutes(route: RouteFn, ctx: ServerContext): void {
    // ── Slack OAuth 2.0 ─────────────────────────────────────────────

    const SLACK_OAUTH_SCOPES = "app_mentions:read,chat:write,channels:read,files:read,users:read";

    // Initiate Slack OAuth flow by redirecting to the Slack authorization page
    route("get", "/api/slack/install", async (request: any, reply: any) => {
      const clientId = process.env.SLACK_CLIENT_ID;
      if (!clientId) {
        return reply.status(500).send({ error: "SLACK_CLIENT_ID is not configured" });
      }

      // Accept orgId from query param (browser redirects can't send custom headers)
      const orgId = (request.query as Record<string, string>)?.orgId || ctx.getOrgId(request);
      const redirectUri = process.env.SLACK_OAUTH_REDIRECT_URI || "";
      const params = new URLSearchParams({
        client_id: clientId,
        scope: SLACK_OAUTH_SCOPES,
        redirect_uri: redirectUri,
        state: orgId, // Pass orgId so callback knows which org to save to
      });

      const authorizeUrl = `https://slack.com/oauth/v2/authorize?${params.toString()}`;
      return reply.redirect(authorizeUrl);
    });

    // Handle OAuth callback from Slack, exchange code for bot token, and save installation
    route("get", "/api/slack/callback", async (request: any, reply: any) => {
      const { code, error: oauthError, state } = request.query as { code?: string; error?: string; state?: string };
      const orgId = state || "default";

      if (oauthError) {
        log.warn("Slack OAuth denied", { error: oauthError });
        return reply.redirect("/?slack=error&reason=denied");
      }

      if (!code) {
        return reply.status(400).send({ error: "Missing authorization code" });
      }

      const clientId = process.env.SLACK_CLIENT_ID;
      const clientSecret = process.env.SLACK_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        return reply.status(500).send({ error: "Slack OAuth credentials are not configured" });
      }

      try {
        const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: process.env.SLACK_OAUTH_REDIRECT_URI || "",
          }),
        });

        const tokenData = await tokenRes.json() as {
          ok: boolean;
          error?: string;
          team?: { id: string; name: string };
          bot_user_id?: string;
          app_id?: string;
          access_token?: string;
          authed_user?: { id: string };
          scope?: string;
        };

        if (!tokenData.ok) {
          log.error("Slack token exchange failed", { error: tokenData.error });
          return reply.redirect("/?slack=error&reason=token_exchange");
        }

        const installation: SlackInstallation = {
          teamId: tokenData.team?.id ?? "",
          teamName: tokenData.team?.name ?? "",
          botToken: tokenData.access_token ?? "",
          botUserId: tokenData.bot_user_id ?? "",
          appId: tokenData.app_id ?? "",
          installedBy: tokenData.authed_user?.id ?? "",
          installedAt: new Date().toISOString(),
          scopes: tokenData.scope?.split(",") ?? [],
          orgId,
        };

        // Save to org-scoped storage so the channels endpoint shows "connected" for this org
        const installStorage = orgId !== "default"
          ? ctx.getOrgStorage(orgId)
          : (ctx.storageProvider ?? ctx.getOrgStorage(orgId));
        await installStorage.saveSlackInstallation(installation);

        // Also save to default storage for the Slack adapter to find the token
        if (orgId !== "default") {
          const defaultStorage = ctx.storageProvider ?? ctx.getOrgStorage(orgId);
          await defaultStorage.saveSlackInstallation(installation);
        }

        log.info("Slack installation saved", { teamId: installation.teamId, teamName: installation.teamName, orgId });
        const dashboardUrl = process.env.DASHBOARD_URL || "https://codespar.dev";
        return reply.redirect(`${dashboardUrl}/dashboard/setup?slack=connected`);
      } catch (err) {
        log.error("Slack OAuth callback error", { error: err instanceof Error ? err.message : String(err) });
        const dashboardUrl = process.env.DASHBOARD_URL || "https://codespar.dev";
        return reply.redirect(`${dashboardUrl}/dashboard/setup?slack=error`);
      }
    });

    // List all Slack installations (admin endpoint)
    route("get", "/api/slack/installations", async (_request: any, _reply: any) => {
      const storage = ctx.storageProvider ?? ctx.getOrgStorage("default");
      const installations = await storage.getAllSlackInstallations();
      return { installations };
    });

    // ── Discord install (multi-tenant bot invite) ─────────────────────
    // Discord bots are inherently multi-tenant: one bot token works across
    // all servers. This endpoint redirects to the Discord authorize URL so
    // users can add the bot to their server.
    route("get", "/api/discord/install", async (_request: any, reply: any) => {
      const clientId = process.env.DISCORD_CLIENT_ID;
      if (!clientId) {
        return reply.status(503).send({ error: "Discord not configured. Set DISCORD_CLIENT_ID." });
      }

      // Permissions bitfield:
      //   Send Messages (2048) + Read Message History (65536)
      //   + Attach Files (32768) + Use Slash Commands (2147483648)
      const permissions = "2147581952";
      const scope = "bot";
      const redirectUrl = `https://discord.com/api/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&permissions=${permissions}&scope=${scope}`;
      return reply.redirect(redirectUrl);
    });

    // ── GitHub OAuth (per-workspace) ──────────────────────────────────

    // Initiate GitHub OAuth flow by redirecting to the authorization page
    route("get", "/api/github/install", async (_request: any, reply: any) => {
      const clientId = process.env.GITHUB_CLIENT_ID;
      if (!clientId) {
        return reply.status(503).send({ error: "GitHub OAuth not configured. Set GITHUB_CLIENT_ID." });
      }

      const redirectUri =
        process.env.GITHUB_OAUTH_REDIRECT_URI ||
        `${process.env.WEBHOOK_BASE_URL || "https://codespar-production.up.railway.app"}/api/github/callback`;
      const scope = "repo,read:user";
      const state = Math.random().toString(36).slice(2, 10);
      const url = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&state=${state}`;
      return reply.redirect(url);
    });

    // Handle OAuth callback from GitHub, exchange code for access token, and save per-org
    route("get", "/api/github/callback", async (request: any, reply: any) => {
      const { code } = request.query as { code?: string };
      if (!code) {
        return reply.status(400).send({ error: "Missing code parameter" });
      }

      const clientId = process.env.GITHUB_CLIENT_ID;
      const clientSecret = process.env.GITHUB_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        return reply.status(503).send({ error: "GitHub OAuth not configured" });
      }

      try {
        const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code,
          }),
        });

        if (!tokenRes.ok) {
          log.error("GitHub token exchange HTTP error", { status: tokenRes.status });
          return reply.status(500).send({ error: "Failed to exchange code for token" });
        }

        const tokenData = (await tokenRes.json()) as {
          access_token?: string;
          token_type?: string;
          scope?: string;
          error?: string;
        };

        if (!tokenData.access_token) {
          log.error("GitHub token exchange failed", { error: tokenData.error });
          return reply.status(400).send({ error: tokenData.error || "No access token received" });
        }

        // Get GitHub user info
        const userRes = await fetch("https://api.github.com/user", {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            Accept: "application/vnd.github.v3+json",
          },
        });
        const userData = (await userRes.json()) as { login?: string; id?: number; name?: string };

        // Save the GitHub installation per org
        const orgId = ctx.getOrgId(request);
        const storage = ctx.getOrgStorage(orgId);

        await storage.setMemory("github-oauth", "token", tokenData.access_token);
        await storage.setMemory("github-oauth", "user", userData.login || "unknown");
        await storage.setMemory("github-oauth", "scope", tokenData.scope || "");
        await storage.setMemory("github-oauth", "connectedAt", new Date().toISOString());

        await storage.appendAudit({
          actorType: "user",
          actorId: userData.login || "unknown",
          action: "github.connected",
          result: "success",
          metadata: {
            orgId,
            githubUser: userData.login,
            scope: tokenData.scope,
          },
        });

        log.info("GitHub OAuth connected", { orgId, user: userData.login });

        const dashboardUrl = process.env.DASHBOARD_URL || "https://codespar.dev";
        return reply.redirect(`${dashboardUrl}/dashboard/setup?github=connected`);
      } catch (err) {
        log.error("GitHub OAuth callback error", { error: err instanceof Error ? err.message : String(err) });
        const dashboardUrl = process.env.DASHBOARD_URL || "https://codespar.dev";
        return reply.redirect(`${dashboardUrl}/dashboard/setup?github=error`);
      }
    });

    // Check if GitHub is connected for the current org
    route("get", "/api/github/status", async (request: any, _reply: any) => {
      const orgId = ctx.getOrgId(request);
      const storage = ctx.getOrgStorage(orgId);

      const token = await storage.getMemory("github-oauth", "token");
      const user = await storage.getMemory("github-oauth", "user");
      const connectedAt = await storage.getMemory("github-oauth", "connectedAt");

      return {
        connected: !!token,
        user: (user as string) || null,
        connectedAt: (connectedAt as string) || null,
      };
    });

    // GitHub file tree (for IDE file explorer)
    route("get", "/api/github/tree", async (request: any, reply: any) => {
      const orgId = ctx.getOrgId(request);
      const storage = ctx.getOrgStorage(orgId);

      // Get linked project's repo
      const projects = await storage.getProjectsList();
      const repo =
        (request.query as Record<string, string>).repo ||
        (projects[0] ? projects[0].repo : "");

      if (!repo) {
        return reply.send({ tree: [], error: "No project linked" });
      }

      const [owner, repoName] = repo.split("/");
      const branch = (request.query as Record<string, string>).branch || "main";
      const token = process.env.GITHUB_TOKEN;

      if (!token) {
        return reply.send({ tree: [], error: "GITHUB_TOKEN not configured" });
      }

      try {
        const res = await fetch(
          `https://api.github.com/repos/${owner}/${repoName}/git/trees/${branch}?recursive=1`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github.v3+json",
            },
          }
        );

        if (!res.ok) {
          return reply.send({ tree: [], error: `GitHub API returned ${res.status}` });
        }

        const data = (await res.json()) as Record<string, unknown>;
        // Filter to max 500 files, exclude node_modules, .git, dist
        const filtered = ((data.tree as Array<Record<string, unknown>>) || [])
          .filter((item: Record<string, unknown>) => {
            const p = String(item.path || "");
            return (
              !p.includes("node_modules") &&
              !p.startsWith(".git/") &&
              !p.includes("/dist/") &&
              !p.includes("/.next/") &&
              !p.includes("/build/")
            );
          })
          .slice(0, 500);

        return reply.send({
          tree: filtered.map((item: Record<string, unknown>) => ({
            path: item.path,
            type: item.type === "tree" ? "folder" : "file",
            size: item.size,
          })),
          repo,
          branch,
        });
      } catch (err) {
        return reply.send({ tree: [], error: String(err) });
      }
    });

    // GitHub file content (for IDE editor)
    route("get", "/api/github/file", async (request: any, reply: any) => {
      const orgId = ctx.getOrgId(request);
      const storage = ctx.getOrgStorage(orgId);

      const filePath = (request.query as Record<string, string>).path;
      const projects = await storage.getProjectsList();
      const repo =
        (request.query as Record<string, string>).repo ||
        (projects[0] ? projects[0].repo : "");

      if (!repo || !filePath) {
        return reply.send({ error: "repo and path required" });
      }

      const [owner, repoName] = repo.split("/");
      const token = process.env.GITHUB_TOKEN;

      if (!token) {
        return reply.send({ error: "GITHUB_TOKEN not configured" });
      }

      try {
        const res = await fetch(
          `https://api.github.com/repos/${owner}/${repoName}/contents/${filePath}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github.v3+json",
            },
          }
        );

        if (!res.ok) {
          return reply.send({ error: `GitHub API returned ${res.status}` });
        }

        const data = (await res.json()) as Record<string, unknown>;

        // Decode base64 content
        const content = data.content
          ? Buffer.from(String(data.content), "base64").toString("utf-8")
          : "";

        // Detect language from extension
        const ext = filePath.split(".").pop()?.toLowerCase() || "";
        const langMap: Record<string, string> = {
          ts: "typescript",
          tsx: "typescript",
          js: "javascript",
          jsx: "javascript",
          py: "python",
          rs: "rust",
          go: "go",
          json: "json",
          md: "markdown",
          css: "css",
          html: "html",
          yaml: "yaml",
          yml: "yaml",
          sh: "shell",
          sql: "sql",
          dockerfile: "dockerfile",
        };

        return reply.send({
          path: filePath,
          content,
          language: langMap[ext] || "plaintext",
          size: data.size as number,
          sha: data.sha as string,
        });
      } catch (err) {
        return reply.send({ error: String(err) });
      }
    });


}
