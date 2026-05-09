# PLAN — P1 OSS MCP Bridge (single PR)

## Goal

Add a thin OSS MCP bridge to `packages/core` so that `POST /sessions/:id/execute` routes tool calls whose name contains a `/` to spawned stdio MCP server processes, instead of returning `Tool not registered`. The same code path serves OSS demos (with `MCP_DEMO=true`), CI integration runs, and production self-hosted deployments — there is no demo-mode branch in source.

## Scope (single PR)

The PR introduces three new modules in `packages/core/src/mcp/` (`registry.ts`, `process-manager.ts`, plus shared types), a seed `mcp-servers.json` at the repo root, a JSON-RPC 2.0 stdio fixture under `tests/fixtures/`, unit tests, an integration validation script, and a 6-line dispatch hook in `packages/core/src/server/routes/sessions.ts`. The PR does **not** change session creation, send routes, channels, or storage.

## Design constraints (inline, non-negotiable)

These constraints originate in the source issue and must hold across the whole PR. Each is mapped to one or more atomic tasks below; no task is "complete" unless its referenced constraints are testable and tested.

- **C1 — BRIDGE-IS-DATA-DRIVEN.** `McpProcessManager` spawns *only* using fields from `McpServerSpec` (`command`, `env`, `transport`). It must not inspect `MCP_DEMO`, must not branch on server ID, must not carry a built-in `@codespar/mcp-*` allowlist, and must not auto-prefix `npx`. The seed `mcp-servers.json` carries the full `npx` command verbatim.
- **C2 — ENV-PASSTHROUGH-NOT-MERGE.** Spawn merges `process.env` with `spec.env` (spec wins on key conflict). `MCP_DEMO` is set on the runtime parent process and inherited by children via the merge. The bridge source must not name `MCP_DEMO` anywhere. Same code path for OSS demo, CI integration, and production.
- **C3 — UNIT-TEST-WITH-STDIO-FIXTURE-CHILD.** Unit tests for `McpProcessManager` spawn `tests/fixtures/echo-mcp-server.mjs`, a tiny script that speaks JSON-RPC 2.0 over stdio with deterministic `ToolResult` replies. Unit tests must not depend on `@codespar/mcp-asaas` or any catalog package being installed.
- **C4 — INTEGRATION-TEST-WITH-REAL-MCP_DEMO.** The validation script (canonical version below) drives the bridge against actual `@codespar/mcp-*` processes with `MCP_DEMO=true`. It is not run in default `npm test`; it is the manual / opt-in integration check.
- **C5 — LIFECYCLE-TIED-TO-SESSION.** Process cache key is the tuple `(sessionId, serverId)`. `DELETE /sessions/:id` must kill all child processes for that session *before* returning 204. No global pool, no cross-session reuse.
- **C6 — TOOL-NAME-PARSING-STRICT.** Split tool name on the **first** `/` only. Validate the prefix against `session.servers`. If the prefix is not in `session.servers`, return the existing `Tool not registered` shape (success:false, structured fields) — *not* HTTP 403. Built-in tools (`codespar_list_tools`, plus any future non-`/` names) keep their existing dispatch path unchanged.
- **C7 — FORWARD-COMPAT-BOUNDARY-LOCKED.** `McpServerRegistry` exposes only `resolve(serverId): McpServerSpec | null`. No file-path leakage in the public API. A future catalog-backed implementation must be drop-in: swap `registry.ts` without touching `process-manager.ts` or the dispatch hook in `sessions.ts`.
- **C8 — STDERR-AND-FAILURE-MODES-EXPLICIT.**
  - **C8a** — child stderr is read on a separate stream and forwarded via the existing structured logger (`createLogger`, `packages/core/src/observability/logger.ts`) tagged with `serverId`, `sessionId`, and `pid`. Stderr is *never* mixed into the JSON-RPC channel.
  - **C8b** — JSON-RPC parse errors return `ToolResult{success:false, error:"<structured code>"}` rather than throwing.
  - **C8c** — child crash mid-call surfaces as `success:false` on the in-flight call; the cache entry for `(sessionId, serverId)` is evicted so the next call re-spawns.
  - **C8d** — configurable per-call timeout, default 30s. Timeout cancels only the in-flight RPC (rejects the pending promise with a structured error), it does not kill the child process.

## Atomic tasks

Each task is `/work-on`-able: it has a goal, the files it touches, explicit acceptance criteria, and a test list. Tasks are ordered for sequential implementation; T-01 through T-04 are pure additive modules and can be merged in isolation, T-05 + T-06 wire them in.

---

### T-01 — Define MCP types and seed `mcp-servers.json`

**Goal.** Introduce the public-API surface for the bridge (types + registry) and commit the seed configuration. No process spawn yet.

**Files touched.**
- `packages/core/src/mcp/types.ts` (new) — `McpServerSpec`, `ToolResult` (re-exported / aligned with the existing inline shape in `sessions.ts`), structured error codes (`mcp.parse_error`, `mcp.timeout`, `mcp.child_exit`, `mcp.unknown_server`).
- `packages/core/src/mcp/registry.ts` (new) — `McpServerRegistry` class with `resolve(serverId: string): McpServerSpec | null`. Loads `mcp-servers.json` from `process.cwd()` on first call, caches the parsed map, returns `null` for unknown IDs.
- `packages/core/src/mcp/index.ts` (new) — re-exports the public surface (`McpServerSpec`, `McpServerRegistry`, error codes).
- `mcp-servers.json` (new, repo root) — `{ "asaas": { "command": ["npx", "@codespar/mcp-asaas"], "transport": "stdio" }, "nuvem-fiscal": { "command": ["npx", "@codespar/mcp-nuvem-fiscal"], "transport": "stdio" }, "z-api": { "command": ["npx", "@codespar/mcp-z-api"], "transport": "stdio" } }`.
- `packages/core/src/index.ts` — export the public surface from `./mcp/index.js`.

**Acceptance criteria.**
- [AC-01.1] `McpServerSpec` is `{ command: string[]; env?: Record<string, string>; transport: "stdio" }`. No other transports defined in this PR.
- [AC-01.2] `McpServerRegistry.resolve` is the **only** public method. The class has no other exported method or property. *(Implements **C7**.)*
- [AC-01.3] The on-disk path of `mcp-servers.json` is not part of the registry's public type signature. Callers cannot derive the file location from the public API. *(Implements **C7**.)*
- [AC-01.4] `mcp-servers.json` carries the `npx` command verbatim — `entry.command[0] === "npx"` for all three entries. The bridge does not auto-prefix `npx` anywhere. *(Implements **C1**.)*

**Tests.**
- `packages/core/src/mcp/__tests__/registry.test.ts`:
  - [T-01.A] `resolve("asaas")` returns a spec with `command[0] === "npx"`, `command[1] === "@codespar/mcp-asaas"`, `transport === "stdio"`. *(Verifies **C1**.)*
  - [T-01.B] `resolve("does-not-exist")` returns `null`. *(Verifies **C7**.)*
  - [T-01.C] Public API type test (compile-only): assignment of `McpServerRegistry` to `{ resolve(serverId: string): McpServerSpec | null }` succeeds; assignment to a wider type that adds `loadFromDisk` or `path` fails. *(Verifies **C7**.)*

---

### T-02 — Stdio JSON-RPC 2.0 fixture child

**Goal.** Provide a self-contained fixture that lets unit tests exercise the bridge without installing any `@codespar/mcp-*` package.

**Files touched.**
- `tests/fixtures/echo-mcp-server.mjs` (new) — Node ESM script. Reads JSON-RPC 2.0 messages over stdin (line-delimited JSON, one message per line). On `tools/call`, replies with a deterministic `ToolResult`-shaped payload (`{ success: true, data: { echo: <input> }, ... }`). Supports `--crash-after-N` (exit code 1 after N calls), `--delay-ms <n>` (sleep before reply), `--garbage-on-call <toolName>` (write non-JSON to stdout for that call to drive parse-error tests), `--noisy-stderr` (write a known string to stderr on startup) so failure-mode tests can drive each branch deterministically. Fully MIT-licensed with a header pointing at the runtime test suite as the reason it exists.

**Acceptance criteria.**
- [AC-02.1] Fixture is a single `.mjs` file with no runtime dependencies outside the Node standard library. *(Implements **C3**.)*
- [AC-02.2] Fixture emits a JSON-RPC 2.0 reply with the same `id` field as the request. Reply matches the `ToolResult` shape used by `sessions.ts` (`success`, `data`, `error`, `tool`, `tool_call_id`, `called_at`, `duration`, `server`).
- [AC-02.3] Fixture writes startup confirmation only to stderr (never stdout) when `--noisy-stderr` is set, so tests can assert that stderr is not mixed into the JSON-RPC stdout channel. *(Supports **C8a**.)*

**Tests.**
- `tests/fixtures/__tests__/echo-mcp-server.test.ts`:
  - [T-02.A] Spawn the fixture, write one `tools/call` request, read reply on stdout, parse JSON, assert `id` matches.
  - [T-02.B] With `--noisy-stderr`, fixture writes the known string to stderr and stdout contains only valid JSON-RPC. *(Verifies **C8a** indirectly by giving downstream tests a clean signal.)*

---

### T-03 — `McpProcessManager`

**Goal.** Spawn stdio child processes from `McpServerSpec`, proxy JSON-RPC 2.0 `tools/call` over stdio, and manage lifecycle per `(sessionId, serverId)`.

**Files touched.**
- `packages/core/src/mcp/process-manager.ts` (new) — `McpProcessManager` class. Constructor takes `{ registry: McpServerRegistry, defaultTimeoutMs?: number }` (default 30000). Public methods:
  - `call(sessionId: string, serverId: string, tool: string, input: unknown, opts?: { timeoutMs?: number }): Promise<ToolResult>`
  - `closeSession(sessionId: string): Promise<void>`
  - `getActiveProcessCount(): number` (test-only diagnostic; documented as such).
- `packages/core/src/mcp/__tests__/process-manager.test.ts` (new).

**Acceptance criteria.**
- [AC-03.1] `call` looks up the spec via `registry.resolve(serverId)`. On `null`, returns `ToolResult{success:false, error:"mcp.unknown_server"}` without spawning. *(Implements **C7**.)*
- [AC-03.2] Spawn invocation is exactly `child_process.spawn(spec.command[0], spec.command.slice(1), { env: { ...process.env, ...(spec.env ?? {}) }, stdio: ["pipe","pipe","pipe"] })`. The spawn site reads no other config and inspects no other env var. *(Implements **C1**, **C2**.)*
- [AC-03.3] `process-manager.ts` and `registry.ts` source contain zero references to the literal string `MCP_DEMO`. Enforced by a lint-style assertion test (grep over the source files at test time). *(Implements **C2**.)*
- [AC-03.4] Process cache is keyed by the tuple `(sessionId, serverId)`. There is no global pool and no cross-session reuse. Internal cache type is e.g. `Map<\`${sessionId}::${serverId}\`, ChildHandle>`. *(Implements **C5**.)*
- [AC-03.5] `closeSession(sessionId)` sends `SIGTERM` to every child whose key starts with `\`${sessionId}::\``, awaits each child's `exit` event (with a hard `SIGKILL` fallback after 2s), removes the entries from the cache, and resolves only after all children have exited. *(Implements **C5**.)*
- [AC-03.6] Each `call` writes one JSON-RPC 2.0 request (`{ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: input } }`) followed by `\n` to the child's stdin, registers a pending-call entry keyed by `id`, and resolves when the matching reply arrives on stdout.
- [AC-03.7] Per-call timeout defaults to 30s, configurable via `opts.timeoutMs` and the constructor's `defaultTimeoutMs`. On timeout, the pending call rejects with `ToolResult{success:false, error:"mcp.timeout"}` but the child process is **not** killed; subsequent calls to the same `(sessionId, serverId)` reuse the live child. *(Implements **C8d**.)*
- [AC-03.8] If the child exits while a call is pending, the in-flight call resolves with `ToolResult{success:false, error:"mcp.child_exit"}` and the cache entry is evicted; the next call to the same `(sessionId, serverId)` re-spawns. *(Implements **C8c**.)*
- [AC-03.9] If a stdout chunk fails to parse as JSON, the manager logs the chunk via the structured logger and resolves the pending call (matched by request order) with `ToolResult{success:false, error:"mcp.parse_error"}`. The manager does **not** throw out of `call`. *(Implements **C8b**.)*
- [AC-03.10] Child stderr is consumed line-by-line and forwarded via `createLogger("mcp-bridge").info` (or `.warn` on non-empty stderr signals) with `{ serverId, sessionId, pid }`. Stderr bytes never appear on the JSON-RPC stdout channel. *(Implements **C8a**.)*

**Tests.** All tests use the T-02 fixture; **none** import or require `@codespar/mcp-*`.

- [T-03.A] Happy path — `call("s1","echo","tools/echo",{x:1})` returns `success:true` with `data.echo === {x:1}`. *(Verifies **C1**, **C3**, **C6** input shape.)*
- [T-03.B] Env passthrough — parent sets `BRIDGE_TEST_VAR=parent`, fixture echoes `process.env.BRIDGE_TEST_VAR` back; assert reply contains `"parent"`. *(Verifies **C2**.)*
- [T-03.C] Spec env override — spec has `env: { BRIDGE_TEST_VAR: "spec" }`, parent has `BRIDGE_TEST_VAR=parent`; reply contains `"spec"`. *(Verifies **C2**.)*
- [T-03.D] No `MCP_DEMO` in source — read `packages/core/src/mcp/process-manager.ts` and `registry.ts` from disk, assert neither contains the literal `MCP_DEMO`. *(Verifies **C1**, **C2**.)*
- [T-03.E] Cache key is per-tuple — two `call`s with same `sessionId` and same `serverId` reuse one child (`getActiveProcessCount() === 1`); two `call`s with same `sessionId` and different `serverId`s spawn two children. *(Verifies **C5**.)*
- [T-03.F] No cross-session reuse — `call("s1","echo",…)` then `call("s2","echo",…)` produces two children. *(Verifies **C5**.)*
- [T-03.G] `closeSession("s1")` kills all `s1` children and leaves `s2`'s child alive; observed via `getActiveProcessCount` and `process.kill(pid, 0)` returning ESRCH for the dead pids. *(Verifies **C5**.)*
- [T-03.H] Crash mid-call — fixture launched with `--crash-after-N=1`; first call resolves with `success:false, error:"mcp.child_exit"`; second call to the same `(sessionId, serverId)` re-spawns and succeeds. *(Verifies **C8c**.)*
- [T-03.I] Parse error — fixture launched with `--garbage-on-call=tools/poison`; call resolves with `success:false, error:"mcp.parse_error"` and child remains alive (a follow-up clean call succeeds). *(Verifies **C8b**.)*
- [T-03.J] Timeout — fixture launched with `--delay-ms=200`, call uses `opts.timeoutMs: 50`; rejects with `success:false, error:"mcp.timeout"`; child remains alive (`getActiveProcessCount` unchanged); a follow-up call without a low timeout succeeds. *(Verifies **C8d**.)*
- [T-03.K] Stderr separation — fixture launched with `--noisy-stderr`; the call's reply payload does not contain the stderr marker, and the structured logger received an event tagged `serverId`+`sessionId`+`pid`. (Use a logger spy or temporarily redirect `console.log/warn` to assert.) *(Verifies **C8a**.)*
- [T-03.L] Unknown server — `call("s1","not-registered","x",{})` returns `success:false, error:"mcp.unknown_server"` and spawns nothing (`getActiveProcessCount() === 0`). *(Verifies **C7**.)*

---

### T-04 — Module-level bridge singleton + structured `ToolResult` helper

**Goal.** Stand up a process-scoped `McpProcessManager` instance the way `sessions.ts` keeps its in-memory session map, and a small helper that maps an internal `ToolResult` (plus session/tool metadata) to the wire shape `sessions.ts` already returns. This is intentionally tiny — it exists so T-05's diff is small enough to review confidently.

**Files touched.**
- `packages/core/src/mcp/bridge.ts` (new) — exports `mcpBridge: McpProcessManager` (singleton, lazy-initialised with `new McpServerRegistry()`) and `clearMcpBridge(): Promise<void>` for test teardown (mirrors the `clearSessionStore()` pattern in `sessions.ts`).
- `packages/core/src/mcp/index.ts` — re-export `mcpBridge`, `clearMcpBridge`.

**Acceptance criteria.**
- [AC-04.1] `mcpBridge` is a single `McpProcessManager` instance shared across the process. There is no per-request construction.
- [AC-04.2] `clearMcpBridge()` calls `closeSession` for every active session before resetting internal state. Used by tests.
- [AC-04.3] `bridge.ts` is the **only** module that owns the singleton. `sessions.ts` imports `mcpBridge`; it does not construct `McpProcessManager` directly. *(Keeps the dispatch hook in T-05 minimal and reviewable.)*

**Tests.**
- [T-04.A] Importing `mcpBridge` twice from two test files returns the same instance (identity-equal).
- [T-04.B] `clearMcpBridge()` after a `call(...)` leaves `getActiveProcessCount() === 0`.

---

### T-05 — Wire MCP dispatch into the execute route

**Goal.** Make `POST /sessions/:id/execute` recognise `prefix/tool` names, validate the prefix, and dispatch via `mcpBridge`. Built-in path is unchanged.

**Files touched.**
- `packages/core/src/server/routes/sessions.ts` — add an MCP dispatch branch in the execute handler. Imports `mcpBridge` from `../../mcp/index.js`.

**Acceptance criteria.**
- [AC-05.1] Dispatch order in the execute handler is exactly:
  1. If `toolName.includes("/")` → MCP path: split on **first** `/`, validate prefix in `session.servers`, call `mcpBridge.call(sessionId, prefix, rest, input)`, return the resulting `ToolResult` shape.
  2. Else if `BUILT_IN_TOOLS.has(toolName)` → existing `executeBuiltIn` path (unchanged).
  3. Else → existing `Tool not registered` shape (unchanged). *(Implements **C6**.)*
- [AC-05.2] The split is on the **first** `/` only — `toolName.indexOf("/")` then `slice`. A name like `nuvem-fiscal/foo/bar` resolves to `prefix="nuvem-fiscal"`, `tool="foo/bar"`. *(Implements **C6**.)*
- [AC-05.3] If the prefix is not present in `session.servers`, the response is the existing `Tool not registered` shape (`success:false`, `error:"Tool not registered: <full-name>"`, all other fields preserved). HTTP status code stays 200 — **not** 403. *(Implements **C6**.)*
- [AC-05.4] Names without `/` skip the MCP path entirely. The `executeBuiltIn` and unknown-tool branches are byte-for-byte the same as on `main` for those names. *(Implements **C6**.)*
- [AC-05.5] The dispatch hook does not import from `process-manager.ts` or `registry.ts` directly — only from `mcp/index.ts` (the public boundary). *(Implements **C7**.)*

**Tests.**
- `packages/core/src/server/routes/__tests__/sessions-mcp.test.ts` (new) — uses Fastify in-process the way `a2a.test.ts` does, plus a helper that points the registry at a test-only `mcp-servers.json` whose entries spawn the T-02 fixture.
  - [T-05.A] Tool name `echo/ping` with `session.servers=["echo"]` → bridge invoked, response shape matches `ToolResult` with `success:true`. *(Verifies **C6** happy path.)*
  - [T-05.B] Tool name `echo/ping` with `session.servers=[]` → response is the `Tool not registered` shape, HTTP 200. *(Verifies **C6** prefix-not-in-servers branch — note: 200 + structured error, not 403.)*
  - [T-05.C] Tool name `nuvem-fiscal/foo/bar` with `session.servers=["nuvem-fiscal"]` → bridge invoked with `serverId="nuvem-fiscal"` and `tool="foo/bar"`. *(Verifies first-`/` split — **C6**.)*
  - [T-05.D] Tool name `codespar_list_tools` → existing built-in response is byte-identical to current `main`. (Snapshot or field-by-field equality.) *(Verifies **C6** built-in unchanged.)*
  - [T-05.E] Tool name `unknown_thing` (no `/`) → existing `Tool not registered` shape, byte-identical to current `main`. *(Verifies **C6** non-MCP unknown unchanged.)*

---

### T-06 — DELETE /sessions/:id terminates child processes

**Goal.** Tie process lifecycle to the existing session-close path.

**Files touched.**
- `packages/core/src/server/routes/sessions.ts` — DELETE handler awaits `mcpBridge.closeSession(id)` *before* responding 204.

**Acceptance criteria.**
- [AC-06.1] DELETE handler executes `await mcpBridge.closeSession(id)` and only then sets the in-memory session status to `"closed"` and replies 204. *(Implements **C5**.)*
- [AC-06.2] If `closeSession` rejects, the handler still marks the session closed (audit trail), logs the error, and replies 500 with the structured error code from `closeSession`. (No partial states.)

**Tests.** Extends `sessions-mcp.test.ts`:
- [T-06.A] Create session, dispatch `echo/ping` (spawns the fixture child), DELETE the session, then `process.kill(pid, 0)` on the child's pid throws `ESRCH`. *(Verifies **C5**.)*
- [T-06.B] Two sessions, each dispatches `echo/ping`. DELETE the first; the first child is dead, the second is alive. *(Verifies **C5** isolation.)*

---

### T-07 — Canonical validation script + README note

**Goal.** Ship the canonical integration check as an executable script in the repo and a one-paragraph note in the README. This is the script callers actually run with `MCP_DEMO=true` and a full `npm install` of the catalog packages.

**Files touched.**
- `scripts/validate-bridge.sh` (new, executable) — exact contents of the validation script in the source issue, with `set -euo pipefail`, env defaults `BASE_URL="${CODESPAR_BASE_URL:-http://localhost:3000}"`, the create-session / execute / cleanup curl chain, and the failure assertion that the response does **not** contain `Tool not registered`.
- `README.md` — short paragraph under a new "MCP bridge (demo / integration)" subsection: how to start the runtime with `MCP_DEMO=true`, how to run `scripts/validate-bridge.sh`, and the explicit statement that `MCP_DEMO` is set on the runtime parent process and inherited by child MCP servers — the bridge does not read it.

**Acceptance criteria.**
- [AC-07.1] `scripts/validate-bridge.sh` is executable (`chmod +x`) and matches the canonical script from the source issue verbatim except for the leading shebang/header comment that names the runtime. *(Implements **C4**.)*
- [AC-07.2] Script exits non-zero if and only if the execute response contains the literal string `Tool not registered`. No other failure-mode assertions added — this is the agreed canonical check. *(Implements **C4**.)*
- [AC-07.3] README note does not mention any internal roadmap document, design document, or external issue numbers. It refers only to this repo's runtime, the script path, and the `MCP_DEMO` parent-process convention. *(Self-containment requirement.)*

**Tests.**
- [T-07.A] Shellcheck passes on the script (or, if shellcheck is not in CI, an `npx vitest run` test that spawns `bash -n scripts/validate-bridge.sh` returns 0).
- No automated end-to-end run of the script in default CI — the script's whole point is the opt-in `MCP_DEMO=true` path with real catalog packages installed. *(Implements **C4**.)*

---

### T-08 — Source-level guard against `MCP_DEMO` regressions

**Goal.** A single small test that fails loudly if anyone ever adds `MCP_DEMO` (or a server-id `switch`) into the bridge source. Cheap to maintain, high-value as a tripwire.

**Files touched.**
- `packages/core/src/mcp/__tests__/source-invariants.test.ts` (new).

**Acceptance criteria.**
- [AC-08.1] Test reads `packages/core/src/mcp/process-manager.ts`, `packages/core/src/mcp/registry.ts`, and `packages/core/src/mcp/bridge.ts` from disk and asserts none contains the substring `MCP_DEMO`. *(Implements **C1**, **C2** as a regression tripwire.)*
- [AC-08.2] Test asserts `process-manager.ts` does not contain a hard-coded server-id allowlist by checking for the substrings `"asaas"`, `"nuvem-fiscal"`, `"z-api"` in the source — none should appear (those names live only in `mcp-servers.json` and tests). *(Implements **C1**.)*
- [AC-08.3] Test asserts `process-manager.ts` does not contain a hard-coded `"npx"` literal (the bridge does not auto-prefix). *(Implements **C1**.)*

**Tests.** Self — the test *is* the assertion. Failing this test should produce a clear error message naming the offending file and substring.

---

## Verification (single command, end of PR)

```bash
# Default test run — uses only the in-tree fixture, no catalog dependencies.
npx vitest run packages/core/src/mcp \
              packages/core/src/server/routes/__tests__/sessions-mcp.test.ts \
              tests/fixtures/__tests__/echo-mcp-server.test.ts
```

Manual / opt-in integration verification (per **C4**, requires `npm install -g @codespar/mcp-asaas` etc. and a running OSS runtime):

```bash
MCP_DEMO=true npm run start:server &  # in another shell
MCP_DEMO=true CODESPAR_BASE_URL=http://localhost:3000 bash scripts/validate-bridge.sh
```

## Constraint → task coverage matrix

| Constraint | Tasks that implement | Tests that verify |
|---|---|---|
| **C1** BRIDGE-IS-DATA-DRIVEN | T-01, T-03, T-08 | T-01.A, T-03.A, T-03.D, AC-08.1, AC-08.2, AC-08.3 |
| **C2** ENV-PASSTHROUGH-NOT-MERGE | T-03, T-08 | T-03.B, T-03.C, T-03.D, AC-08.1 |
| **C3** UNIT-TEST-WITH-STDIO-FIXTURE-CHILD | T-02, T-03, T-04, T-05 | All T-03.* and T-05.* use the fixture; AC-02.1 forbids external deps |
| **C4** INTEGRATION-TEST-WITH-REAL-MCP_DEMO | T-07 | AC-07.1, AC-07.2 |
| **C5** LIFECYCLE-TIED-TO-SESSION | T-03, T-06 | T-03.E, T-03.F, T-03.G, T-06.A, T-06.B |
| **C6** TOOL-NAME-PARSING-STRICT | T-05 | T-05.A, T-05.B, T-05.C, T-05.D, T-05.E |
| **C7** FORWARD-COMPAT-BOUNDARY-LOCKED | T-01, T-03, T-04, T-05 | T-01.B, T-01.C, T-03.L, AC-04.3, AC-05.5 |
| **C8a** STDERR-NOT-MIXED-INTO-RPC | T-02, T-03 | T-02.B, T-03.K, AC-03.10 |
| **C8b** PARSE-ERROR-IS-STRUCTURED | T-03 | T-03.I, AC-03.9 |
| **C8c** CRASH-MID-CALL-RESPAWNS | T-03 | T-03.H, AC-03.8 |
| **C8d** TIMEOUT-CANCELS-CALL-NOT-PROCESS | T-03 | T-03.J, AC-03.7 |

Every constraint listed in §"Design constraints" has at least one acceptance criterion and at least one test. Every task identifies which constraints it implements.

## Open questions for coordinator

1. **`mcp-servers.json` location.** T-01 loads it from `process.cwd()`. The runtime's `process.cwd()` in the typical `npm run start:server` flow is the repo root, so this works. If self-hosters launch from elsewhere, an env override (e.g. `CODESPAR_MCP_SERVERS_PATH`) would be cheap to add — but the source issue does not mandate one and it would be net-new public surface. **Recommendation:** ship without an override in this PR; add one only if a real self-host workflow needs it.
2. **`getActiveProcessCount()` exposed for tests only.** It leaks an internal cache size for debugging. Documented as test-only with a `@internal` JSDoc tag. **Question:** acceptable, or should the tests use a different observability hook (e.g. a counter on the structured logger)?
3. **`closeSession` failure mode.** AC-06.2 makes DELETE return 500 with a structured error if `closeSession` rejects. The alternative is "always 204, log the error" (graceful degradation, since the in-memory session is gone either way). **Recommendation:** 500 is the right call — silent-ignore is the failure mode that masks lifecycle bugs, which is exactly what **C5** is meant to prevent.
4. **First-fit on parse-error matching.** AC-03.9 / T-03.I match a parse-error reply to the oldest pending call (FIFO). With JSON-RPC 2.0 the `id` field is the canonical correlation, but a *parse* error means we don't have a parsable `id`. FIFO is a reasonable heuristic for stdio fixtures and `npx`-launched real servers (they don't multiplex), but it's a small correctness bet. **Recommendation:** ship FIFO with a comment, revisit if a real catalog server starts interleaving replies.

## What the plan deliberately does **not** include

- No catalog API endpoint (`/v1/servers`) — that is a future PR per the OSS roadmap.
- No connections vault — provider credentials still live in env vars, inherited via `process.env` per **C2**.
- No HTTP transport — `transport: "stdio"` is the only value defined; future transports are an additive change to `McpServerSpec`.
- No deduplication with the enterprise bridge — that is explicitly deferred per the source issue's tracking comment. The OSS bridge in this PR is the canonical OSS implementation; the enterprise side will eventually consume it, not the other way around.
