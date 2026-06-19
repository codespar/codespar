# Example: meta-tool adapter

An example that registers a meta-tool against the runtime's `MetaToolHook`
registration seam (the fifth plugin hook) and shows it dispatch end-to-end on a
fresh self-hosted install — with nothing beyond the framework.

## What it shows

- How to implement a `MetaToolHook` (`id`, `handles`, `definitions`, `execute`).
- How to register it on the `pluginRegistry` singleton during bootstrap.
- How the runtime then dispatches `POST /sessions/:id/execute` with
  `{ "tool": "example_echo" }` through your hook by name.

```ts
import { pluginRegistry } from "@codespar/core";
import { registerExampleMetaTool } from "@codespar/example-meta-tool-adapter";

registerExampleMetaTool(pluginRegistry);
// pluginRegistry.seal();  // lock the registry after bootstrap
```

The example tool (`example_echo`) is deliberately neutral: it echoes its input,
upper-cases it on `action: "uppercase"`, and returns a fixed pong on
`action: "ping"`. Swap the hook body for whatever your meta-tool needs to do —
the registration and dispatch wiring is the same.

## Proven end-to-end

This example is the canonical "add your own meta-tool" reference because it is
tested against the real seam, not in isolation:

- `src/__tests__/smoke.test.ts` — in-process unit coverage: the example
  registers on a fresh `PluginRegistry`, is advertised through its definitions,
  and runs via `hook.execute(...)`.
- `src/__tests__/integration.test.ts` — end-to-end: it mounts the real
  `registerSessionRoutes` from `@codespar/core` in a Fastify app, registers the
  example on the `pluginRegistry` singleton the route consults, then drives each
  action over HTTP through `POST /sessions/:id/execute`. It asserts the real
  outputs come back through the HTTP envelope (`echo` → `{ message }`,
  `uppercase` → the upper-cased message, `ping` → `{ pong: true }`), that
  `codespar_list_tools` advertises `example_echo` once registered, and that an
  unregistered name still returns `Tool not registered`.

If the registration seam or this example drifts, the integration test fails.
Copy it to get a registrant proven against the actual execute path.

A registered hook runs arbitrary in-process code on the execute path, so treat
any registrant with the same scrutiny as a dependency you import and call. The
seam does not sandbox registrants: a real registrant owns its own input
validation, host allow-listing, resource bounds, and log redaction.
