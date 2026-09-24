#!/usr/bin/env bash
# Smoke opérateur : un run natif minuscule à travers le vrai navigateur.
#
#   BRIDGE_API_KEY=... tools/smoke_chatgpt_bridge.sh [base_url]
#
# - lit la clé depuis BRIDGE_API_KEY, ne l'imprime jamais et ne la passe
#   jamais en argument de commande (elle n'apparaît pas dans `ps`) ;
# - envoie « Reply with exactly: BRIDGE_OK » sur POST /v1/bridge/runs ;
# - affiche le statut HTTP, la durée, puis soit la correspondance de la
#   réponse, soit le code d'erreur et son diagnostic DOM borné.
#
# Chaque appel utilise une clé d'idempotence neuve : relancer le script
# soumet un nouveau prompt, jamais un rejeu du précédent.
set -euo pipefail

BASE_URL="${1:-${BRIDGE_URL:-http://127.0.0.1:8001}}"
BASE_URL="${BASE_URL%/}"
TIMEOUT="${BRIDGE_SMOKE_TIMEOUT:-300}"

command -v curl >/dev/null || { echo "curl est requis" >&2; exit 2; }
command -v python3 >/dev/null || { echo "python3 est requis" >&2; exit 2; }

body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT

idempotency_key="smoke-$(date +%s)-$$-$RANDOM"
payload='{"input":"Reply with exactly: BRIDGE_OK","requested_model":"bridge-smoke"}'

# L'en-tête Authorization est lu sur stdin (`-H @-`) : printf est un builtin,
# la clé ne passe donc par aucun argv visible.
auth_header=""
if [[ -n "${BRIDGE_API_KEY:-}" ]]; then
  auth_header="Authorization: Bearer ${BRIDGE_API_KEY}"
else
  echo "BRIDGE_API_KEY absent : requête sans authentification (écoute locale uniquement)" >&2
fi

started=$(date +%s.%N)
set +e
http_status=$(
  printf '%s\n' "$auth_header" | curl --silent --show-error \
    --max-time "$TIMEOUT" \
    --output "$body_file" \
    --write-out '%{http_code}' \
    -H @- \
    -H "Content-Type: application/json" \
    -H "X-Idempotency-Key: ${idempotency_key}" \
    --data "$payload" \
    "${BASE_URL}/v1/bridge/runs"
)
curl_exit=$?
set -e
elapsed=$(python3 -c "import sys; print(f'{float(sys.argv[2]) - float(sys.argv[1]):.1f}')" "$started" "$(date +%s.%N)")

echo "endpoint:    ${BASE_URL}/v1/bridge/runs"
echo "http_status: ${http_status:-000}"
echo "elapsed_s:   ${elapsed}"
if [[ $curl_exit -ne 0 ]]; then
  echo "transport:   curl exit ${curl_exit} (serveur injoignable ou délai ${TIMEOUT}s dépassé)"
  exit 1
fi

# Résumé sûr : aucun texte de réponse n'est affiché au-delà de la
# correspondance exacte attendue, et seuls des champs de diagnostic fixes.
python3 - "$body_file" "$http_status" <<'PY'
import json
import sys

path, status = sys.argv[1], int(sys.argv[2])
try:
    with open(path, encoding="utf-8") as handle:
        body = json.load(handle)
except (OSError, ValueError):
    print("body:        illisible (non JSON)")
    sys.exit(1)

if 200 <= status < 300 and body.get("status") == "completed":
    text = (body.get("output_text") or "").strip()
    print(f"run_id:      {body.get('id')}")
    print(f"reply_match: {text == 'BRIDGE_OK'} ({len(text)} chars)")
    sys.exit(0 if text == "BRIDGE_OK" else 1)

error = body.get("error") if isinstance(body.get("error"), dict) else {}
details = error.get("details") if isinstance(error.get("details"), dict) else {}
dom = details.get("dom_health") if isinstance(details.get("dom_health"), dict) else {}
print(f"run_status:  {body.get('status', '-')}")
for field in ("code", "phase", "submission_state", "retryable"):
    print(f"{field}: {error.get(field, '-')}")
if details.get("ui_contract_error"):
    print(f"ui_contract: {details['ui_contract_error']}")
if dom:
    safe = {
        "content_script_version": dom.get("content_script_version"),
        "composer": {
            key: (dom.get("composer") or {}).get(key)
            for key in ("status", "strategy", "selector", "visible_candidates")
        },
        "send": {
            key: (dom.get("send") or {}).get(key)
            for key in ("status", "strategy", "selector", "visible_candidates")
        },
    }
    print("dom_health:  " + json.dumps(safe, ensure_ascii=False))
sys.exit(1)
PY
