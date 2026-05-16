#!/usr/bin/env bash
# Canonical OSS MCP bridge integration check.
#
# Exercises POST /sessions/:id/execute against a running OSS runtime
# with `MCP_DEMO=true` and at least one `@codespar/mcp-*` package
# installed (e.g. `npm install -g @codespar/mcp-asaas`). Asserts the
# response does NOT contain the literal string `Tool not registered`.
#
# `MCP_DEMO` is read by the runtime's parent process and inherited by
# child MCP servers via the bridge's env passthrough. The bridge source
# itself does not read `MCP_DEMO`.

set -euo pipefail

BASE_URL="${CODESPAR_BASE_URL:-http://localhost:3000}"
TOKEN="${ENGINE_API_TOKEN:-test}"
SERVER_ID="${MCP_BRIDGE_SERVER_ID:-asaas}"
TOOL_NAME="${MCP_BRIDGE_TOOL_NAME:-${SERVER_ID}/health}"

echo "validate-bridge: BASE_URL=$BASE_URL server=$SERVER_ID tool=$TOOL_NAME"

create_response="$(curl -sS -f -X POST "$BASE_URL/sessions" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"servers\":[\"$SERVER_ID\"],\"user_id\":\"validate-bridge\"}")"

session_id="$(printf '%s' "$create_response" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
if [ -z "$session_id" ]; then
    echo "validate-bridge: failed to parse session id from: $create_response" >&2
    exit 1
fi
echo "validate-bridge: created session $session_id"

execute_response="$(curl -sS -X POST "$BASE_URL/sessions/$session_id/execute" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"tool\":\"$TOOL_NAME\",\"input\":{}}")"

echo "validate-bridge: execute response: $execute_response"

curl -sS -X DELETE "$BASE_URL/sessions/$session_id" \
    -H "Authorization: Bearer $TOKEN" >/dev/null || true
echo "validate-bridge: cleaned up session $session_id"

if printf '%s' "$execute_response" | grep -q "Tool not registered"; then
    echo "validate-bridge: FAILED — response contained 'Tool not registered'" >&2
    exit 1
fi

echo "validate-bridge: OK — bridge dispatched the tool call without falling through to 'Tool not registered'"
