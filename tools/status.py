"""Diagnostic local du bridge, exécuté dans son conteneur sans afficher les secrets."""

import json
import os
import urllib.error
import urllib.request


def fetch(label: str, path: str, *, authenticated: bool = False) -> None:
    request = urllib.request.Request(f"http://127.0.0.1:8001{path}")
    if authenticated:
        key = os.getenv("BRIDGE_API_KEY")
        if key:
            request.add_header("Authorization", f"Bearer {key}")
    try:
        response = urllib.request.urlopen(request, timeout=3)
    except urllib.error.HTTPError as exc:
        response = exc
    except urllib.error.URLError as exc:
        print(f"{label}:")
        print(json.dumps({"status": "unreachable", "reason": type(exc.reason).__name__}))
        return
    with response:
        raw = response.read().decode("utf-8")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {"status": "invalid_response", "http_status": response.status}
    print(f"{label}:")
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))


fetch("health", "/health")
fetch("ready", "/ready")
fetch("capabilities", "/v1/bridge/capabilities", authenticated=True)
