/**
 * Factory function for creating the appropriate StorageProvider.
 *
 * - If DATABASE_URL is set → PgStorage (PostgreSQL via Drizzle ORM)
 * - Otherwise → FileStorage (JSON files, MVP default)
 *
 * Usage:
 *   const storage = createStorage();
 *   const orgStorage = createStorage("org_abc123");
 */

import type { StorageProvider } from "./types.js";
import { FileStorage } from "./file-storage.js";
import { PgStorage } from "./pg-storage.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("storage-factory");

export function createStorage(orgId?: string): StorageProvider {
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl) {
    log.info("Using PostgreSQL storage", { orgId: orgId ?? "default" });
    return new PgStorage(databaseUrl, orgId);
  }

  log.info("Using FileStorage (no DATABASE_URL set)", { orgId: orgId ?? "default" });
  const baseDir = process.env.CODESPAR_STORAGE_DIR || ".codespar";
  return new FileStorage(baseDir, orgId);
}
