/**
 * Projects routes — CRUD for the environment-level `projects` table.
 *
 * Mirrors the contract codespar-enterprise's /v1/projects serves so the
 * SDK + dashboard work against opensource and enterprise interchangeably.
 *
 * Scoping:
 *   - Every route reads the caller's org from `x-org-id` (existing
 *     opensource pattern; see ctx.getOrgId).
 *   - GET /:id returns 404 (not 403) when the project belongs to a
 *     different org, so cross-tenant existence can't be probed.
 *   - At most one default project per org at any committed state,
 *     enforced by the partial unique index + the atomic promotion
 *     transaction in storage.updateProject.
 *
 * Typed errors surface from storage as ProjectError instances and get
 * translated to 4xx responses with the same `error` codes as enterprise:
 *   - slug_conflict           → 400
 *   - slug_reserved           → 400
 *   - slug_invalid            → 400
 *   - name_required           → 400
 *   - cannot_delete_default   → 409
 *   - cannot_delete_last_project → 409
 */

import type { RouteFn, ServerContext } from "./types.js";
import { ProjectError } from "../../storage/project-helpers.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("routes/projects");

function apiError(reply: {
  code: (n: number) => { send: (body: unknown) => unknown };
}, status: number, code: string, message?: string, details?: Record<string, unknown>) {
  return reply.code(status).send({ error: code, ...(message ? { message } : {}), ...(details ?? {}) });
}

function handleProjectError(reply: {
  code: (n: number) => { send: (body: unknown) => unknown };
}, err: unknown): unknown {
  if (err instanceof ProjectError) {
    return apiError(reply, 400, err.code, err.message);
  }
  log.error("unexpected error in /projects handler", {
    error: err instanceof Error ? err.message : String(err),
  });
  return apiError(reply, 500, "internal_error");
}

export function registerProjectRoutes(route: RouteFn, ctx: ServerContext): void {
  // POST /api/projects — create a project in the caller's org.
  route("post", "/api/projects-env", async (request: any, reply: any) => {
    const orgId = ctx.getOrgId(request);
    const storage = ctx.getOrgStorage(orgId);
    const body = (request.body ?? {}) as { name?: string; slug?: string; is_default?: boolean };
    if (typeof body.name !== "string" || typeof body.slug !== "string") {
      return apiError(reply, 400, "invalid_body", "name and slug required");
    }
    try {
      const project = await storage.createProject({
        orgId,
        name: body.name,
        slug: body.slug,
        isDefault: body.is_default === true,
      });
      reply.code(201);
      return project;
    } catch (err) {
      return handleProjectError(reply, err);
    }
  });

  // GET /api/projects — list projects in the caller's org.
  route("get", "/api/projects-env", async (request: any) => {
    const orgId = ctx.getOrgId(request);
    const storage = ctx.getOrgStorage(orgId);
    // Self-heal default project on first read so a fresh org never
    // gets an empty list — mirrors enterprise auth's behaviour.
    await storage.getOrCreateDefaultProject(orgId);
    const projects = await storage.listProjects(orgId);
    return { projects };
  });

  // GET /api/projects/:id
  route("get", "/api/projects-env/:id", async (request: any, reply: any) => {
    const orgId = ctx.getOrgId(request);
    const storage = ctx.getOrgStorage(orgId);
    const project = await storage.getProject(orgId, request.params.id);
    if (!project) return apiError(reply, 404, "not_found");
    return project;
  });

  // PATCH /api/projects/:id — update name / slug / promote to default.
  route("patch", "/api/projects-env/:id", async (request: any, reply: any) => {
    const orgId = ctx.getOrgId(request);
    const storage = ctx.getOrgStorage(orgId);
    const body = (request.body ?? {}) as {
      name?: string;
      slug?: string;
      is_default?: boolean;
    };
    if (
      body.name === undefined &&
      body.slug === undefined &&
      body.is_default === undefined
    ) {
      return apiError(reply, 400, "invalid_body", "empty patch");
    }
    // Only accept `true` for is_default — un-defaulting directly would
    // leave the org with zero defaults, violating the invariant.
    if (body.is_default !== undefined && body.is_default !== true) {
      return apiError(reply, 400, "invalid_body", "is_default may only be set to true");
    }
    try {
      const updated = await storage.updateProject(orgId, request.params.id, {
        name: body.name,
        slug: body.slug,
        isDefault: body.is_default,
      });
      if (!updated) return apiError(reply, 404, "not_found");
      return updated;
    } catch (err) {
      return handleProjectError(reply, err);
    }
  });

  // DELETE /api/projects/:id — hard delete with two refusals.
  route("delete", "/api/projects-env/:id", async (request: any, reply: any) => {
    const orgId = ctx.getOrgId(request);
    const storage = ctx.getOrgStorage(orgId);
    const existing = await storage.getProject(orgId, request.params.id);
    if (!existing) return apiError(reply, 404, "not_found");

    if (existing.isDefault) {
      return apiError(
        reply,
        409,
        "cannot_delete_default",
        "promote another project to default before deleting this one",
        { project_id: existing.id },
      );
    }
    const all = await storage.listProjects(orgId);
    if (all.length <= 1) {
      return apiError(
        reply,
        409,
        "cannot_delete_last_project",
        "organization must keep at least one project",
        { project_id: existing.id },
      );
    }
    await storage.deleteProject(orgId, request.params.id);
    reply.code(204);
    return null;
  });
}
