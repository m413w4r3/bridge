"""Test de bout en bout : streaming + non-streaming, via le SDK openai.

    pip install openai
    python examples/test_client.py "ta question"
    BRIDGE_PORT=8001 python examples/test_client.py
"""

import os
import sys

from openai import OpenAI

HOST = os.getenv("BRIDGE_HOST", "127.0.0.1")
PORT = os.getenv("BRIDGE_PORT", "8000")
BASE_URL = os.getenv("BRIDGE_URL", f"http://{HOST}:{PORT}/v1")

client = OpenAI(base_url=BASE_URL, api_key=os.getenv("BRIDGE_API_KEY", "pas-de-cle"))

QUESTION = sys.argv[1] if len(sys.argv) > 1 else "Raconte-moi une blague courte."
print(f"→ {BASE_URL}\n")

print("── non-streaming ──")
resp = client.chat.completions.create(
    model="chatgpt-web",
    messages=[{"role": "user", "content": QUESTION}],
)
print(resp.choices[0].message.content)

print("\n── streaming ──")
stream = client.chat.completions.create(
    model="chatgpt-web",
    messages=[{"role": "user", "content": QUESTION}],
    stream=True,
    extra_body={"new_chat": True},
)
for chunk in stream:
    piece = chunk.choices[0].delta.content
    if piece:
        print(piece, end="", flush=True)
print()
