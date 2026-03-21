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
  ): Promise<{ id: number; url: string } | null> {
    // Check if webhook already exists
    const listRes = await fetch(
      `${this.baseUrl}/repos/${owner}/${repo}/hooks`,
      { headers: this.headers },
    );
    if (listRes.ok) {
      const hooks = (await listRes.json()) as any[];
      const existing = hooks.find((h: any) => h.config?.url === webhookUrl);
      if (existing) {
        log.info("Webhook already exists", { owner, repo });
        return { id: existing.id as number, url: existing.config.url as string };
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
    log.info("Webhook created", { owner, repo });
    return { id: data.id as number, url: data.config.url as string };
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
}
