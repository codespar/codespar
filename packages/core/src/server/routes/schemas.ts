/**
 * Zod schemas for HTTP request validation.
 *
 * Used in route handlers to replace `any` types with validated, typed inputs.
 * Each schema covers a specific endpoint's request body or query params.
 */

import { z } from "zod";

// ── Common ────────────────────────────────────────────────────

export const orgIdHeader = z.object({
  "x-org-id": z.string().optional(),
}).passthrough();

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(20),
  page: z.coerce.number().int().min(1).default(1),
});

// ── Chat ──────────────────────────────────────────────────────

export const chatMessageBody = z.object({
  text: z.string().min(1).max(10_000),
  agentId: z.string().optional(),
  imageUrls: z.array(z.object({
    url: z.string().url(),
    mimeType: z.string().optional(),
  })).optional(),
});

// ── Agents ────────────────────────────────────────────────────

export const createAgentBody = z.object({
  name: z.string().min(1).max(100),
  type: z.string().min(1),
  projectId: z.string().optional(),
  autonomyLevel: z.number().int().min(0).max(5).optional(),
  description: z.string().max(500).optional(),
});

export const agentActionBody = z.object({
  action: z.enum(["suspend", "resume", "restart", "set_autonomy"]),
  autonomyLevel: z.number().int().min(0).max(5).optional(),
});

// ── Projects ──────────────────────────────────────────────────

export const linkProjectBody = z.object({
  agentId: z.string().min(1),
  repo: z.string().min(1), // "owner/repo" format
});

export const createProjectBody = z.object({
  repo: z.string().min(1),
  agentId: z.string().optional(),
});

// ── Channels ──────────────────────────────────────────────────

export const configureChannelBody = z.object({
  channel: z.string().min(1),
  config: z.record(z.string()),
});

// ── Approval ──────────────────────────────────────────────────

export const approvalVoteBody = z.object({
  token: z.string().min(1),
  vote: z.enum(["approve", "deny"]),
  userId: z.string().min(1),
  channelType: z.string().optional(),
});

// ── Audit ─────────────────────────────────────────────────────

export const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(20),
  page: z.coerce.number().int().min(1).default(1),
  risk: z.string().default("all"),
  agentId: z.string().optional(),
  type: z.string().optional(),
});

// ── Integrations ──────────────────────────────────────────────

export const configureIntegrationBody = z.object({
  integration: z.string().min(1),
  config: z.record(z.string()),
});

// ── Orgs ──────────────────────────────────────────────────────

export const createOrgBody = z.object({
  name: z.string().min(1).max(100),
  clerkOrgId: z.string().optional(),
});

// ── Newsletter ────────────────────────────────────────────────

export const subscribeBody = z.object({
  email: z.string().email(),
  source: z.string().default("homepage"),
});

export const unsubscribeBody = z.object({
  email: z.string().email(),
});

// ── Observability ─────────────────────────────────────────────

export const observabilityQuery = z.object({
  period: z.enum(["1h", "6h", "12h", "24h", "7d", "30d"]).default("24h"),
});

// ── Helper ────────────────────────────────────────────────────

/** Parse and validate a request body, returning typed result or null on failure */
export function parseBody<T>(schema: z.ZodSchema<T>, body: unknown): { data: T; error: null } | { data: null; error: string } {
  const result = schema.safeParse(body);
  if (result.success) return { data: result.data, error: null };
  const message = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
  return { data: null, error: message };
}

/** Parse and validate query params */
export function parseQuery<T>(schema: z.ZodSchema<T>, query: unknown): { data: T; error: null } | { data: null; error: string } {
  const result = schema.safeParse(query);
  if (result.success) return { data: result.data, error: null };
  const message = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
  return { data: null, error: message };
}
