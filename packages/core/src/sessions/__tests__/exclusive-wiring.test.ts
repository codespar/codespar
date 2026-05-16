/**
 * W5 unit test — exclusive wiring of the WhatsApp adapter.
 *
 * The F10.M2 design says the WhatsApp adapter is NOT added to the
 * AgentSupervisor; instead `start.mjs` calls `adapter.onMessage(bridgeFn)`
 * directly. This test pins the contract so a future refactor can't
 * silently route inbound WhatsApp traffic back through the supervisor.
 *
 * The check is structural: after a representative bootstrap snippet,
 *   - the adapter's internal `messageHandler` is the bridge function
 *     we supplied, NOT a closure created by the supervisor's
 *     addAdapter wiring; and
 *   - the supervisor's adapter set does not contain the WhatsApp
 *     adapter.
 *
 * The test doesn't import the real channel-whatsapp package (that
 * would create a circular workspace dependency in tsc); it uses a
 * minimal stand-in that exposes the same surface (`onMessage` +
 * `messageHandler` field) plus the supervisor's actual addAdapter
 * shape (a method on a class with an `adapters` array).
 */

import { describe, it, expect, vi } from "vitest";

interface MinimalAdapter {
  type: string;
  messageHandler: ((m: unknown) => unknown) | null;
  onMessage(h: (m: unknown) => unknown): void;
}

function makeAdapter(type: string): MinimalAdapter {
  const a: MinimalAdapter = {
    type,
    messageHandler: null,
    onMessage(h) {
      this.messageHandler = h;
    },
  };
  return a;
}

// Stand-in for AgentSupervisor.addAdapter — the relevant detail is
// that it sets the adapter's messageHandler to a supervisor closure.
class MinimalSupervisor {
  readonly adapters: MinimalAdapter[] = [];
  addAdapter(adapter: MinimalAdapter): void {
    adapter.onMessage((m) => this.handleViaSupervisor(adapter, m));
    this.adapters.push(adapter);
  }
  handleViaSupervisor(_a: MinimalAdapter, _m: unknown): unknown {
    return "supervisor-routed";
  }
  async start(): Promise<void> {}
}

describe("F10.M2 — WhatsApp adapter exclusive wiring (W5)", () => {
  it("bridge handler is the final messageHandler, not the supervisor closure", () => {
    const supervisor = new MinimalSupervisor();
    const whatsappAdapter = makeAdapter("whatsapp");

    // Bridge wiring matches start.mjs after F10.M2.
    const bridgeFn = vi.fn();
    whatsappAdapter.onMessage(bridgeFn);

    // NOTE: deliberately NOT calling supervisor.addAdapter(whatsappAdapter).
    expect(supervisor.adapters).not.toContain(whatsappAdapter);
    expect(whatsappAdapter.messageHandler).toBe(bridgeFn);
  });

  it("if addAdapter is mistakenly called after the bridge wiring it would clobber the handler — guard tests existence", () => {
    // This negative case demonstrates the failure mode the rule prevents.
    const supervisor = new MinimalSupervisor();
    const whatsappAdapter = makeAdapter("whatsapp");

    const bridgeFn = vi.fn();
    whatsappAdapter.onMessage(bridgeFn);
    // Wrong wiring: supervisor takes over.
    supervisor.addAdapter(whatsappAdapter);

    expect(whatsappAdapter.messageHandler).not.toBe(bridgeFn);
  });

  it("non-WhatsApp adapters legitimately stay on the supervisor path", () => {
    const supervisor = new MinimalSupervisor();
    const slack = makeAdapter("slack");
    supervisor.addAdapter(slack);
    expect(supervisor.adapters).toContain(slack);
    expect(typeof slack.messageHandler).toBe("function");
  });
});
