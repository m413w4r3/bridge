#!/bin/sh
set -eu

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-chatgpt-bridge-lifecycle}"
export BRIDGE_BIND_ADDRESS="${BRIDGE_BIND_ADDRESS:-127.0.0.1}"
export BRIDGE_PORT="${BRIDGE_PORT:-18001}"
export BRIDGE_API_KEY="${BRIDGE_API_KEY:-lifecycle-http-test-only}"
export BRIDGE_WS_TOKEN="${BRIDGE_WS_TOKEN:-lifecycle-websocket-test-only}"
export BRIDGE_SHUTDOWN_GRACE_SECONDS="${BRIDGE_SHUTDOWN_GRACE_SECONDS:-0.2}"

marker_path=/data/bridge-lifecycle-marker
marker_value=bridge-lifecycle-marker
ready_body_file=$(mktemp)
sigterm_output_file=$(mktemp)
client_pid=

compose() {
    docker compose -p "$COMPOSE_PROJECT_NAME" "$@"
}

cleanup() {
    if [ -n "$client_pid" ]; then
        kill "$client_pid" 2>/dev/null || true
    fi
    rm -f "$ready_body_file" "$sigterm_output_file"
    compose --profile bridge-test down -v --remove-orphans >/dev/null 2>&1 || true
}

trap cleanup EXIT

compose up -d --build --wait chatgpt-bridge

health_body=$(curl --fail --silent --show-error "http://127.0.0.1:${BRIDGE_PORT}/health")
case "$health_body" in
    *'"status":"ok"'*) ;;
    *)
        printf '%s\n' "$health_body" >&2
        exit 1
        ;;
esac

ready_status=$(curl --silent --show-error \
    --output "$ready_body_file" \
    --write-out '%{http_code}' \
    "http://127.0.0.1:${BRIDGE_PORT}/ready")
ready_body=$(cat "$ready_body_file")
if [ "$ready_status" != 503 ]; then
    printf 'unexpected /ready status: %s\n%s\n' "$ready_status" "$ready_body" >&2
    exit 1
fi
case "$ready_body" in
    *'"status":"extension_absent"'*) ;;
    *)
        printf 'unexpected /ready body: %s\n' "$ready_body" >&2
        exit 1
        ;;
esac

compose exec -T chatgpt-bridge sh -c \
    "printf '%s' '$marker_value' > '$marker_path'"
marker_before=$(compose exec -T chatgpt-bridge cat "$marker_path")
[ "$marker_before" = "$marker_value" ]

compose down
compose up -d --build --wait chatgpt-bridge

marker_after=$(compose exec -T chatgpt-bridge cat "$marker_path")
[ "$marker_after" = "$marker_value" ]

bridge_logs=$(compose logs --no-color chatgpt-bridge)
case "$bridge_logs" in
    *"$BRIDGE_API_KEY"*|*"$BRIDGE_WS_TOKEN"*)
        printf '%s\n' "$bridge_logs" >&2
        exit 1
        ;;
esac

request_id="bridge-lifecycle-sigterm-$(date +%s)"
compose --profile bridge-test run --rm --no-deps \
    -e BRIDGE_HTTP=http://chatgpt-bridge:8001/v1 \
    -e BRIDGE_WS=ws://chatgpt-bridge:8001/ws \
    -e BRIDGE_API_KEY="$BRIDGE_API_KEY" \
    -e BRIDGE_WS_TOKEN="$BRIDGE_WS_TOKEN" \
    -e SIGTERM_REQUEST_ID="$request_id" \
    bridge-soak python examples/sigterm_smoke.py active \
    >"$sigterm_output_file" 2>&1 &
client_pid=$!

attempt=0
while [ "$attempt" -lt 60 ]; do
    if grep -q 'prompt received' "$sigterm_output_file"; then
        break
    fi
    attempt=$((attempt + 1))
    sleep 1
done
if ! grep -q 'prompt received' "$sigterm_output_file"; then
    cat "$sigterm_output_file" >&2
    exit 1
fi

compose kill -s SIGTERM chatgpt-bridge
if ! wait "$client_pid"; then
    case "$(cat "$sigterm_output_file")" in
        *'prompt received'*'JSONDecodeError'*) ;;
        *)
            cat "$sigterm_output_file" >&2
            exit 1
            ;;
    esac
fi
client_pid=

compose up -d --build --wait chatgpt-bridge
compose --profile bridge-test run --rm --no-deps \
    -e BRIDGE_HTTP=http://chatgpt-bridge:8001/v1 \
    -e BRIDGE_WS=ws://chatgpt-bridge:8001/ws \
    -e BRIDGE_API_KEY="$BRIDGE_API_KEY" \
    -e BRIDGE_WS_TOKEN="$BRIDGE_WS_TOKEN" \
    -e SIGTERM_REQUEST_ID="$request_id" \
    bridge-soak python examples/sigterm_smoke.py replay

printf '%s\n' 'bridge compose lifecycle: health, readiness, volume persistence, logs, SIGTERM and replay OK'
