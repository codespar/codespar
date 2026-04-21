/**
 * Shared helpers for the 2-level tenancy project layer.
 *
 * Centralized so both storage implementations (pg + file) validate
 * slugs the same way and emit the same error codes the route handler
 * can translate to HTTP status codes. The error shape is identical
 * to what codespar-enterprise's /v1/projects route surfaces so the
 * SDK + dashboard get a consistent contract across runtimes.
 */

import { createHash, randomBytes } from "node:crypto";

/** Valid slug: lowercase alphanumeric + `_` and `-`, 1..64 chars. */
export const SLUG_REGEX = /^[a-z0-9_-]+$/;

/** Slugs that cannot be created or renamed into. "default" is reserved
 *  because every org auto-seeds a project with that slug at create time. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set(["default"]);

/** Project id format: `prj_` + 16 lowercase hex/alnum chars. */
export const PROJECT_ID_RE = /^prj_[a-z0-9]{16}$/;

export type ProjectErrorCode =
  | "slug_conflict"
  | "slug_reserved"
  | "slug_invalid"
  | "name_required"
  | "not_found";

export class ProjectError extends Error {
  constructor(
    public readonly code: ProjectErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ProjectError";
  }
}

/** Validate a slug. Throws ProjectError on invalid / reserved slugs. */
export function validateSlug(slug: string): void {
  if (!slug || slug.length > 64 || !SLUG_REGEX.test(slug)) {
    throw new ProjectError(
      "slug_invalid",
      "slug must be 1-64 chars, lowercase alphanumeric, underscore, or dash",
    );
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new ProjectError("slug_reserved", `slug "${slug}" is reserved`);
  }
}

/** Validate a name. Throws on empty / too long. */
export function validateName(name: string): void {
  if (!name || name.length > 128) {
    throw new ProjectError("name_required", "name must be 1-128 chars");
  }
}

/** Generate a fresh project id: `prj_` + 16 hex chars. Uses crypto-
 *  grade randomness so two concurrent creates don't collide. */
export function newProjectId(): string {
  return "prj_" + randomBytes(8).toString("hex");
}

/** Derive a deterministic project id from an org id. Used for the
 *  default-project backfill so re-running yields the same row. */
export function defaultProjectIdForOrg(orgId: string): string {
  return "prj_" + createHash("sha256").update(orgId).digest("hex").slice(0, 16);
}
