/**
 * A2A (Agent-to-Agent) inbound task routes.
 *
 * Accepts task requests from external agents that discovered
 * skills via Agent Cards (Phase 1). Tasks are stored in-memory
 * and can be polled for status updates.
 *
 * Endpoints:
 *   POST   /a2a/tasks        — Submit a new task
 *   GET    /a2a/tasks        — List tasks (with pagination)
 *   GET    /a2a/tasks/:id    — Get task status
 *   POST   /a2a/tasks/:id/cancel — Cancel a task
 */

import { randomUUID } from "node:crypto";
import { getAllAgentMetadata } from "../../agents/agent-registry.js";
import { createLogger } from "../../observability/logger.js";
import { metrics } from "../../observability/metrics.js";
import type { RouteFn, ServerContext } from "./types.js";
import type { A2ATaskRequest, A2ATaskResponse, A2ATaskStatus } from "../../types/a2a.js";
import type { AgentMetadata } from "../../types/agent.js";

const log = createLogger("routes/a2a");

// ── In-memory task store ──────────────────────────────────────────────
const taskStore = new Map<string, A2ATaskResponse>();

/** Exported for testing — clears all tasks from the in-memory store. */
export function clearTaskStore(): void {
  taskStore.clear();
}

/** Exported for testing — returns the task store size. */
export function getTaskStoreSize(): number {
  return taskStore.size;
}

// ── Skill resolution ──────────────────────────────────────────────────

interface SkillMatch {
  agentType: string;
  skillId: string;
  metadata: AgentMetadata;
}

/**
 * Find which agent type handles a given skill ID.
 * Skills are namespaced (e.g., "task.code-execution", "review.pr-analysis").
 */
function resolveSkill(skillId: string): SkillMatch | undefined {
  const allMetadata = getAllAgentMetadata();
  for (const meta of allMetadata) {
    const skill = meta.skills.find((s) => s.id === skillId);
    if (skill) {
      return { agentType: meta.type, skillId: skill.id, metadata: meta };
    }
  }
  return undefined;
}

// ── Route registration ────────────────────────────────────────────────

export function registerA2ARoutes(route: RouteFn, ctx: ServerContext): void {
  // POST /a2a/tasks — Submit a new task
  route("post", "/a2a/tasks", async (request: any, reply: any) => {
    const body = request.body as Partial<A2ATaskRequest> | undefined;

    // Validate required fields
    if (!body || !body.skill || !body.input?.text) {
      return reply.status(400).send({
        error: "Invalid request: 'skill' and 'input.text' are required",
      });
    }

    // Validate skill exists in agent metadata registry
    const match = resolveSkill(body.skill);
    if (!match) {
      const allMetadata = getAllAgentMetadata();
      const availableSkills = allMetadata.flatMap((m) =>
        m.skills.map((s) => s.id)
      );
      return reply.status(400).send({
        error: `Unknown skill '${body.skill}'. Available skills: ${availableSkills.join(", ")}`,
      });
    }

    // Create task entry
    const now = Date.now();
    const taskId = body.id || randomUUID();

    // Reject duplicate IDs
    if (taskStore.has(taskId)) {
      return reply.status(409).send({
        error: `Task '${taskId}' already exists`,
      });
    }

    const task: A2ATaskResponse = {
      id: taskId,
      status: "submitted",
      skill: body.skill,
      agentType: match.agentType,
      createdAt: now,
      updatedAt: now,
    };

    taskStore.set(taskId, task);

    // Transition to "working" — actual agent execution will be wired later
    task.status = "working";
    task.updatedAt = Date.now();

    metrics.increment("a2a.tasks.submitted");
    log.info("A2A task submitted", {
      taskId,
      skill: body.skill,
      agentType: match.agentType,
      callerAgent: body.metadata?.callerAgent,
    });

    return reply.status(201).send({
      id: task.id,
      status: task.status,
      skill: task.skill,
      agentType: task.agentType,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    });
  });

  // GET /a2a/tasks — List all tasks (with pagination, optional project filter)
  route("get", "/a2a/tasks", async (request: any, _reply: any) => {
    const query = request.query as Record<string, string> | undefined;
    const limit = Math.min(Math.max(parseInt(query?.limit ?? "50", 10) || 50, 1), 200);
    const offset = Math.max(parseInt(query?.offset ?? "0", 10) || 0, 0);
    const projectFilter = query?.project ?? "";

    let allTasks = Array.from(taskStore.values());

    // Apply project filter — match against skill prefix or agentType
    if (projectFilter) {
      allTasks = allTasks.filter((t) => {
        const skill = t.skill || "";
        const agentType = t.agentType || "";
        return skill === projectFilter || skill.includes(projectFilter)
          || agentType === projectFilter || agentType.includes(projectFilter);
      });
    }

    // Sort by most recent first
    allTasks.sort((a, b) => b.createdAt - a.createdAt);

    const paged = allTasks.slice(offset, offset + limit);

    return {
      tasks: paged,
      total: allTasks.length,
      limit,
      offset,
    };
  });

  // GET /a2a/tasks/:id — Get task status
  route("get", "/a2a/tasks/:id", async (request: any, reply: any) => {
    const { id } = request.params;
    const task = taskStore.get(id);

    if (!task) {
      return reply.status(404).send({ error: `Task '${id}' not found` });
    }

    return task;
  });

  // POST /a2a/tasks/:id/cancel — Cancel a task
  route("post", "/a2a/tasks/:id/cancel", async (request: any, reply: any) => {
    const { id } = request.params;
    const task = taskStore.get(id);

    if (!task) {
      return reply.status(404).send({ error: `Task '${id}' not found` });
    }

    // Only submitted/working tasks can be cancelled
    if (task.status !== "submitted" && task.status !== "working") {
      return reply.status(400).send({
        error: `Task '${id}' cannot be cancelled (status: ${task.status})`,
      });
    }

    task.status = "cancelled";
    task.updatedAt = Date.now();

    metrics.increment("a2a.tasks.cancelled");
    log.info("A2A task cancelled", { taskId: id });

    return {
      id: task.id,
      status: task.status,
      updatedAt: task.updatedAt,
    };
  });
}
