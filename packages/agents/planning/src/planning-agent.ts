/**
 * Planning Agent - breaks down large features into sub-tasks.
 *
 * When given a complex instruction like "add user authentication with OAuth",
 * the Planning Agent:
 * 1. Analyzes the instruction and codebase context
 * 2. Creates a step-by-step plan with ordered sub-tasks
 * 3. Returns the plan for approval
 * 4. On approval, executes each sub-task sequentially via Task Agent
 */

import type {
  Agent,
  AgentConfig,
  AgentState,
  AgentStatus,
  NormalizedMessage,
  ChannelResponse,
  ParsedIntent,
} from "@codespar/core";

export interface PlanStep {
  id: number;
  instruction: string;
  status: "pending" | "running" | "completed" | "failed";
  output?: string;
  prUrl?: string;
}

export interface Plan {
  id: string;
  instruction: string;
  steps: PlanStep[];
  status: "draft" | "approved" | "executing" | "completed" | "failed";
  createdAt: Date;
}

export class PlanningAgent implements Agent {
  readonly config: AgentConfig;
  private _state: AgentState = "INITIALIZING";
  private plans: Map<string, Plan> = new Map();

  constructor(config: AgentConfig) {
    this.config = { ...config, type: "planning" };
  }

  get state(): AgentState {
    return this._state;
  }

  async initialize(): Promise<void> {
    this._state = "IDLE";
  }

  async handleMessage(
    message: NormalizedMessage,
    intent: ParsedIntent,
  ): Promise<ChannelResponse> {
    this._state = "ACTIVE";

    // Use Claude to break down the instruction into steps
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      this._state = "IDLE";
      return { text: `[${this.config.id}] Planning requires ANTHROPIC_API_KEY.` };
    }

    const instruction = intent.params.instruction || intent.rawText;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.PLANNING_MODEL || "claude-sonnet-4-20250514",
          max_tokens: 2000,
          system: `You are a technical project planner. Given a feature request or large task, break it down into 3-8 sequential, independently executable coding sub-tasks. Each sub-task should be a single, focused instruction that a coding agent can execute (create file, modify function, add test, etc.).

Respond with ONLY a JSON array of strings, each being one sub-task instruction. No explanations, no markdown.

Example:
["Create the User model in src/models/user.ts with id, email, name fields",
"Add the user CRUD routes in src/routes/users.ts",
"Write unit tests for the user model in src/models/__tests__/user.test.ts",
"Update the API documentation in docs/api.md"]`,
          messages: [{ role: "user", content: instruction }],
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) {
        this._state = "IDLE";
        return { text: `[${this.config.id}] Planning failed: API error ${res.status}` };
      }

      const data = (await res.json()) as { content?: Array<{ text?: string }> };
      let content = data.content?.[0]?.text || "[]";
      content = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

      const steps: string[] = JSON.parse(content);

      const planId = `plan-${Date.now()}`;
      const plan: Plan = {
        id: planId,
        instruction,
        steps: steps.map((s, i) => ({
          id: i + 1,
          instruction: s,
          status: "pending" as const,
        })),
        status: "draft",
        createdAt: new Date(),
      };

      this.plans.set(planId, plan);

      const stepList = plan.steps
        .map((s) => `  ${s.id}. ${s.instruction}`)
        .join("\n");

      this._state = "IDLE";
      return {
        text: [
          `[${this.config.id}] Plan created: ${planId}`,
          `  Feature: ${instruction}`,
          `  Steps (${plan.steps.length}):`,
          stepList,
          ``,
          `  To execute: approve plan ${planId}`,
        ].join("\n"),
      };
    } catch (err) {
      this._state = "IDLE";
      return {
        text: `[${this.config.id}] Planning failed: ${err instanceof Error ? err.message : "Unknown error"}`,
      };
    }
  }

  /** Get a plan by ID */
  getPlan(planId: string): Plan | undefined {
    return this.plans.get(planId);
  }

  /** Get all plans */
  getPlans(): Plan[] {
    return Array.from(this.plans.values());
  }

  /** Mark a plan as approved (ready for execution) */
  approvePlan(planId: string): boolean {
    const plan = this.plans.get(planId);
    if (!plan || plan.status !== "draft") return false;
    plan.status = "approved";
    return true;
  }

  getStatus(): AgentStatus {
    return {
      id: this.config.id,
      type: "planning",
      state: this._state,
      autonomyLevel: this.config.autonomyLevel,
      projectId: this.config.projectId,
      orgId: this.config.orgId,
      lastActiveAt: new Date(),
      uptimeMs: 0,
      tasksHandled: this.plans.size,
    };
  }

  async shutdown(): Promise<void> {
    this._state = "TERMINATED";
    this.plans.clear();
  }
}
