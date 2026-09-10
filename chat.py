#!/usr/bin/env python3
"""Client en ligne de commande pour le Mini-Bridge.

Envoie un prompt, affiche la réponse en flux, joint des fichiers et récupère
les sorties. Aucune dépendance : uniquement la bibliothèque standard.

    ./chat.py "Explique-moi les décorateurs Python"
    ./chat.py -f notes.txt -f schema.png "Résume ces documents"
    cat rapport.md | ./chat.py "Fais-en une synthèse en 5 points"
    ./chat.py --new "Écris un script de backup" --save-code ./out
    ./chat.py "..." --out reponse.md

Configuration : BRIDGE_HOST, BRIDGE_PORT, BRIDGE_URL, BRIDGE_API_KEY.
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import re
import select
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Iterator, List, Optional

DEFAULT_URL = os.getenv(
    "BRIDGE_URL",
    f"http://{os.getenv('BRIDGE_HOST', '127.0.0.1')}:{os.getenv('BRIDGE_PORT', '8001')}",
)

# Extensions dont le contenu est injecté dans le prompt plutôt qu'uploadé :
# c'est plus fiable (aucune dépendance à l'UI) et souvent ce que l'on veut.
TEXT_SUFFIXES = {
    ".txt", ".md", ".markdown", ".rst", ".csv", ".tsv", ".json", ".yaml", ".yml",
    ".toml", ".ini", ".cfg", ".conf", ".env", ".log", ".sql", ".html", ".htm",
    ".xml", ".css", ".scss", ".js", ".jsx", ".ts", ".tsx", ".py", ".rb", ".go",
    ".rs", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".sh",
    ".bash", ".zsh", ".fish", ".ps1", ".lua", ".r", ".jl", ".vue", ".svelte",
}

CODE_EXTENSIONS = {
    "python": "py", "py": "py", "javascript": "js", "js": "js", "typescript": "ts",
    "ts": "ts", "tsx": "tsx", "jsx": "jsx", "bash": "sh", "sh": "sh", "shell": "sh",
    "zsh": "sh", "json": "json", "yaml": "yml", "yml": "yml", "html": "html",
    "css": "css", "sql": "sql", "go": "go", "rust": "rs", "rs": "rs", "java": "java",
    "c": "c", "cpp": "cpp", "csharp": "cs", "php": "php", "ruby": "rb", "toml": "toml",
    "dockerfile": "Dockerfile", "markdown": "md", "md": "md", "xml": "xml",
}


class BridgeError(RuntimeError):
    pass


# --------------------------------------------------------------------------- #
# Pièces jointes
# --------------------------------------------------------------------------- #
def looks_textual(path: Path) -> bool:
    if path.suffix.lower() in TEXT_SUFFIXES:
        return True
    try:
        chunk = path.read_bytes()[:4096]
    except OSError:
        return False
    if b"\x00" in chunk:
        return False
    try:
        chunk.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


def as_openai_block(path: Path) -> dict:
    """Bloc de contenu au format standard de l'API OpenAI.

    Les images passent par `image_url`, tout le reste par `file` — exactement
    ce qu'attend l'API officielle, et ce que le serveur sait désormais lire.
    """
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    uri = f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode("ascii")
    if mime.startswith("image/"):
        return {"type": "image_url", "image_url": {"url": uri}}
    return {"type": "file", "file": {"filename": path.name, "file_data": uri}}


def prepare_files(
    paths: List[str], mode: str, max_inline: int
) -> tuple[str, List[dict], List[str]]:
    """Répartit les fichiers entre texte injecté dans le prompt et pièce jointe.

    Un fichier texte court est injecté (le modèle le voit directement) ; au-delà
    de `max_inline` octets il devient une pièce jointe, pour ne pas payer son
    contenu en tokens à chaque requête.
    """
    inlined: List[str] = []
    blocks: List[dict] = []
    joints: List[str] = []

    for raw in paths:
        path = Path(raw).expanduser()
        if not path.is_file():
            raise BridgeError(f"fichier introuvable : {path}")

        textual = looks_textual(path)
        if mode == "inline" and not textual:
            raise BridgeError(f"{path.name} est binaire : utilise --upload")

        trop_gros = path.stat().st_size > max_inline
        if mode == "upload" or (mode == "auto" and (not textual or trop_gros)):
            blocks.append(as_openai_block(path))
            joints.append(f"{path.name} ({path.stat().st_size} o)")
        else:
            lang = path.suffix.lstrip(".") if path.suffix else ""
            body = path.read_text(encoding="utf-8", errors="replace")
            inlined.append(f"--- {path.name} ---\n```{lang}\n{body.rstrip()}\n```")

    return ("\n\n".join(inlined), blocks, joints)


# --------------------------------------------------------------------------- #
# Appel HTTP
# --------------------------------------------------------------------------- #
def post(url: str, payload: dict, api_key: Optional[str], timeout: float):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        try:
            detail = json.loads(detail)["error"]["message"]
        except Exception:
            pass
        raise BridgeError(f"HTTP {exc.code} : {detail}") from None
    except urllib.error.URLError as exc:
        raise BridgeError(
            f"serveur injoignable sur {url} ({exc.reason}). Lance `python server.py`."
        ) from None


def stream_answer(resp) -> Iterator[str]:
    """Décode le flux SSE renvoyé par /v1/chat/completions."""
    for raw in resp:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data: "):
            continue
        data = line[6:]
        if data == "[DONE]":
            return
        packet = json.loads(data)
        if "error" in packet:
            raise BridgeError(packet["error"]["message"])
        piece = packet["choices"][0]["delta"].get("content")
        if piece:
            yield piece


# --------------------------------------------------------------------------- #
# Sorties
# --------------------------------------------------------------------------- #
def save_code_blocks(answer: str, out_dir: Path) -> List[Path]:
    """Écrit chaque bloc ``` de la réponse dans un fichier séparé."""
    blocks = re.findall(r"```([\w+-]*)\n(.*?)```", answer, re.DOTALL)
    if not blocks:
        return []
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for i, (lang, code) in enumerate(blocks, 1):
        ext = CODE_EXTENSIONS.get(lang.lower(), "txt")
        name = ext if ext == "Dockerfile" else f"bloc{i}.{ext}"
        target = out_dir / name
        target.write_text(code.rstrip() + "\n", encoding="utf-8")
        written.append(target)
    return written


def read_stdin(grace: float = 2.0) -> str:
    """Lit stdin s'il apporte quelque chose, sans jamais bloquer indéfiniment.

    Un `sys.stdin.read()` inconditionnel fige la commande quand stdin est un
    tube inactif (cron, CI, terminal d'éditeur) — sans le moindre message.
    """
    if sys.stdin.isatty():
        return ""
    try:
        pret, _, _ = select.select([sys.stdin], [], [], grace)
    except (OSError, ValueError):
        return ""
    if not pret:
        print("⚠️  stdin ouvert mais muet : entrée ignorée.", file=sys.stderr)
        return ""
    return sys.stdin.read().strip()


# --------------------------------------------------------------------------- #
def build_payload(args, prompt: str, blocks: List[dict]) -> dict:
    """Corps de requête au format OpenAI."""
    # Avec des pièces jointes, `content` devient une liste de blocs : c'est la
    # forme standard de l'API OpenAI, comprise telle quelle par le serveur.
    content: Any = prompt if not blocks else [{"type": "text", "text": prompt}, *blocks]
    messages = [{"role": "system", "content": args.system}] if args.system else []
    messages.append({"role": "user", "content": content})
    return {
        "model": args.model,
        "messages": messages,
        "stream": not args.no_stream and not args.json,
        "new_chat": args.new,
    }


def ask(args, payload: dict) -> str:
    """Envoie la requête, affiche la réponse, et la renvoie assemblée."""
    base = args.url.rstrip("/")
    if not base.endswith("/v1"):
        base += "/v1"
    resp = post(f"{base}/chat/completions", payload, args.key, args.timeout)

    if payload["stream"]:
        pieces = []
        for piece in stream_answer(resp):
            pieces.append(piece)
            print(piece, end="", flush=True)
        print()
        return "".join(pieces)

    body = json.loads(resp.read().decode("utf-8"))
    answer = body["choices"][0]["message"]["content"]
    print(json.dumps(body, ensure_ascii=False, indent=2) if args.json else answer)
    return answer


def deliver(args, answer: str) -> None:
    """Sorties optionnelles : fichier de réponse et extraction des blocs de code."""
    if args.out:
        Path(args.out).expanduser().write_text(answer, encoding="utf-8")
        print(f"💾 réponse → {args.out}", file=sys.stderr)

    if args.save_code:
        written = save_code_blocks(answer, Path(args.save_code).expanduser())
        if written:
            print(f"💾 {len(written)} bloc(s) → " + ", ".join(str(w) for w in written),
                  file=sys.stderr)
        else:
            print("ℹ️  aucun bloc de code dans la réponse", file=sys.stderr)


def main() -> int:
    p = argparse.ArgumentParser(
        description="Client CLI du ChatGPT Mini-Bridge.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("prompt", nargs="?", help="le prompt (sinon lu sur stdin)")
    p.add_argument("-f", "--file", action="append", default=[], metavar="CHEMIN",
                   help="pièce jointe (répétable)")
    p.add_argument("--mode", choices=["auto", "inline", "upload"], default="auto",
                   help="auto : texte court injecté dans le prompt, reste en pièce jointe (défaut)")
    p.add_argument("--max-inline", type=int, default=8192, metavar="OCTETS",
                   help="au-delà, un fichier texte devient pièce jointe au lieu d'être injecté "
                        "dans le prompt — économise les tokens (défaut : 8192)")
    p.add_argument("-s", "--system", help="message système à placer en tête")
    p.add_argument("-n", "--new", action="store_true", help="repart d'une conversation vierge")
    p.add_argument("-o", "--out", metavar="FICHIER", help="écrit la réponse dans un fichier")
    p.add_argument("--save-code", metavar="DOSSIER", help="extrait les blocs de code en fichiers")
    p.add_argument("--no-stream", action="store_true", help="attend la réponse complète")
    p.add_argument("--json", action="store_true", help="affiche la réponse JSON brute")
    p.add_argument("--model", default="chatgpt-web")
    p.add_argument("--url", default=DEFAULT_URL, help=f"base du serveur (défaut : {DEFAULT_URL})")
    p.add_argument("--key", default=os.getenv("BRIDGE_API_KEY"))
    p.add_argument("--timeout", type=float, default=900.0)
    args = p.parse_args()

    # Prompt : argument, stdin, ou les deux (stdin en contexte).
    parts = [x for x in (args.prompt, read_stdin()) if x]
    if not parts and not args.file:
        p.error("aucun prompt : passe-le en argument, sur stdin, ou joins un fichier")

    try:
        inlined, blocks, joints = prepare_files(args.file, args.mode, args.max_inline)
    except BridgeError as exc:
        print(f"❌ {exc}", file=sys.stderr)
        return 1
    if inlined:
        parts.append(inlined)
    if joints:
        print(f"📎 pièces jointes : {', '.join(joints)}", file=sys.stderr)

    try:
        answer = ask(args, build_payload(args, "\n\n".join(parts), blocks))
    except BridgeError as exc:
        print(f"❌ {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\n⏹  interrompu", file=sys.stderr)
        return 130

    deliver(args, answer)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BrokenPipeError:
        # Sortie fermée par le lecteur (`| head`, `| less` quitté) : on rebranche
        # stdout sur /dev/null pour que l'arrêt de l'interpréteur reste muet.
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        sys.exit(0)
