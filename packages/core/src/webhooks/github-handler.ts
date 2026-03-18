/**
 * GitHub Webhook Handler — Parses GitHub webhook payloads into normalized CIEvents.
 *
 * Handles:
 * - workflow_run.completed — CI/CD pipeline results
 * - check_run.completed — individual check results
 * - pull_request.opened/closed/merged — PR lifecycle
 * - push — code pushes with commit info
 */

export type GitHubEventType =
  | "workflow_run"
  | "check_run"
  | "pull_request"
  | "push";

export type CIStatus = "success" | "failure" | "in_progress" | "queued";

export interface CIEvent {
  type: GitHubEventType;
  repo: string;
  branch: string;
  status: CIStatus;
  details: {
    runId?: number;
    conclusion?: string;
    title?: string;
    url?: string;
    sha?: string;
    duration?: number;
    prNumber?: number;
    commitsCount?: number;
  };
  timestamp: Date;
}

/**
 * Map GitHub conclusion strings to our normalized status.
 * GitHub uses: success, failure, neutral, cancelled, skipped, timed_out, action_required, stale
 */
function mapConclusion(conclusion: string | null | undefined): CIStatus {
  switch (conclusion) {
    case "success":
      return "success";
    case "failure":
    case "timed_out":
    case "cancelled":
    case "action_required":
      return "failure";
    case null:
    case undefined:
      return "in_progress";
    default:
      return "failure";
  }
}

/**
 * Extract the branch name from a git ref (e.g., "refs/heads/main" -> "main").
 */
function refToBranch(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

/**
 * Parse a GitHub webhook payload into a normalized CIEvent.
 *
 * @param headers - HTTP headers from the webhook request (lowercase keys)
 * @param body - Parsed JSON body from GitHub
 * @returns CIEvent if the event is recognized and actionable, null otherwise
 */
export function parseGitHubWebhook(
  headers: Record<string, string>,
  body: unknown
): CIEvent | null {
  const eventType = headers["x-github-event"];
  if (!eventType) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = body as any;

  switch (eventType) {
    case "workflow_run":
      return parseWorkflowRun(payload);
    case "check_run":
      return parseCheckRun(payload);
    case "pull_request":
      return parsePullRequest(payload);
    case "push":
      return parsePush(payload);
    default:
      return null;
  }
}

function parseWorkflowRun(payload: any): CIEvent | null {
  const action = payload.action;
  // Only process completed runs and in-progress for status tracking
  if (action !== "completed" && action !== "in_progress" && action !== "requested") {
    return null;
  }

  const run = payload.workflow_run;
  if (!run) return null;

  const status: CIStatus =
    action === "completed"
      ? mapConclusion(run.conclusion)
      : action === "in_progress"
        ? "in_progress"
        : "queued";

  // Calculate duration if timestamps are available
  let duration: number | undefined;
  if (run.run_started_at && run.updated_at) {
    const start = new Date(run.run_started_at).getTime();
    const end = new Date(run.updated_at).getTime();
    if (start > 0 && end > start) {
      duration = Math.round((end - start) / 1000);
    }
  }

  return {
    type: "workflow_run",
    repo: payload.repository?.full_name ?? "unknown",
    branch: run.head_branch ?? "unknown",
    status,
    details: {
      runId: run.id,
      conclusion: run.conclusion ?? undefined,
      title: run.name ?? undefined,
      url: run.html_url ?? undefined,
      sha: run.head_sha ?? undefined,
      duration,
    },
    timestamp: new Date(run.updated_at ?? Date.now()),
  };
}

function parseCheckRun(payload: any): CIEvent | null {
  const action = payload.action;
  if (action !== "completed") return null;

  const check = payload.check_run;
  if (!check) return null;

  // Calculate duration from started_at and completed_at
  let duration: number | undefined;
  if (check.started_at && check.completed_at) {
    const start = new Date(check.started_at).getTime();
    const end = new Date(check.completed_at).getTime();
    if (start > 0 && end > start) {
      duration = Math.round((end - start) / 1000);
    }
  }

  return {
    type: "check_run",
    repo: payload.repository?.full_name ?? "unknown",
    branch: check.check_suite?.head_branch ?? "unknown",
    status: mapConclusion(check.conclusion),
    details: {
      runId: check.id,
      conclusion: check.conclusion ?? undefined,
      title: check.name ?? undefined,
      url: check.html_url ?? undefined,
      sha: check.head_sha ?? undefined,
      duration,
    },
    timestamp: new Date(check.completed_at ?? Date.now()),
  };
}

function parsePullRequest(payload: any): CIEvent | null {
  const action = payload.action;
  if (action !== "opened" && action !== "closed" && action !== "reopened") {
    return null;
  }

  const pr = payload.pull_request;
  if (!pr) return null;

  // Determine status: merged PRs have merged=true when action is "closed"
  let status: CIStatus;
  if (action === "closed" && pr.merged) {
    status = "success";
  } else if (action === "closed") {
    status = "failure"; // closed without merge
  } else {
    status = "in_progress"; // opened or reopened
  }

  return {
    type: "pull_request",
    repo: payload.repository?.full_name ?? "unknown",
    branch: pr.head?.ref ?? "unknown",
    status,
    details: {
      prNumber: pr.number,
      title: pr.title ?? undefined,
      url: pr.html_url ?? undefined,
      sha: pr.head?.sha ?? undefined,
      conclusion: action === "closed" && pr.merged ? "merged" : action,
    },
    timestamp: new Date(pr.updated_at ?? Date.now()),
  };
}

function parsePush(payload: any): CIEvent | null {
  if (!payload.ref) return null;

  const commits = Array.isArray(payload.commits) ? payload.commits : [];

  return {
    type: "push",
    repo: payload.repository?.full_name ?? "unknown",
    branch: refToBranch(payload.ref),
    status: "success",
    details: {
      sha: payload.after ?? undefined,
      url: payload.compare ?? undefined,
      commitsCount: commits.length,
    },
    timestamp: new Date(
      payload.head_commit?.timestamp ?? Date.now()
    ),
  };
}
