# Example: meta-tool adapter

A minimal MIT example that registers a meta-tool against the runtime's
`MetaToolHook` registration seam (the fifth plugin hook) and proves it
dispatches end-to-end on a fresh self-hosted install — with nothing
beyond the framework.

## What it shows

- How to implement a `MetaToolHook` (`id`, `handles`, `definitions`, `execute`).
- How to register it on the `pluginRegistry` singleton during bootstrap.
- How the runtime then dispatches `POST /sessions/:id/execute` with
  `{ "tool": "codespar_shop" }` through your hook by name.

```ts
import { pluginRegistry } from "@codespar/core";
import { registerExampleMetaTool } from "@codespar/example-meta-tool-adapter";

registerExampleMetaTool(pluginRegistry);
// pluginRegistry.seal();  // lock the registry after bootstrap
```

## What it is NOT

This adapter is illustrative, not production coverage. It mints a clearly
fake, non-payable sample code and settles nothing. It implements none of
the input-validation obligations a real adapter must honor (SSRF
normalization, host allow-listing, DoS bounds, PII/secret redaction), and
it rejects any request carrying a real `url` or `merchant` so the
"fork the example" path cannot silently ship an unsafe dereference.

Do not use it as a skeleton for a real adapter. Register a real
implementation against the seam for live coverage.
