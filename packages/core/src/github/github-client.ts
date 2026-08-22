/**
 * GitHub Client — Read and write code via GitHub REST API.
 * Requires GITHUB_TOKEN env var.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { createLogger } from "../observability/logger.js";

const log = createLogger("github");

export class GitHubClient {
  private token: string;
  private baseUrl = "https://api.github.com";

  constructor(token?: string) {
    this.token = token || process.env.GITHUB_TOKEN || "";
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    };
  }

  /** Check if client is configured with a valid token. */
  isConfigured(): boolean {
    return !!this.token;
  }

  /** Get repo file tree (first level at given path). */
  async getFileTree(
    owner: string,
    repo: string,
    path = "",
    ref = "main",
  ): Promise<Array<{ path: string; type: string; size: number }>> {
    const url = `${this.baseUrl}/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) return [];
    const data = (await res.json()) as any[];
    if (!Array.isArray(data)) return [];
    return data.map((f: any) => ({
      path: f.path as string,
      type: f.type as string,
      size: (f.size as number) || 0,
    }));
  }

  /** Read a file's content (base64-decoded). */
  async readFile(
    owner: string,
    repo: string,
    path: string,
    ref = "main",
  ): Promise<{ content: string; sha: string } | null> {
    const url = `${this.baseUrl}/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    if (!data.content) return null;
    const content = Buffer.from(data.content as string, "base64").toString("utf-8");
    return { content, sha: data.sha as string };
  }

  /** Find files matching a search query in the repo. */
  async searchCode(
    owner: string,
    repo: string,
    query: string,
  ): Promise<Array<{ path: string; score: number }>> {
    const url = `${this.baseUrl}/search/code?q=${encodeURIComponent(query)}+repo:${owner}/${repo}`;
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    return ((data.items as any[]) || []).slice(0, 10).map((item: any) => ({
      path: item.path as string,
      score: (item.score as number) || 0,
    }));
  }

  /** Create a branch from an existing base branch. */
  async createBranch(
    owner: string,
    repo: string,
    branch: string,
    baseBranch = "main",
  ): Promise<boolean> {
    // Get base branch SHA
    const refRes = await fetch(
      `${this.baseUrl}/repos/${owner}/${repo}/git/refs/heads/${baseBranch}`,
      { headers: this.headers },
    );
    if (!refRes.ok) return false;
    const refData = (await refRes.json()) as any;
    const sha = refData.object.sha as string;

    // Create new branch
    const createRes = await fetch(
      `${this.baseUrl}/repos/${owner}/${repo}/git/refs`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
      },
    );
    return createRes.ok || createRes.status === 422; // 422 = already exists
  }

  /** Update or create a file on a branch. */
  async updateFile(
    owner: string,
    repo: string,
    path: string,
    content: string,
    message: string,
    branch: string,
    sha?: string,
  ): Promise<boolean> {
    const body: Record<string, unknown> = {
      message,
      content: Buffer.from(content).toString("base64"),
      branch,
    };
    if (sha) body.sha = sha;

    const res = await fetch(
      `${this.baseUrl}/repos/${owner}/${repo}/contents/${path}`,
      {
        method: "PUT",
        headers: this.headers,
        body: JSON.stringify(body),
      },
    );
    return res.ok;
  }

  /** Create a pull request. */
  async createPR(
    owner: string,
    repo: string,
    title: string,
    body: string,
    head: string,
    base = "main",
  ): Promise<{ number: number; url: string } | null> {
    const res = await fetch(
      `${this.baseUrl}/repos/${owner}/${repo}/pulls`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ title, body, head, base }),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    return { number: data.number as number, url: data.html_url as string };
  }

  /** Create a webhook on a repo. Idempotent — returns existing hook if already configured. */
  async createWebhook(
    owner: string,
    repo: string,
    webhookUrl: string,
    events: string[] = ["workflow_run", "pull_request", "push"],
    secret?: string,
  ): Promise<{ id: number; url: string; secretConfigured: boolean } | null> {
    // Last line of defence before writing a delivery target into someone
    // else's repo: the URL must parse as absolute http(s). Kept local (rather
    // than importing the server's base-url helper) so it also covers callers
    // outside this package, e.g. the project agent's chat "link" command.
    let parsedWebhookUrl: URL;
    try {
      parsedWebhookUrl = new URL(webhookUrl);
    } catch {
      log.error("Refusing to create webhook: target is not a valid URL", { owner, repo });
      return null;
    }
    if (parsedWebhookUrl.protocol !== "http:" && parsedWebhookUrl.protocol !== "https:") {
      log.error("Refusing to create webhook: target is not http(s)", { owner, repo });
      return null;
    }

    // Check if webhook already exists
    const listRes = await fetch(
      `${this.baseUrl}/repos/${owner}/${repo}/hooks`,
      { headers: this.headers },
    );
    if (listRes.ok) {
      const hooks = (await listRes.json()) as any[];
      const existing = hooks.find((h: any) => h.config?.url === webhookUrl);
      if (existing) {
        // Reconcile rather than just report. A hook created by an earlier
        // release carries no secret, so GitHub sends it unsigned forever and
        // the operator has no way to fix that from here. Setting the secret on
        // the existing hook is what migrates those installs without anyone
        // re-registering anything by hand.
        //
        // GitHub masks `config.secret` in list responses, so it cannot be
        // compared to what we hold. The secret is therefore written whenever
        // we have one, which is idempotent from GitHub's side and converges on
        // the value this runtime can actually verify against.
        let secretConfigured = false;
        if (secret) {
          secretConfigured = await this.setWebhookSecret(
            owner,
            repo,
            existing.id as number,
            webhookUrl,
            secret,
          );
          if (!secretConfigured) {
            log.warn(
              "Webhook exists but its signing secret could not be set, so its " +
                "deliveries stay unverifiable",
              { owner, repo },
            );
          }
        }
        // `secretConfigured` is reported rather than folded into a null return:
        // the hook does exist, and a caller that only wanted it to exist is
        // right to treat that as success. The caller that cares whether
        // deliveries can be verified must not record success on this path, or
        // it would mark the repair done and never retry it.
        log.info("Webhook already exists", { owner, repo, secretConfigured });
        return { id: existing.id as number, url: existing.config.url as string, secretConfigured };
      }
    }

    // Create new webhook
    const res = await fetch(
      `${this.baseUrl}/repos/${owner}/${repo}/hooks`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          name: "web",
          active: true,
          events,
          config: {
            url: webhookUrl,
            content_type: "json",
            insecure_ssl: "0",
            // Without this, GitHub signs nothing and every delivery arrives
            // unverifiable. That was the state of every hook this runtime
            // created, and the reason WEBHOOK_STRICT_MODE could not be turned
            // on: it would have rejected the runtime's own integration.
            ...(secret ? { secret } : {}),
          },
        }),
      },
    );

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      log.error("Failed to create webhook", { owner, repo, status: res.status, response: errBody.slice(0, 200) });
      return null;
    }

    const data = (await res.json()) as any;
    log.info("Webhook created", { owner, repo, secretConfigured: Boolean(secret) });
    return {
      id: data.id as number,
      url: data.config.url as string,
      secretConfigured: Boolean(secret),
    };
  }

  /**
   * Set (or replace) the signing secret on an existing webhook.
   *
   * Separate from createWebhook so the reconciliation path is testable on its
   * own and so a caller that already knows the hook id does not have to list.
   * Returns false rather than throwing: a runtime that cannot reach GitHub
   * must still start.
   */
  async setWebhookSecret(
    owner: string,
    repo: string,
    hookId: number,
    webhookUrl: string,
    secret: string,
  ): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/repos/${owner}/${repo}/hooks/${hookId}`, {
        method: "PATCH",
        headers: this.headers,
        // GitHub REPLACES the whole `config` object on PATCH rather than
        // merging it, so `url` and `content_type` are resent alongside the
        // secret. Sending `config: { secret }` alone would blank the delivery
        // URL and silently detach the hook, which is a worse outcome than the
        // unsigned deliveries this is fixing.
        body: JSON.stringify({
          config: {
            url: webhookUrl,
            content_type: "json",
            insecure_ssl: "0",
            secret,
          },
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        log.warn("Could not set the webhook signing secret", {
          owner,
          repo,
          status: res.status,
          response: body.slice(0, 200),
        });
      }
      return res.ok;
    } catch (err) {
      log.warn("Failed to set the webhook signing secret", {
        owner,
        repo,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** Get PR details. */
  async getPR(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<{
    title: string;
    body: string;
    author: string;
    branch: string;
    baseBranch: string;
    state: string;
    url: string;
    changedFiles: number;
    additions: number;
    deletions: number;
  } | null> {
    const res = await fetch(
      `${this.baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}`,
      { headers: this.headers },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    return {
      title: data.title as string,
      body: (data.body as string) || "",
      author: (data.user?.login as string) || "unknown",
      branch: (data.head?.ref as string) || "unknown",
      baseBranch: (data.base?.ref as string) || "main",
      state: data.state as string,
      url: data.html_url as string,
      changedFiles: (data.changed_files as number) || 0,
      additions: (data.additions as number) || 0,
      deletions: (data.deletions as number) || 0,
    };
  }

  /** Get PR diff/files. */
  async getPRFiles(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<
    Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch: string;
    }>
  > {
    const res = await fetch(
      `${this.baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}/files`,
      { headers: this.headers },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as any[];
    if (!Array.isArray(data)) return [];
    return data.map((f: any) => ({
      filename: f.filename as string,
      status: (f.status as string) || "modified",
      additions: (f.additions as number) || 0,
      deletions: (f.deletions as number) || 0,
      patch: (f.patch as string) || "",
    }));
  }

  /** List open pull requests for a repo. */
  async listPRs(
    owner: string,
    repo: string,
    state: "open" | "closed" | "all" = "open",
    limit = 10,
  ): Promise<
    Array<{
      number: number;
      title: string;
      author: string;
      branch: string;
      url: string;
      createdAt: string;
      updatedAt: string;
      labels: string[];
    }>
  > {
    const res = await fetch(
      `${this.baseUrl}/repos/${owner}/${repo}/pulls?state=${state}&per_page=${limit}&sort=updated&direction=desc`,
      { headers: this.headers },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as any[];
    if (!Array.isArray(data)) return [];
    return data.map((pr: any) => ({
      number: pr.number as number,
      title: pr.title as string,
      author: (pr.user?.login as string) || "unknown",
      branch: (pr.head?.ref as string) || "unknown",
      url: pr.html_url as string,
      createdAt: pr.created_at as string,
      updatedAt: pr.updated_at as string,
      labels: ((pr.labels as any[]) || []).map((l: any) => l.name as string),
    }));
  }

  /** Merge a pull request. */
  async mergePR(
    owner: string,
    repo: string,
    prNumber: number,
    mergeMethod: "merge" | "squash" | "rebase" = "merge",
  ): Promise<{ merged: boolean; message: string } | null> {
    const res = await fetch(
      `${this.baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}/merge`,
      {
        method: "PUT",
        headers: this.headers,
        body: JSON.stringify({ merge_method: mergeMethod }),
      },
    );
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      return { merged: false, message: `Failed: ${res.status} ${err.slice(0, 100)}` };
    }
    const data = (await res.json()) as any;
    return { merged: data.merged as boolean, message: (data.message as string) || "Merged" };
  }

  /** Get the default branch name for a repo. */
  async getDefaultBranch(owner: string, repo: string): Promise<string> {
    const res = await fetch(
      `${this.baseUrl}/repos/${owner}/${repo}`,
      { headers: this.headers },
    );
    if (!res.ok) return "main";
    const data = (await res.json()) as any;
    return (data.default_branch as string) || "main";
  }

  /** Get recent commits from a repo (default branch). */
  async getRecentCommits(
    owner: string,
    repo: string,
    count: number = 15,
  ): Promise<Array<{
    sha: string;
    message: string;
    author: string;
    date: string;
    files?: string[];
  }>> {
    try {
      const res = await fetch(
        `${this.baseUrl}/repos/${owner}/${repo}/commits?per_page=${count}`,
        { headers: this.headers, signal: AbortSignal.timeout(10_000) },
      );
      if (!res.ok) return [];
      const data = (await res.json()) as any[];
      return data.map((c: any) => ({
        sha: c.sha?.slice(0, 7) || "",
        message: c.commit?.message?.split("\n")[0] || "",
        author: c.commit?.author?.name || c.author?.login || "",
        date: c.commit?.author?.date || "",
        files: c.files?.map((f: any) => f.filename) as string[] | undefined,
      }));
    } catch (err) {
      log.error("Failed to fetch commits", { error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }
}
