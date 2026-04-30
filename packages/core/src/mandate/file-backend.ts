/**
 * File-backed mandate backend — the recommended self-host default.
 *
 * Persists every mandate as a JSON document inside one file
 * (default: `mandates.json` in the configured data dir). On
 * construction, reads the file into an in-memory map; every
 * mutation rewrites the file atomically (write to temp + rename).
 *
 * Concurrency:
 *   - Single-process self-host: this backend is correct as-is.
 *     Mutations serialize through a per-instance write queue so
 *     atomic-rename happens after each operation completes.
 *   - Multi-process self-host: NOT supported. Two Node processes
 *     writing the same mandates.json will race. Operators in this
 *     scenario should use the Postgres backend from
 *     `@codespar-enterprise/mandate-postgres`. This constraint is
 *     intentional — file-locking semantics across OSes are too
 *     brittle to rely on for a payment authorization primitive.
 *
 * Crash safety:
 *   - Atomic rename guarantees the visible mandates.json is always
 *     a complete, valid JSON document. A crash mid-write leaves the
 *     prior version intact; the in-flight mutation is lost (caller
 *     sees an error from fs.rename or fs.writeFile).
 *   - On startup, a corrupted JSON throws loud; we don't silently
 *     reset state. Operator must intervene.
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Mandate, MandateBackend } from "./types.js";

interface FileFormat {
  /** Schema version. Lets future migrations land cleanly. */
  version: 1;
  mandates: Mandate[];
}

export interface FileMandateBackendConfig {
  /** Absolute or relative path to the data file. Parent dir is
   *  created if missing. */
  filePath: string;
}

export class FileMandateBackend implements MandateBackend {
  private cache = new Map<string, Mandate>();
  private writeQueue: Promise<unknown> = Promise.resolve();
  private loaded = false;

  constructor(private readonly config: FileMandateBackendConfig) {}

  /**
   * Load the file into memory. Idempotent. Call once before the
   * backend is used; subsequent calls are no-ops. Convenient
   * factory `FileMandateBackend.open(path)` provided below for
   * the common case.
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    if (!existsSync(this.config.filePath)) {
      // First-run: empty cache, file will be created on first put.
      this.loaded = true;
      return;
    }
    const raw = await readFile(this.config.filePath, "utf-8");
    let parsed: FileFormat;
    try {
      parsed = JSON.parse(raw) as FileFormat;
    } catch (err) {
      throw new Error(
        `FileMandateBackend: ${this.config.filePath} is not valid JSON. ` +
          `Refusing to silently reset mandate state. ` +
          `Operator: inspect the file and either repair or remove it. ` +
          `Underlying parse error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (parsed?.version !== 1 || !Array.isArray(parsed.mandates)) {
      throw new Error(
        `FileMandateBackend: ${this.config.filePath} has an unrecognized shape. ` +
          `Expected { version: 1, mandates: Mandate[] }.`,
      );
    }
    for (const m of parsed.mandates) this.cache.set(m.id, m);
    this.loaded = true;
  }

  static async open(filePath: string): Promise<FileMandateBackend> {
    const backend = new FileMandateBackend({ filePath });
    await backend.load();
    return backend;
  }

  async put(mandate: Mandate): Promise<void> {
    await this.ensureLoaded();
    if (this.cache.has(mandate.id)) {
      throw new Error(`Mandate ${mandate.id} already exists`);
    }
    this.cache.set(mandate.id, mandate);
    await this.flush();
  }

  async get(id: string): Promise<Mandate | undefined> {
    await this.ensureLoaded();
    return this.cache.get(id);
  }

  async markUsed(id: string, usedAt: string): Promise<Mandate> {
    await this.ensureLoaded();
    const mandate = this.cache.get(id);
    if (!mandate) throw new Error(`Mandate ${id} not found`);
    if (mandate.usedAt) throw new Error(`Mandate ${id} has already been used`);
    if (mandate.revokedAt) throw new Error(`Mandate ${id} has been revoked`);
    if (new Date(mandate.expiresAt) <= new Date()) {
      throw new Error(`Mandate ${id} has expired`);
    }
    mandate.usedAt = usedAt;
    await this.flush();
    return mandate;
  }

  async markRevoked(id: string, revokedAt: string): Promise<Mandate> {
    await this.ensureLoaded();
    const mandate = this.cache.get(id);
    if (!mandate) throw new Error(`Mandate ${id} not found`);
    if (mandate.revokedAt) throw new Error(`Mandate ${id} is already revoked`);
    mandate.revokedAt = revokedAt;
    await this.flush();
    return mandate;
  }

  async getActive(now: Date): Promise<Mandate[]> {
    await this.ensureLoaded();
    return Array.from(this.cache.values()).filter(
      (m) => !m.usedAt && !m.revokedAt && new Date(m.expiresAt) > now,
    );
  }

  /* ── private ───────────────────────────────────────────────── */

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  /**
   * Serialise + atomically replace the on-disk file.
   *
   * Operations are serialised through `writeQueue` so concurrent
   * mutations within the same process don't race on the rename.
   * Atomicity guarantee: writeFile to a sibling tmp path, then
   * rename — POSIX rename is atomic within the same filesystem.
   */
  private async flush(): Promise<void> {
    const next = this.writeQueue.then(async () => {
      const dir = dirname(this.config.filePath);
      if (!existsSync(dir)) await mkdir(dir, { recursive: true });
      const tmpPath = join(
        dir,
        `.${dirname(this.config.filePath) === dir ? "mandates" : ""}.${process.pid}.${Date.now()}.tmp`,
      );
      const payload: FileFormat = {
        version: 1,
        mandates: Array.from(this.cache.values()),
      };
      await writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf-8");
      await rename(tmpPath, this.config.filePath);
    });
    this.writeQueue = next.catch(() => undefined);
    await next;
  }
}
