/**
 * Integration test for sessions/core ↔ FileStorage round-trip (F10.M2).
 *
 * Exercises the real StorageProvider (FileStorage on a tmpdir) end-to-end
 * so the schema/method wiring is verified outside the in-memory test
 * stubs. The PostgreSQL round-trip is covered by the existing
 * pg-storage.integration test gated on DATABASE_URL.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStorage } from "../../storage/file-storage.js";
import { findOrCreateSession, closeSessionById } from "../core.js";

let dir: string;
let storage: FileStorage;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codespar-sessions-"));
  storage = new FileStorage(dir, "org-it");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("sessions/core ↔ FileStorage (integration)", () => {
  it("persists and rehydrates a channel-bridge session across instances", async () => {
    const created = await findOrCreateSession(
      {
        orgId: "org-it",
        projectId: "prj_default",
        channelType: "whatsapp",
        channelUserId: "u-1",
        instanceId: "codespar-bz",
      },
      storage,
    );

    // Second findOrCreateSession with same key returns the existing row.
    const same = await findOrCreateSession(
      {
        orgId: "org-it",
        projectId: "prj_default",
        channelType: "whatsapp",
        channelUserId: "u-1",
      },
      storage,
    );
    expect(same.id).toBe(created.id);

    // Fresh storage instance pointed at the same dir sees the row.
    const reopened = new FileStorage(dir, "org-it");
    const found = await reopened.findSessionByChannelUser(
      "prj_default",
      "whatsapp",
      "u-1",
    );
    expect(found?.id).toBe(created.id);
    expect(found?.instanceId).toBe("codespar-bz");
  });

  it("closeSessionById flips status and the next findOrCreate reifies a new row", async () => {
    const first = await findOrCreateSession(
      {
        orgId: "org-it",
        projectId: "prj_default",
        channelType: "whatsapp",
        channelUserId: "u-2",
      },
      storage,
    );

    const closed = await closeSessionById(first.id, storage);
    expect(closed).toBe(true);

    const second = await findOrCreateSession(
      {
        orgId: "org-it",
        projectId: "prj_default",
        channelType: "whatsapp",
        channelUserId: "u-2",
      },
      storage,
    );
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("active");
  });
});
