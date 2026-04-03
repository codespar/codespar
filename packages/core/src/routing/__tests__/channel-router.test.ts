import { describe, it, expect, beforeEach } from "vitest";
import { ChannelRouter } from "../channel-router.js";
import type { ChannelRoute } from "../channel-router.js";
import type { StorageProvider } from "../../storage/types.js";

/** Minimal in-memory StorageProvider stub for testing persistence. */
function createMockStorage(): StorageProvider & { _data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    _data: data,
    async getMemory(_agentId: string, key: string) {
      return data.get(`${_agentId}:${key}`) ?? null;
    },
    async setMemory(_agentId: string, key: string, value: unknown) {
      data.set(`${_agentId}:${key}`, value);
    },
    // All other StorageProvider methods are unused — stub them out
    async getAllMemory() { return []; },
    async getProjectConfig() { return null; },
    async setProjectConfig() {},
    async deleteProjectConfig() {},
    async getProjectsList() { return []; },
    async addProject() {},
    async removeProject() {},
    async addSubscriber() { return { email: "", subscribedAt: "", source: "", confirmed: false }; },
    async getSubscribers() { return []; },
    async removeSubscriber() {},
    async getSubscriberCount() { return 0; },
    async saveSlackInstallation() {},
    async getSlackInstallation() { return null; },
    async getAllSlackInstallations() { return []; },
    async removeSlackInstallation() {},
    async saveAgentState() {},
    async getAgentState() { return null; },
    async getAllAgentStates() { return []; },
    async saveChannelConfig() {},
    async getChannelConfig() { return null; },
    async appendAudit() { return { id: "", timestamp: new Date(), actorType: "system" as const, actorId: "", action: "", result: "success" as const }; },
    async queryAudit() { return { entries: [], total: 0 }; },
  };
}

describe("ChannelRouter", () => {
  let router: ChannelRouter;

  const devopsRoute: ChannelRoute = {
    channelType: "slack",
    channelId: "C001",
    channelName: "#devops",
    alertTypes: ["deploy"],
  };

  const incidentsRoute: ChannelRoute = {
    channelType: "slack",
    channelId: "C002",
    channelName: "#incidents",
    alertTypes: ["error", "incident"],
  };

  const allAlertsRoute: ChannelRoute = {
    channelType: "discord",
    channelId: "D001",
    channelName: "all-alerts",
    alertTypes: ["all"],
  };

  const projectScopedRoute: ChannelRoute = {
    channelType: "telegram",
    channelId: "T001",
    channelName: "api-gateway-alerts",
    alertTypes: ["deploy", "error"],
    projectFilter: "api-gateway",
  };

  beforeEach(() => {
    router = new ChannelRouter();
  });

  // ── addRoute / removeRoute ──

  describe("addRoute", () => {
    it("adds a route and makes it available via list()", () => {
      router.addRoute(devopsRoute);
      expect(router.list()).toHaveLength(1);
      expect(router.list()[0]).toEqual(devopsRoute);
    });

    it("replaces an existing route for the same channelType+channelId", () => {
      router.addRoute(devopsRoute);
      const updated = { ...devopsRoute, alertTypes: ["deploy", "error"] };
      router.addRoute(updated);

      expect(router.list()).toHaveLength(1);
      expect(router.list()[0].alertTypes).toEqual(["deploy", "error"]);
    });

    it("allows multiple routes for different channels", () => {
      router.addRoute(devopsRoute);
      router.addRoute(incidentsRoute);
      router.addRoute(allAlertsRoute);
      expect(router.list()).toHaveLength(3);
    });
  });

  describe("removeRoute", () => {
    it("removes a route by channelType+channelId", () => {
      router.addRoute(devopsRoute);
      router.addRoute(incidentsRoute);
      router.removeRoute("slack", "C001");

      expect(router.list()).toHaveLength(1);
      expect(router.list()[0].channelId).toBe("C002");
    });

    it("does nothing when removing a non-existent route", () => {
      router.addRoute(devopsRoute);
      router.removeRoute("slack", "NONEXISTENT");
      expect(router.list()).toHaveLength(1);
    });
  });

  // ── getTargets ──

  describe("getTargets with alertType filtering", () => {
    beforeEach(() => {
      router.addRoute(devopsRoute);
      router.addRoute(incidentsRoute);
      router.addRoute(allAlertsRoute);
    });

    it("returns only routes matching the alert type", () => {
      const targets = router.getTargets("deploy");
      const ids = targets.map((t) => t.channelId);

      expect(ids).toContain("C001"); // #devops has "deploy"
      expect(ids).toContain("D001"); // all-alerts has "all"
      expect(ids).not.toContain("C002"); // #incidents has "error", "incident"
    });

    it("returns error routes correctly", () => {
      const targets = router.getTargets("error");
      const ids = targets.map((t) => t.channelId);

      expect(ids).toContain("C002"); // #incidents has "error"
      expect(ids).toContain("D001"); // all-alerts has "all"
      expect(ids).not.toContain("C001"); // #devops only has "deploy"
    });

    it("returns incident routes correctly", () => {
      const targets = router.getTargets("incident");
      const ids = targets.map((t) => t.channelId);

      expect(ids).toContain("C002"); // #incidents has "incident"
      expect(ids).toContain("D001"); // all-alerts has "all"
    });
  });

  describe("getTargets with 'all' alertType", () => {
    it("'all' matches every alert type", () => {
      router.addRoute(allAlertsRoute);

      expect(router.getTargets("deploy")).toHaveLength(1);
      expect(router.getTargets("error")).toHaveLength(1);
      expect(router.getTargets("incident")).toHaveLength(1);
      expect(router.getTargets("anything-else")).toHaveLength(1);
    });
  });

  describe("getTargets with project filtering", () => {
    beforeEach(() => {
      router.addRoute(devopsRoute); // no projectFilter
      router.addRoute(projectScopedRoute); // projectFilter: "api-gateway"
    });

    it("returns project-scoped route when projectId matches", () => {
      const targets = router.getTargets("deploy", "api-gateway");
      const ids = targets.map((t) => t.channelId);

      expect(ids).toContain("C001"); // no filter = matches all
      expect(ids).toContain("T001"); // filter matches
    });

    it("excludes project-scoped route when projectId does not match", () => {
      const targets = router.getTargets("deploy", "billing-service");
      const ids = targets.map((t) => t.channelId);

      expect(ids).toContain("C001"); // no filter = matches all
      expect(ids).not.toContain("T001"); // filter does not match
    });

    it("excludes project-scoped route when no projectId is provided", () => {
      const targets = router.getTargets("deploy");
      const ids = targets.map((t) => t.channelId);

      expect(ids).toContain("C001");
      expect(ids).not.toContain("T001"); // has projectFilter but no projectId given
    });
  });

  describe("getTargets fallback (no routes match)", () => {
    it("returns empty array when no routes are configured", () => {
      expect(router.getTargets("deploy")).toEqual([]);
    });

    it("returns empty array when no routes match the alert type", () => {
      router.addRoute(devopsRoute); // only "deploy"
      expect(router.getTargets("error")).toEqual([]);
    });
  });

  // ── hasRoutes ──

  describe("hasRoutes", () => {
    it("returns false when empty", () => {
      expect(router.hasRoutes()).toBe(false);
    });

    it("returns true after adding a route", () => {
      router.addRoute(devopsRoute);
      expect(router.hasRoutes()).toBe(true);
    });

    it("returns false after removing all routes", () => {
      router.addRoute(devopsRoute);
      router.removeRoute("slack", "C001");
      expect(router.hasRoutes()).toBe(false);
    });
  });

  // ── Persistence ──

  describe("loadFromStorage / saveToStorage", () => {
    it("persists routes and restores them", async () => {
      const storage = createMockStorage();

      router.addRoute(devopsRoute);
      router.addRoute(incidentsRoute);
      await router.saveToStorage(storage);

      const restored = new ChannelRouter();
      await restored.loadFromStorage(storage);

      expect(restored.list()).toHaveLength(2);
      expect(restored.list()).toEqual(router.list());
    });

    it("loads empty routes when nothing is stored", async () => {
      const storage = createMockStorage();
      await router.loadFromStorage(storage);
      expect(router.list()).toEqual([]);
    });

    it("handles corrupted storage data gracefully", async () => {
      const storage = createMockStorage();
      storage._data.set("system:channel-routes", "not-an-array");
      await router.loadFromStorage(storage);
      expect(router.list()).toEqual([]);
    });
  });

  // ── list() returns a copy ──

  describe("list", () => {
    it("returns a copy, not a reference to internal state", () => {
      router.addRoute(devopsRoute);
      const list = router.list();
      list.push(incidentsRoute);

      expect(router.list()).toHaveLength(1); // internal state unchanged
    });
  });
});
