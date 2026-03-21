import { describe, it, expect, beforeEach } from "vitest";
import { IdentityResolver } from "../identity.js";
import type { UserIdentity } from "../identity.js";
import type { ChannelType } from "../../types/normalized-message.js";

describe("IdentityResolver", () => {
  let resolver: IdentityResolver;

  beforeEach(() => {
    resolver = new IdentityResolver();
  });

  // ── registerUser & lookup ───────────────────────────────────────
  it("registers a user and resolves by channel", () => {
    const user: UserIdentity = {
      id: "user-1",
      displayName: "Alice",
      role: "maintainer",
      channelIdentities: new Map([["slack", "U123"]]),
    };

    resolver.registerUser(user);

    const found = resolver.resolveByChannel("slack", "U123");
    expect(found).not.toBeNull();
    expect(found!.id).toBe("user-1");
    expect(found!.displayName).toBe("Alice");
    expect(found!.role).toBe("maintainer");
  });

  it("returns null for unknown channel user", () => {
    const found = resolver.resolveByChannel("slack", "UNKNOWN");
    expect(found).toBeNull();
  });

  // ── getRole ─────────────────────────────────────────────────────
  it("returns the correct role for a registered user", () => {
    resolver.registerUser({
      id: "user-2",
      displayName: "Bob",
      role: "operator",
      channelIdentities: new Map([["whatsapp", "5511999"]]),
    });

    expect(resolver.getRole("whatsapp", "5511999")).toBe("operator");
  });

  it("returns read-only for unknown users (deny-by-default)", () => {
    expect(resolver.getRole("telegram", "unknown-id")).toBe("read-only");
  });

  // ── getUserById ─────────────────────────────────────────────────
  it("gets user by internal ID", () => {
    resolver.registerUser({
      id: "user-3",
      displayName: "Carol",
      role: "reviewer",
      channelIdentities: new Map([["discord", "D456"]]),
    });

    const user = resolver.getUserById("user-3");
    expect(user).not.toBeNull();
    expect(user!.displayName).toBe("Carol");
  });

  it("returns null for unknown internal ID", () => {
    expect(resolver.getUserById("no-such-id")).toBeNull();
  });

  // ── Cross-channel identity ─────────────────────────────────────
  it("supports multiple channel identities for one user", () => {
    const channels = new Map<ChannelType, string>([
      ["slack", "U100"],
      ["discord", "D200"],
      ["whatsapp", "5511888"],
    ]);

    resolver.registerUser({
      id: "user-multi",
      displayName: "Dave",
      role: "owner",
      channelIdentities: channels,
    });

    // All three channels resolve to the same user
    expect(resolver.resolveByChannel("slack", "U100")!.id).toBe("user-multi");
    expect(resolver.resolveByChannel("discord", "D200")!.id).toBe(
      "user-multi",
    );
    expect(resolver.resolveByChannel("whatsapp", "5511888")!.id).toBe(
      "user-multi",
    );
  });

  // ── Update existing user ───────────────────────────────────────
  it("updates user when registerUser is called with same id", () => {
    resolver.registerUser({
      id: "user-5",
      displayName: "Eve",
      role: "read-only",
      channelIdentities: new Map([["cli", "local"]]),
    });

    // Update role
    resolver.registerUser({
      id: "user-5",
      displayName: "Eve (promoted)",
      role: "maintainer",
      channelIdentities: new Map([["cli", "local"]]),
    });

    const user = resolver.getUserById("user-5");
    expect(user!.displayName).toBe("Eve (promoted)");
    expect(user!.role).toBe("maintainer");
    // Channel still resolves
    expect(resolver.resolveByChannel("cli", "local")!.id).toBe("user-5");
  });

  // ── Store attachment ────────────────────────────────────────────
  it("has no store by default", () => {
    expect(resolver.getStore()).toBeNull();
  });
});
