# Test Mode — Session Mocks

CodeSpar runs in one of two modes, decided by the
`CODESPAR_TEST_MODE_ENABLED` env var:

- **Production mode (default).** Every tool dispatch goes to the
  real upstream provider. The mocks feature is inactive end-to-end.
- **Test mode (`CODESPAR_TEST_MODE_ENABLED=true`).** Every external
  tool dispatch requires a matching mock. Sessions declare what's
  available via the optional `mocks` field on `POST /sessions`; any
  dispatch without a matching entry returns `tool_not_mocked`. The
  runtime cannot reach a real upstream provider in test mode.

The intent of test mode is integration-test ergonomics: an agent
author wires their tests against a mock store, asserts on the
resulting tool calls, and ships without ever touching a real payment
provider, fiscal endpoint, or shipping API during CI.

The wire shape and error envelopes match the managed runtime exactly,
so the same agent code passes its tests against either endpoint.

## The mode switch: `CODESPAR_TEST_MODE_ENABLED`

The env var is a deployment-level mode switch. Set
`CODESPAR_TEST_MODE_ENABLED=true` (or `=1`, case-insensitive) before
starting the runtime to put the deployment in test mode.

With the flag unset (production mode):

- `POST /sessions` returns HTTP 501 with a `mocks_not_permitted`
  envelope when the request body carries `mocks`. The gate runs
  before the size cap and the shape validator, so the rejection
  reason is always the gate, never a derivative validation error.
- The dispatch path refuses to honour any mocks that may already
  sit on a session — defense in depth for the case where the flag
  is flipped off after sessions were created with mocks declared.
  Every tool call falls through to the bridge as if mocks were
  absent.

With the flag set (test mode):

- `POST /sessions` accepts the optional `mocks` field. The field
  declares what's available to the session for the duration of its
  lifetime.
- Every external tool dispatch consults the mocks engine first. A
  matching entry returns its scripted output; no match returns
  HTTP 422 `tool_not_mocked` — regardless of whether the session
  declared `mocks` at all. A session created without `mocks` (or
  with an empty `{}` map) cannot dispatch external tools in test
  mode; it can only dispatch built-ins (see "Built-in tools bypass
  the gate" below).

There is no middle state. A runtime is either in test mode or it
is not; "flag on, session has no mocks" is not a real-upstream
fallthrough — it is a strict failure.

```bash
export CODESPAR_TEST_MODE_ENABLED=true
npm run start:server
```

The migration that creates the `session_tool_call_counts` table runs
unconditionally; with the flag off the table simply stays empty.

## Wire shape

`POST /sessions` accepts:

```json
{
  "user_id": "u",
  "servers": ["asaas"],
  "mocks": {
    "asaas/create_payment": { "id": "pay_test_42", "status": "PENDING" },
    "asaas/get_payment": [
      { "id": "pay_test_42", "status": "PENDING" },
      { "id": "pay_test_42", "status": "CONFIRMED" }
    ]
  }
}
```

Keys must match the canonical `server/tool` form. The regex enforced
at create time is:

```
^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9_-]*$
```

Values are either:

- A **non-null JSON object** — single-shot. Every matching call returns
  the same payload. No counter advances.
- An **array of non-null JSON objects** — stateful. Call N returns
  entry N, the counter advances on success only, and the call past the
  cap returns `mocks_exhausted`.

Validation is strict on shape, lenient on membership. Unknown but
canonical-shape tool names are accepted at create. They surface as
`tool_not_mocked` at dispatch if the agent actually calls them.

## Test mode is strict by definition

In test mode, every external tool dispatch requires a matching mock
entry. There is no per-session opt-out and no fallthrough — the only
way an external tool returns anything other than its mock is if the
mock is declared and matches.

That covers four failure shapes a typo or omission could otherwise
introduce:

- **Misspelled tool name.** `asaas/create_paymnet` returns
  `tool_not_mocked` with the canonical name in the envelope.
- **Misspelled server prefix.** `assa/create_payment` returns
  `tool_not_mocked`, not the legacy `Tool not registered` envelope.
- **Mock entry omitted.** Forgot to add `asaas/get_payment` to the
  mocks map? Same envelope — the test fails on the first call
  rather than reaching a live provider.
- **No `mocks` field at all.** A session created without `mocks`
  cannot dispatch external tools in test mode. Every call returns
  `tool_not_mocked` until the test author either adds mocks (by
  creating a new session — `mocks` is immutable on an existing one)
  or runs the same fixture against a flag-off deployment.

## Built-in tools bypass the gate

Test mode exists to prevent accidental external side effects — real
payment provider calls, real fiscal endpoints, real WhatsApp sends.
Built-in tools are metadata-only operations with no external side
effects, so the gate doesn't apply to them. Gating built-ins would
break the agent's ability to introspect the runtime in test mode and
buy nothing for the principle.

The current built-in allow-list (the `BUILT_IN_TOOLS` set in
`packages/core/src/server/routes/sessions.ts`):

| Tool | Purpose |
|------|---------|
| `codespar_list_tools` | List the registered agent skills |

**Extension rule (binding):** any future built-in that reaches
external state must NOT join this allow-list. It must be declared
in `session.mocks` like any other external dispatch. The allow-list
is the spec, not an implementation accident.

## Error envelopes

| Code | When | HTTP | Notes |
|------|------|------|-------|
| `mocks_not_permitted` | `mocks` sent on `POST /sessions` while `CODESPAR_TEST_MODE_ENABLED` is not truthy. | 501 | Gate runs before size and shape, so an oversized or malformed `mocks` payload sent to a flag-off deployment still surfaces this envelope, not `mocks_payload_too_large` or `mocks_invalid`. |
| `mocks_invalid` | `mocks` field fails shape validation at create. | 400 | Carries an RFC 6901 JSON Pointer in `field`. `asaas/create_payment` lands at `/mocks/asaas~1create_payment` per RFC 6901's `/` escape. |
| `mocks_payload_too_large` | Stringified `mocks` exceeds 64 KiB. | 413 | Hard cap. Keeps a runaway client from shipping a multi-megabyte mock blob in a single POST. |
| `tool_not_mocked` | Test mode on, external tool dispatched, no matching mock entry. | 422 | Returned for missing entries, missing `mocks` field entirely, and unknown server prefixes. The envelope carries `tool_name` with the canonical form. Built-in tools (see allow-list above) bypass this gate. |
| `mocks_exhausted` | Stateful array counter already at the cap. | 422 | Returned on the (N+1)th call when the array has N entries. |

The `mocks_invalid` validator never echoes the customer's submitted
key or value bytes — the templates are generic and the precise
location is delivered via the JSON Pointer.

## Counter semantics

Stateful arrays advance their counter **on success only**. The storage
layer enforces the cap as a SQL invariant via a cap-respecting UPSERT:
concurrent dispatch cannot overshoot.

Two backends:

- **HTTP sessions** live in-memory and never reach storage. A sibling
  `Map` on `packages/core/src/sessions/core.ts` holds their counters,
  fronted by the same call signature so the consume helper doesn't
  branch on session type.
- **Channel-bridge sessions** (WhatsApp, etc.) persist counters to
  PostgreSQL via the `session_tool_call_counts` table. FileStorage
  mirrors the table in JSON so single-tenant deployments get the same
  behaviour without Postgres.

## Dispatcher seam

Both call sites — `POST /sessions/:id/execute` and the chat-loop
tool-use branch — call `tryMockedDispatchWithStorage` before reaching
the bridge. The seam's behaviour depends on the deployment's mode:

- **Production mode (flag off).** The seam short-circuits to `null`
  immediately. The mocks engine never runs and the dispatcher falls
  through to the real bridge as if the feature weren't shipped.
- **Test mode (flag on).** The seam consults the session's `mocks`
  field via `evaluateSessionMock` and translates the outcome into a
  `ToolResult`-shaped envelope:
  - **Match found** — returns the scripted output.
  - **No match, including no `mocks` field at all** — returns a
    synthesised `tool_not_mocked` envelope. The dispatcher MUST NOT
    fall through to the bridge.
  - Other variants (`exhausted`, `mocks_engine_error`) flow
    through unchanged.

The seam never returns `null` in test mode. The only way the
dispatcher reaches the real bridge is in production mode.

This means mocks apply equally whether the caller hits `/execute`
directly with a tool name, or the agent reasons over its tools via
`/send`. A test can drive either entry point and the mocks engine
behaves the same way.

## Writing tests against the OSS runtime

A minimal pattern, in shell (assumes the server was started with
`CODESPAR_TEST_MODE_ENABLED=true`):

```bash
# 1. Create a session with mocks declared.
session_id=$(curl -sS -X POST http://localhost:3000/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "test-user",
    "servers": ["asaas"],
    "mocks": {
      "asaas/create_payment": { "id": "pay_test_42", "status": "PENDING" }
    }
  }' | jq -r .id)

# 2. Execute the mocked tool. The response comes from the mock store,
#    not a real Asaas call.
curl -sS -X POST "http://localhost:3000/sessions/$session_id/execute" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "tool": "asaas/create_payment", "input": {} }'

# 3. Clean up.
curl -sS -X DELETE "http://localhost:3000/sessions/$session_id" \
  -H "Authorization: Bearer $TOKEN"
```

The successful execute response carries `server: "mock"` so test
assertions can distinguish a mocked response from a real bridge call
without parsing the payload itself.

A runnable version of this flow lives at
[`examples/session-mocks.sh`](../examples/session-mocks.sh). The same
fixture is also exercised by the canonical-fixture round-trip test
(`packages/core/src/server/routes/__tests__/sessions-mocks-fixture.test.ts`),
which reads `tests/fixtures/mocks_canonical.json` — the file the
Python SDK ships — so the wire-shape parity across runtimes and SDKs
stays provable at a glance.

## What this layer doesn't do

The OSS mocks engine handles the test-mode wire contract and nothing
else. Above it the managed tier adds an authorization gate (per-tenant
test/live environment separation), a policy-engine wrapper, audit-chain
stamping for mocked calls, commercial-memory capture from mock
sessions, and approval-replay coordination. None of those land in the
OSS layer — they're wrapper concerns of the managed runtime.

A session declared with mocks behaves identically under both runtimes
at the wire boundary; the difference is what happens around the call,
not what the call returns.
