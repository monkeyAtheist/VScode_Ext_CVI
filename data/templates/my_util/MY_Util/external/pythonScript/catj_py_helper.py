"""
catj_py_helper.py
===========================

Petit helper standard pour communiquer entre un programme C++ et un script Python.

Philosophie retenue
-------------------
- Le programme C++ lance Python comme un processus externe.
- Les échanges C++ <-> Python se font via stdin / stdout.
- Le format d'échange retenu est : 1 objet JSON par ligne.

IMPORTANT
---------
- Tout ce que Python écrit sur stdout est considéré comme une donnée du protocole.
- Donc : NE PAS faire de print("debug...") sur stdout.
- Les logs / traces / erreurs humaines doivent aller sur stderr.

Concrètement :
- pour envoyer une réponse au C++  -> emit_json(...)
- pour lire une requête du C++     -> read_json()
- pour écrire un log développeur   -> log_err(...)

Exemple de ligne JSON transmise sur stdout :
    {"ok": true, "result": 42}

Cette ligne est terminée par '\n'.
Le C++ lit ensuite cette ligne et la parse.
"""

from __future__ import annotations

import json
import sys
from typing import Any, Callable


def log_err(*args: object) -> None:
    """
    Écrit un message de debug / log sur stderr.

    Pourquoi stderr ?
    -----------------
    Parce que stdout est réservé au protocole de communication avec le C++.
    Si tu fais un print() classique sur stdout, tu risques de casser le protocole.

    Exemple :
        log_err("model loaded")
        log_err("received frame", frame_id)
    """
    print(*args, file=sys.stderr, flush=True)


def emit_json(obj: Any) -> None:
    """
    Envoie un objet Python au programme C++ sous la forme d'une ligne JSON.

    Contrat :
    ---------
    - 1 réponse = 1 ligne JSON
    - la ligne est écrite sur stdout
    - flush=True pour forcer l'envoi immédiat

    Exemple :
        emit_json({"ok": True, "result": 123})

    Ce qui sort réellement sur stdout :
        {"ok":true,"result":123}\n
    Notes :
    -------
    ensure_ascii=False : garde les accents lisibles si besoin
    separators=(",", ":") : JSON compact, sans espaces inutiles
    """
    line = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def read_json() -> Any | None:
    """
    Lit UNE ligne JSON depuis stdin et la convertit en objet Python.

    Retour :
    --------
    - objet Python (dict, list, etc.) si une ligne valide a été lue
    - None si EOF (fin du pipe / processus C++ arrêté)

    Cas d'erreur :
    --------------
    Si la ligne reçue n'est pas du JSON valide, une ValueError est levée.

    Exemple :
        req = read_json()
        if req is None:
            # le C++ a fermé le pipe
            return
        cmd = req.get("cmd")
    """
    line = sys.stdin.readline()
    if line == "":
        # EOF : le C++ a fermé son côté du pipe ou le process se termine.
        return None

    line = line.strip()
    if not line:
        raise ValueError("empty JSON line received")

    try:
        return json.loads(line)
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON received: {exc.msg}") from exc


def serve_json_loop(handler: Callable[[dict[str, Any]], dict[str, Any]]) -> int:
    """
    Boucle serveur standard pour le mode pipe.

    Fonctionnement :
    ----------------
    1. lit une requête JSON envoyée par le C++
    2. appelle handler(req)
    3. renvoie la réponse JSON produite par le handler
    4. recommence jusqu'à EOF ou demande d'arrêt

    Signature attendue du handler :
        def handler(req: dict) -> dict:
            ...
            return {"ok": True, ...}

    Convention proposée :
    ---------------------
    - chaque requête contient un champ "cmd"
    - chaque réponse contient au minimum "ok": True/False
    - si erreur :
          {"ok": False, "error": "..."}

    Gestion des erreurs :
    ---------------------
    - toute exception Python est interceptée
    - une réponse JSON d'erreur est renvoyée au C++
    - le log détaillé part sur stderr

    Retour :
    --------
    0 si la boucle se termine proprement
    """
    while True:
        try:
            req = read_json()
        except Exception as exc:  # JSON invalide, ligne vide, etc.
            log_err("[helper] invalid input:", exc)
            emit_json({"ok": False, "error": str(exc)})
            continue

        if req is None:
            log_err("[helper] EOF received, stopping loop")
            return 0

        if not isinstance(req, dict):
            emit_json({"ok": False, "error": "request must be a JSON object"})
            continue

        try:
            response = handler(req)

            if response is None:
                response = {"ok": False, "error": "handler returned None"}
            elif not isinstance(response, dict):
                response = {
                    "ok": False,
                    "error": "handler must return a JSON object (Python dict)",
                }

            emit_json(response)

            # Convention facultative : si le handler renvoie stop=True,
            # on s'arrête après avoir envoyé la réponse.
            if isinstance(response, dict) and response.get("stop") is True:
                log_err("[helper] stop=True returned by handler")
                return 0

        except Exception as exc:
            log_err("[helper] exception in handler:", repr(exc))
            emit_json({"ok": False, "error": f"python_exception: {exc}"})


__all__ = [
    "emit_json",
    "read_json",
    "serve_json_loop",
    "log_err",
]
