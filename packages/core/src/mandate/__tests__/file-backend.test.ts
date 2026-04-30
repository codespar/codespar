/**
 * F2.M1.3 FileMandateBackend — unit tests covering atomic write-through,
 * crash safety, and round-trip persistence across reopens.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMandateBackend } from "../file-backend.js";
import { MandateGenerator } from "../mandate-generator.js";

const TEST_SECRET = "test-secret-key-for-hmac-256";
const futureDate = (ms: number) => new Date(Date.now() + ms).toISOString();

let tmpDir: string;
let filePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mandate-test-"));
  filePath = join(tmpDir, "mandates.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("FileMandateBackend.put + get", () => {
  it("persists a mandate to disk", async () => {
    const backend = await FileMandateBackend.open(filePath);
    await backend.put({
      id: "mnd_1",
      type: "payment",
      authorizedBy: "u",
      agentId: "a",
      amount: 100,
      currency: "BRL",
      description: "x",
      conditions: [],
      signature: "sig",
      createdAt: "2026-04-30T10:00:00.000Z",
      expiresAt: futureDate(60_000),
    });
    expect(existsSync(filePath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(onDisk.version).toBe(1);
    expect(onDisk.mandates).toHaveLength(1);
    expect(onDisk.mandates[0].id).toBe("mnd_1");
  });

  it("survives reopen — second backend instance reads the same data", async () => {
    const backend1 = await FileMandateBackend.open(filePath);
    await backend1.put({
      id: "mnd_persist",
      type: "payment",
      authorizedBy: "u",
      agentId: "a",
      amount: 100,
      currency: "BRL",
      description: "persist",
      conditions: [],
      signature: "sig",
      createdAt: "2026-04-30T10:00:00.000Z",
      expiresAt: futureDate(60_000),
    });

    const backend2 = await FileMandateBackend.open(filePath);
    const found = await backend2.get("mnd_persist");
    expect(found).toBeDefined();
    expect(found!.description).toBe("persist");
  });

  it("rejects duplicate ids", async () => {
    const backend = await FileMandateBackend.open(filePath);
    const m = {
      id: "mnd_dup",
      type: "payment" as const,
      authorizedBy: "u",
      agentId: "a",
      amount: 1,
      currency: "BRL",
      description: "x",
      conditions: [],
      signature: "sig",
      createdAt: "2026-04-30T10:00:00.000Z",
      expiresAt: futureDate(60_000),
    };
    await backend.put(m);
    await expect(backend.put(m)).rejects.toThrow("already exists");
  });
});

describe("FileMandateBackend atomicity + corruption handling", () => {
  it("throws on corrupt JSON instead of silently resetting state", async () => {
    writeFileSync(filePath, "{ this is not valid json", "utf-8");
    const backend = new FileMandateBackend({ filePath });
    await expect(backend.load()).rejects.toThrow("not valid JSON");
  });

  it("throws on unrecognized shape (missing version field)", async () => {
    writeFileSync(filePath, JSON.stringify({ wrong: true }), "utf-8");
    const backend = new FileMandateBackend({ filePath });
    await expect(backend.load()).rejects.toThrow("unrecognized shape");
  });

  it("first-run is empty (file does not exist yet)", async () => {
    const backend = await FileMandateBackend.open(filePath);
    const active = await backend.getActive(new Date());
    expect(active).toEqual([]);
  });
});

describe("FileMandateBackend integrated with MandateGenerator", () => {
  it("MandateGenerator's createAsync persists through the file backend", async () => {
    const backend = await FileMandateBackend.open(filePath);
    const gen = new MandateGenerator(TEST_SECRET, backend);
    await gen.createAsync({
      id: "mnd_via_gen",
      type: "payment",
      authorizedBy: "u",
      agentId: "a",
      amount: 250,
      currency: "BRL",
      description: "via generator",
      expiresAt: futureDate(60_000),
    });
    const reopen = await FileMandateBackend.open(filePath);
    const recovered = await reopen.get("mnd_via_gen");
    expect(recovered).toBeDefined();
    expect(recovered!.amount).toBe(250);
  });

  it("useAsync persists used_at across reopen", async () => {
    const backend = await FileMandateBackend.open(filePath);
    const gen = new MandateGenerator(TEST_SECRET, backend);
    await gen.createAsync({
      id: "mnd_use_persist",
      type: "payment",
      authorizedBy: "u",
      agentId: "a",
      amount: 100,
      currency: "BRL",
      description: "x",
      expiresAt: futureDate(60_000),
    });
    await gen.useAsync("mnd_use_persist");

    const reopen = await FileMandateBackend.open(filePath);
    const recovered = await reopen.get("mnd_use_persist");
    expect(recovered!.usedAt).toBeTruthy();
  });

  it("revokeAsync persists revoked_at across reopen", async () => {
    const backend = await FileMandateBackend.open(filePath);
    const gen = new MandateGenerator(TEST_SECRET, backend);
    await gen.createAsync({
      id: "mnd_rev_persist",
      type: "payment",
      authorizedBy: "u",
      agentId: "a",
      amount: 100,
      currency: "BRL",
      description: "x",
      expiresAt: futureDate(60_000),
    });
    await gen.revokeAsync("mnd_rev_persist");

    const reopen = await FileMandateBackend.open(filePath);
    const recovered = await reopen.get("mnd_rev_persist");
    expect(recovered!.revokedAt).toBeTruthy();
  });
});
