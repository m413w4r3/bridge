"""Contract checks on how the standalone bridge is deployed and launched.

Pins `compose.yaml`/`Makefile`/`Dockerfile`/`tools/status.py`/`server.py`
invariants that protect the durable run registry (`bridge_data`), keep secrets
out of the repository and logs, and keep this repository self-contained.
Nothing here imports `bridge.*`: these are text-content assertions on the
repo's deployment files.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).parents[1]


def test_compose_and_launch_contract() -> None:
    compose = (ROOT / "compose.yaml").read_text()
    makefile = (ROOT / "Makefile").read_text()
    dockerfile = (ROOT / "Dockerfile").read_text()
    server = (ROOT / "server.py").read_text()
    status_script = (ROOT / "tools" / "status.py").read_text()

    assert "chatgpt-bridge:" in compose
    assert "bridge_data:/data" in compose
    assert "BRIDGE_RUN_DB: /data/bridge-runs.sqlite3" in compose
    assert "stop_grace_period: 30s" in compose
    assert "${BRIDGE_BIND_ADDRESS:-127.0.0.1}" in compose
    assert "BRIDGE_API_KEY: ${BRIDGE_API_KEY:-}" in compose
    assert "BRIDGE_WS_TOKEN: ${BRIDGE_WS_TOKEN:-}" in compose

    # Standalone: no client-application service, no path outside this repo.
    for service in ("postgres:", "redis:", "minio:", "backend:", "worker:", "frontend:"):
        assert service not in compose
    for text in (compose, dockerfile):
        assert "../" not in text
        assert "infra/" not in text

    # `make down` must never drop bridge_data.
    down_recipe = makefile.split("\ndown:\n", 1)[1].split("\n\n", 1)[0]
    assert "-v" not in down_recipe
    assert "python tools/status.py" in makefile

    assert 'os.getenv("BRIDGE_API_KEY")' in status_script
    assert "print(key)" not in status_script

    assert "access_log=False" in server
    assert 'log_level="warning"' in server
    assert "logger.propagate = False" in server


def test_default_total_timeout_allows_long_research() -> None:
    compose = (ROOT / "compose.yaml").read_text()

    match = re.search(
        r"\$\{BRIDGE_TOTAL_TIMEOUT:-([0-9.]+)\}",
        compose,
    )

    assert match
    assert float(match.group(1)) >= 3600
