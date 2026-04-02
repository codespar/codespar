import { describe, it, expect, beforeEach, vi } from "vitest";
import { IncidentGrouper } from "../incident-grouper.js";

describe("IncidentGrouper", () => {
  let grouper: IncidentGrouper;

  beforeEach(() => {
    grouper = new IncidentGrouper(5000); // 5s window for tests
  });

  it("returns isNew=true for first occurrence", () => {
    const result = grouper.maybeGroup({ project: "api", errorMessage: "Build failed", type: "deploy-failure" });
    expect(result.isNew).toBe(true);
    expect(result.incident.count).toBe(1);
    expect(result.incident.project).toBe("api");
  });

  it("groups same error within window (isNew=false, count increments)", () => {
    grouper.maybeGroup({ project: "api", errorMessage: "Build failed", type: "deploy-failure" });
    const result = grouper.maybeGroup({ project: "api", errorMessage: "Build failed", type: "deploy-failure" });
    expect(result.isNew).toBe(false);
    expect(result.incident.count).toBe(2);
  });

  it("creates new incident after window expires", () => {
    vi.useFakeTimers();
    grouper.maybeGroup({ project: "api", errorMessage: "Build failed", type: "deploy-failure" });
    vi.advanceTimersByTime(6000); // past 5s window
    const result = grouper.maybeGroup({ project: "api", errorMessage: "Build failed", type: "deploy-failure" });
    expect(result.isNew).toBe(true);
    expect(result.incident.count).toBe(1);
    vi.useRealTimers();
  });

  it("treats different projects as different incidents", () => {
    const r1 = grouper.maybeGroup({ project: "api", errorMessage: "Build failed", type: "deploy-failure" });
    const r2 = grouper.maybeGroup({ project: "web", errorMessage: "Build failed", type: "deploy-failure" });
    expect(r1.isNew).toBe(true);
    expect(r2.isNew).toBe(true);
    expect(r1.incident.id).not.toBe(r2.incident.id);
  });

  it("treats different errors as different incidents", () => {
    const r1 = grouper.maybeGroup({ project: "api", errorMessage: "Build failed", type: "deploy-failure" });
    const r2 = grouper.maybeGroup({ project: "api", errorMessage: "OOM killed", type: "deploy-failure" });
    expect(r1.isNew).toBe(true);
    expect(r2.isNew).toBe(true);
  });

  it("acknowledge sets flag", () => {
    const { incident } = grouper.maybeGroup({ project: "api", errorMessage: "err", type: "deploy-failure" });
    expect(grouper.acknowledge(incident.id)).toBe(true);
    expect(grouper.getActive()[0].acknowledged).toBe(true);
  });

  it("acknowledge returns false for unknown id", () => {
    expect(grouper.acknowledge("nonexistent")).toBe(false);
  });

  it("getActive returns sorted by lastSeen desc", () => {
    vi.useFakeTimers({ now: 1000 });
    grouper.maybeGroup({ project: "a", errorMessage: "err1", type: "x" });
    vi.advanceTimersByTime(1000);
    grouper.maybeGroup({ project: "b", errorMessage: "err2", type: "x" });
    const active = grouper.getActive();
    expect(active[0].project).toBe("b");
    expect(active[1].project).toBe("a");
    vi.useRealTimers();
  });

  it("updates analysis on subsequent occurrences", () => {
    grouper.maybeGroup({ project: "api", errorMessage: "err", type: "x" });
    grouper.maybeGroup({ project: "api", errorMessage: "err", type: "x" }, { severity: "critical", rootCause: "OOM" });
    const active = grouper.getActive();
    expect((active[0].analysis as { rootCause: string }).rootCause).toBe("OOM");
  });

  it("destroy clears groups and interval", () => {
    grouper.maybeGroup({ project: "api", errorMessage: "err", type: "x" });
    grouper.destroy();
    expect(grouper.getActive()).toHaveLength(0);
  });
});
