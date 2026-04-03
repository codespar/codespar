/**
 * Linear API Client — creates, searches, and manages Linear issues via GraphQL.
 *
 * Used by:
 * - Alert handler: auto-create tickets from deploy failures / Sentry errors
 * - Dashboard: list and create issues from the UI
 * - Incident agent: correlate incidents with existing tickets
 */

import { createLogger } from "../observability/logger.js";

const log = createLogger("linear-client");

const LINEAR_API_URL = "https://api.linear.app/graphql";
const DEFAULT_TIMEOUT_MS = 10_000;

// ── Types ────────────────────────────────────────────────────────────────

export interface LinearConfig {
  apiKey: string;
  teamId?: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;   // e.g., "ENG-123"
  title: string;
  description?: string;
  state: { name: string; type: string };
  priority: number;     // 0=none, 1=urgent, 2=high, 3=medium, 4=low
  url: string;
  assignee?: { name: string; email: string };
  createdAt: string;
  labels: Array<{ name: string }>;
}

export interface LinearTeam {
  id: string;
  name: string;
  key: string;  // e.g., "ENG"
}

export class LinearClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly linearMessage?: string,
  ) {
    super(message);
    this.name = "LinearClientError";
  }
}

// ── GraphQL Fragments ───────────────────────────────────────────────────

const ISSUE_FRAGMENT = `
  id
  identifier
  title
  description
  url
  priority
  createdAt
  state { name type }
  assignee { name email }
  labels { nodes { name } }
`;

// ── Client ───────────────────────────────────────────────────────────────

export class LinearClient {
  private apiKey: string;
  private defaultTeamId: string | undefined;
  private timeoutMs: number;

  constructor(config: LinearConfig, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.apiKey = config.apiKey;
    this.defaultTeamId = config.teamId;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Create an issue — primary method for auto-ticket creation from incidents.
   */
  async createIssue(params: {
    title: string;
    description?: string;
    teamId?: string;
    priority?: number;
    labelNames?: string[];
  }): Promise<LinearIssue> {
    const teamId = params.teamId || this.defaultTeamId;
    if (!teamId) {
      throw new LinearClientError("teamId is required (pass it or set default in config)", 0);
    }

    // Resolve label IDs from names if provided
    let labelIds: string[] | undefined;
    if (params.labelNames && params.labelNames.length > 0) {
      labelIds = await this.resolveLabelIds(teamId, params.labelNames);
    }

    const input: Record<string, unknown> = {
      title: params.title,
      teamId,
    };
    if (params.description) input.description = params.description;
    if (params.priority !== undefined) input.priority = params.priority;
    if (labelIds && labelIds.length > 0) input.labelIds = labelIds;

    const query = `
      mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            ${ISSUE_FRAGMENT}
          }
        }
      }
    `;

    const data = await this.graphql<{
      issueCreate: { success: boolean; issue: Record<string, unknown> };
    }>(query, { input });

    if (!data.issueCreate.success) {
      throw new LinearClientError("Linear issueCreate returned success=false", 0);
    }

    return this.mapIssue(data.issueCreate.issue);
  }

  /**
   * Get teams — used for configuration UI (team picker).
   */
  async getTeams(): Promise<LinearTeam[]> {
    const query = `
      query {
        teams {
          nodes { id name key }
        }
      }
    `;

    const data = await this.graphql<{
      teams: { nodes: Array<{ id: string; name: string; key: string }> };
    }>(query);

    return data.teams.nodes.map((t) => ({
      id: t.id,
      name: t.name,
      key: t.key,
    }));
  }

  /**
   * Search issues by text query — used for dedup before creating tickets.
   */
  async searchIssues(query: string, limit = 10): Promise<LinearIssue[]> {
    const gql = `
      query IssueSearch($query: String!, $limit: Int!) {
        issueSearch(query: $query, first: $limit) {
          nodes {
            ${ISSUE_FRAGMENT}
          }
        }
      }
    `;

    const data = await this.graphql<{
      issueSearch: { nodes: Array<Record<string, unknown>> };
    }>(gql, { query, limit });

    return data.issueSearch.nodes.map((n) => this.mapIssue(n));
  }

  /**
   * Update issue state — e.g., move to "In Progress" or "Done".
   */
  async updateIssueState(issueId: string, stateId: string): Promise<boolean> {
    const query = `
      mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
        }
      }
    `;

    try {
      const data = await this.graphql<{
        issueUpdate: { success: boolean };
      }>(query, { id: issueId, input: { stateId } });
      return data.issueUpdate.success;
    } catch (err) {
      log.error("Failed to update Linear issue state", { issueId, stateId, error: String(err) });
      return false;
    }
  }

  /**
   * Get issue by ID or identifier (e.g., "ENG-123").
   */
  async getIssue(idOrIdentifier: string): Promise<LinearIssue | null> {
    // Linear's issueSearch handles both UUID ids and identifiers like "ENG-123"
    const query = `
      query GetIssue($id: String!) {
        issue(id: $id) {
          ${ISSUE_FRAGMENT}
        }
      }
    `;

    try {
      const data = await this.graphql<{
        issue: Record<string, unknown> | null;
      }>(query, { id: idOrIdentifier });

      return data.issue ? this.mapIssue(data.issue) : null;
    } catch {
      // If ID lookup fails, try searching by identifier
      const results = await this.searchIssues(idOrIdentifier, 1);
      return results.length > 0 ? results[0] : null;
    }
  }

  /**
   * List recent issues — optionally filtered by team and/or state name.
   */
  async listIssues(params?: {
    teamId?: string;
    stateName?: string;
    limit?: number;
  }): Promise<LinearIssue[]> {
    const teamId = params?.teamId || this.defaultTeamId;
    const limit = params?.limit || 25;

    // Build filter dynamically
    const filterParts: string[] = [];
    if (teamId) filterParts.push(`team: { id: { eq: "${teamId}" } }`);
    if (params?.stateName) filterParts.push(`state: { name: { eq: "${params.stateName}" } }`);

    const filterClause = filterParts.length > 0
      ? `filter: { ${filterParts.join(", ")} },`
      : "";

    const query = `
      query ListIssues($limit: Int!) {
        issues(${filterClause} first: $limit, orderBy: createdAt) {
          nodes {
            ${ISSUE_FRAGMENT}
          }
        }
      }
    `;

    const data = await this.graphql<{
      issues: { nodes: Array<Record<string, unknown>> };
    }>(query, { limit });

    return data.issues.nodes.map((n) => this.mapIssue(n));
  }

  // ── Internal helpers ─────────────────────────────────────────────────

  /**
   * Resolve label names to IDs — creates labels that don't exist.
   */
  private async resolveLabelIds(teamId: string, names: string[]): Promise<string[]> {
    const query = `
      query TeamLabels($teamId: String!) {
        team(id: $teamId) {
          labels { nodes { id name } }
        }
      }
    `;

    try {
      const data = await this.graphql<{
        team: { labels: { nodes: Array<{ id: string; name: string }> } };
      }>(query, { teamId });

      const existing = data.team.labels.nodes;
      const ids: string[] = [];

      for (const name of names) {
        const match = existing.find(
          (l) => l.name.toLowerCase() === name.toLowerCase(),
        );
        if (match) {
          ids.push(match.id);
        } else {
          // Create the label
          const created = await this.createLabel(teamId, name);
          if (created) ids.push(created);
        }
      }

      return ids;
    } catch (err) {
      log.warn("Failed to resolve label IDs, creating issue without labels", {
        teamId,
        names,
        error: String(err),
      });
      return [];
    }
  }

  private async createLabel(teamId: string, name: string): Promise<string | null> {
    const query = `
      mutation CreateLabel($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel { id }
        }
      }
    `;

    try {
      const data = await this.graphql<{
        issueLabelCreate: { success: boolean; issueLabel: { id: string } };
      }>(query, { input: { name, teamId } });

      return data.issueLabelCreate.success ? data.issueLabelCreate.issueLabel.id : null;
    } catch (err) {
      log.warn("Failed to create Linear label", { name, teamId, error: String(err) });
      return null;
    }
  }

  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(LINEAR_API_URL, {
        method: "POST",
        headers: {
          Authorization: this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new LinearClientError("Linear API request timed out", 0, "timeout");
      }
      throw new LinearClientError(`Linear API request failed: ${String(err)}`, 0);
    }

    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.text();
        detail = body.slice(0, 200);
      } catch { /* ignore */ }
      throw new LinearClientError(
        `Linear API returned ${res.status}: ${detail}`,
        res.status,
        detail,
      );
    }

    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };

    if (json.errors && json.errors.length > 0) {
      const messages = json.errors.map((e) => e.message).join("; ");
      throw new LinearClientError(`Linear GraphQL error: ${messages}`, 0, messages);
    }

    if (!json.data) {
      throw new LinearClientError("Linear API returned empty data", 0);
    }

    return json.data;
  }

  private mapIssue(raw: Record<string, unknown>): LinearIssue {
    const state = (raw.state as Record<string, unknown>) || {};
    const assignee = raw.assignee as Record<string, unknown> | undefined;
    const labelsNode = (raw.labels as Record<string, unknown>) || {};
    const labelNodes = (labelsNode.nodes as Array<{ name: string }>) || [];

    return {
      id: String(raw.id || ""),
      identifier: String(raw.identifier || ""),
      title: String(raw.title || ""),
      description: raw.description ? String(raw.description) : undefined,
      state: {
        name: String(state.name || ""),
        type: String(state.type || ""),
      },
      priority: Number(raw.priority || 0),
      url: String(raw.url || ""),
      assignee: assignee
        ? { name: String(assignee.name || ""), email: String(assignee.email || "") }
        : undefined,
      createdAt: String(raw.createdAt || ""),
      labels: labelNodes.map((l) => ({ name: l.name })),
    };
  }
}
