#!/usr/bin/env bash
# Session mocks — runnable end-to-end demonstration.
#
# Creates a session with a mocks store declared, executes both a
# single-shot and a stateful-array mocked tool, demonstrates the
# `mocks_exhausted` envelope by walking the array past its cap, and
# demonstrates the strict-mode `tool_not_mocked` envelope by calling
# an undeclared tool. Cleans up at the end.
#
# Requires a running OSS runtime started with the test-mode flag on:
#   CODESPAR_TEST_MODE_ENABLED=true npm run start:server
#
# Without that flag the runtime rejects any request with `mocks` and
# returns HTTP 501 `mocks_not_permitted`.
#
# Usage:
#   CODESPAR_TEST_MODE_ENABLED=true bash examples/session-mocks.sh
#
# Environment overrides:
#   CODESPAR_BASE_URL            default http://localhost:3000
#   ENGINE_API_TOKEN             the runtime's API credential. Unset, this
#                                script reads it from the runtime's state
#                                directory (see resolve_token below).
#   CODESPAR_TEST_MODE_ENABLED   must be truthy on the SERVER process for
#                                this script to succeed; setting it on the
#                                client (this script) has no effect on the
#                                runtime's gate.

set -euo pipefail

BASE_URL="${CODESPAR_BASE_URL:-http://localhost:3000}"
# Resolve the runtime's API credential the way any local client should:
# ENGINE_API_TOKEN if the operator set one, otherwise the token the runtime
# generated for itself on first boot. There is no default value to fall back
# to -- an empty token means this script cannot authenticate, and saying so
# here beats a confusing 401 later.
resolve_token() {
    if [ -n "${ENGINE_API_TOKEN:-}" ]; then
        printf '%s' "$ENGINE_API_TOKEN"
        return 0
    fi
    for candidate in "${CODESPAR_STATE_DIR:-}" "${PWD}/.codespar" "${HOME}/.codespar"; do
        [ -n "$candidate" ] || continue
        if [ -r "$candidate/api-token" ]; then
            tr -d '[:space:]' < "$candidate/api-token"
            return 0
        fi
    done
    echo "could not find an API token." >&2
    echo "Set ENGINE_API_TOKEN, or point CODESPAR_STATE_DIR at the runtime's" >&2
    echo "state directory. Inside Docker:" >&2
    echo "  export ENGINE_API_TOKEN=\$(docker compose exec -T core cat /app/.codespar/api-token)" >&2
    return 1
}

TOKEN="$(resolve_token)"

header_auth=(-H "Authorization: Bearer $TOKEN")
header_json=(-H "Content-Type: application/json")

echo "session-mocks: BASE_URL=$BASE_URL"

# ---------------------------------------------------------------------------
# 1. Create a session with a mocks store declared.
#
# - `asaas/create_payment` is a single-shot object — every call returns
#   the same payload, no counter advances.
# - `asaas/get_payment` is a stateful array — call 1 returns PENDING,
#   call 2 returns CONFIRMED, call 3 returns mocks_exhausted.
# ---------------------------------------------------------------------------

create_response="$(curl -sS -f -X POST "$BASE_URL/sessions" \
    "${header_auth[@]}" "${header_json[@]}" \
    -d '{
      "user_id": "session-mocks-demo",
      "servers": ["asaas"],
      "mocks": {
        "asaas/create_payment": { "id": "pay_test_42", "status": "PENDING" },
        "asaas/get_payment": [
          { "id": "pay_test_42", "status": "PENDING" },
          { "id": "pay_test_42", "status": "CONFIRMED" }
        ]
      }
    }')"

session_id="$(printf '%s' "$create_response" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
if [ -z "$session_id" ]; then
    echo "session-mocks: failed to parse session id from: $create_response" >&2
    exit 1
fi
echo "session-mocks: created session $session_id"

cleanup() {
    curl -sS -X DELETE "$BASE_URL/sessions/$session_id" \
        "${header_auth[@]}" >/dev/null || true
    echo "session-mocks: cleaned up session $session_id"
}
trap cleanup EXIT

execute() {
    local tool="$1"
    local input="${2:-{}}"
    curl -sS -X POST "$BASE_URL/sessions/$session_id/execute" \
        "${header_auth[@]}" "${header_json[@]}" \
        -d "{\"tool\":\"$tool\",\"input\":$input}"
}

# ---------------------------------------------------------------------------
# 2. Single-shot mock — call it twice, observe the same payload both times.
# ---------------------------------------------------------------------------
echo "--- single-shot: asaas/create_payment (call 1)"
execute "asaas/create_payment" '{"amount":500}'
echo
echo "--- single-shot: asaas/create_payment (call 2 — same payload)"
execute "asaas/create_payment" '{"amount":500}'
echo

# ---------------------------------------------------------------------------
# 3. Stateful array — call N returns entry N, counter advances on success.
# ---------------------------------------------------------------------------
echo "--- stateful: asaas/get_payment (call 1 — PENDING)"
execute "asaas/get_payment"
echo
echo "--- stateful: asaas/get_payment (call 2 — CONFIRMED)"
execute "asaas/get_payment"
echo

# ---------------------------------------------------------------------------
# 4. Walk the array past its cap — the third call returns mocks_exhausted.
# ---------------------------------------------------------------------------
echo "--- stateful: asaas/get_payment (call 3 — mocks_exhausted)"
execute "asaas/get_payment"
echo

# ---------------------------------------------------------------------------
# 5. Test mode is strict — call an undeclared tool, observe tool_not_mocked.
#
# In test mode the runtime requires a matching mock for every external
# dispatch. A typo in the tool name (or any other undeclared call)
# surfaces here as `tool_not_mocked` — the runtime never falls through
# to a real MCP server. This is per-deployment, not per-session: a
# session created without any `mocks` field at all behaves the same
# way, every call returns tool_not_mocked.
# ---------------------------------------------------------------------------
echo "--- test mode: asaas/create_paymnet (typo — tool_not_mocked)"
execute "asaas/create_paymnet"
echo

echo "session-mocks: OK"
