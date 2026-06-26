#!/usr/bin/env python3
"""
example_worker_documented.py
============================

But de ce fichier
-----------------
Servir d'exemple / modèle à un développeur Python qui doit communiquer
avec un programme C++ via :

1) un mode one-shot (appel avec arguments CLI)
2) un mode persistant par pipe JSON (stdin / stdout)

Ce fichier montre très explicitement :
- comment LIRE les données envoyées par le C++
- comment ÉCRIRE les données à destination du C++
- quelles conventions il est conseillé de respecter

-------------------------------------------------------------------------------
RÈGLE LA PLUS IMPORTANTE
-------------------------------------------------------------------------------
stdout = canal du protocole C++ <-> Python
stderr = logs humains / debug

Donc :
- pour répondre au C++ : utiliser emit_json(...)
- pour logger : utiliser log_err(...)
- éviter les print(...) classiques sur stdout

-------------------------------------------------------------------------------
MODES DISPONIBLES
-------------------------------------------------------------------------------
A) Mode one-shot CLI
   Exemple :
       python3 -u example_worker_documented.py add 4 5 6
       python3 -u example_worker_documented.py norm2 3 4
       python3 -u example_worker_documented.py echo hello world

   Dans ce mode, le C++ lance Python, attend UNE réponse, puis le process
   Python se termine.

B) Mode pipe JSON persistant
   Exemple :
       python3 -u example_worker_documented.py --pipe

   Le C++ garde le process Python vivant et lui envoie plusieurs requêtes JSON.
   Le script lit une requête, calcule une réponse, renvoie une ligne JSON,
   puis attend la requête suivante.

-------------------------------------------------------------------------------
EXEMPLES DE REQUÊTES JSON VENANT DU C++ EN MODE PIPE
-------------------------------------------------------------------------------
1) ping
   {"cmd":"ping"}

2) somme
   {"cmd":"add","values":[1,2,3,4]}

3) norme euclidienne
   {"cmd":"norm2","values":[3,4]}

4) détection fictive pour test
   {"cmd":"detect_mock"}

5) arrêt propre du worker
   {"cmd":"quit"}

-------------------------------------------------------------------------------
EXEMPLES DE RÉPONSES JSON ENVOYÉES AU C++
-------------------------------------------------------------------------------
{"ok":true,"reply":"pong"}
{"ok":true,"result":10.0}
{"ok":false,"error":"unknown_cmd: xyz"}

-------------------------------------------------------------------------------
CONSEIL DE PROTOCOLE
-------------------------------------------------------------------------------
Le plus simple côté Python est généralement :
- lire req["cmd"]
- dispatcher selon la commande
- toujours renvoyer un dict JSON avec :
    - ok = True/False
    - puis les données utiles

Exemple de bonne réponse :
    return {
        "ok": True,
        "label": "ball",
        "confidence": 0.92,
    }
"""

from __future__ import annotations

import argparse
import math
import sys
from typing import Any

# Helper standard fourni avec l'exemple.
# C'est lui qui gère les entrées / sorties JSON proprement.
from catj_py_helper import emit_json, log_err, serve_json_loop


# -----------------------------------------------------------------------------
# MODE 1 : appel one-shot par arguments de ligne de commande
# -----------------------------------------------------------------------------
# Dans ce mode, le programme C++ peut lancer Python comme ceci :
#     python3 -u example_worker_documented.py add 4 5 6
# puis lire la réponse JSON sur stdout.
# -----------------------------------------------------------------------------
def cli_mode(argv: list[str]) -> int:
    """
    Point d'entrée pour le mode CLI / one-shot.

    Ce mode est utile si :
    - on veut un calcul ponctuel
    - on ne veut pas garder un process Python vivant
    - on veut quelque chose de très simple à déclencher depuis C++
    """
    parser = argparse.ArgumentParser(
        description="Example worker Python piloté depuis C++"
    )
    parser.add_argument(
        "command",
        choices=["add", "norm2", "echo"],
        help="commande à exécuter en mode one-shot",
    )
    parser.add_argument(
        "values",
        nargs="*",
        help="valeurs supplémentaires (chaînes ou nombres selon la commande)",
    )
    args = parser.parse_args(argv)

    log_err("[worker][cli] command=", args.command, "values=", args.values)

    if args.command == "add":
        vals = [float(v) for v in args.values]

        # On répond au C++ en JSON.
        emit_json(
            {
                "ok": True,
                "mode": "cli",
                "command": "add",
                "inputs": vals,
                "result": sum(vals),
            }
        )
        return 0

    if args.command == "norm2":
        vals = [float(v) for v in args.values]
        emit_json(
            {
                "ok": True,
                "mode": "cli",
                "command": "norm2",
                "inputs": vals,
                "result": math.sqrt(sum(v * v for v in vals)),
            }
        )
        return 0

    # echo : on renvoie simplement les valeurs telles quelles
    emit_json(
        {
            "ok": True,
            "mode": "cli",
            "command": "echo",
            "inputs": args.values,
            "result": args.values,
        }
    )
    return 0


# -----------------------------------------------------------------------------
# MODE 2 : mode persistant par pipe JSON
# -----------------------------------------------------------------------------
# Ici, le C++ lance par exemple :
#     python3 -u example_worker_documented.py --pipe
# puis il envoie plusieurs lignes JSON sur stdin.
# Le helper lit chaque ligne, appelle pipe_handler(req), et renvoie la réponse
# sur stdout en JSON.
# -----------------------------------------------------------------------------
def pipe_handler(req: dict[str, Any]) -> dict[str, Any]:
    """
    Handler principal du mode pipe.

    Paramètre :
    -----------
    req = dictionnaire Python construit à partir du JSON reçu depuis le C++.

    Exemple : si le C++ envoie la ligne suivante :
        {"cmd":"add","values":[1,2,3]}

    alors ici on recevra :
        req == {"cmd": "add", "values": [1, 2, 3]}

    Ce qu'il faut faire dans cette fonction :
    -----------------------------------------
    1) lire les champs de req
    2) exécuter le traitement voulu
    3) retourner un dict Python

    Ce dict sera automatiquement converti en JSON et renvoyé au C++.
    """
    cmd = str(req.get("cmd", ""))

    # Log développeur -> stderr uniquement
    log_err("[worker][pipe] received cmd=", cmd, "req=", req)

    # -----------------------------------------------------------------
    # Exemple 1 : handshake simple
    # Requête C++  : {"cmd":"ping"}
    # Réponse Py   : {"ok":true,"reply":"pong"}
    # -----------------------------------------------------------------
    if cmd == "ping":
        return {
            "ok": True,
            "reply": "pong",
            "mode": "pipe",
        }

    # -----------------------------------------------------------------
    # Exemple 2 : somme
    # Requête C++ : {"cmd":"add","values":[1,2,3,4]}
    # -----------------------------------------------------------------
    if cmd == "add":
        values = req.get("values", [])
        numeric_values = [float(v) for v in values]

        return {
            "ok": True,
            "cmd": "add",
            "inputs": numeric_values,
            "result": sum(numeric_values),
        }

    # -----------------------------------------------------------------
    # Exemple 3 : norme euclidienne
    # Requête C++ : {"cmd":"norm2","values":[3,4]}
    # Réponse     : {"ok":true,"result":5.0}
    # -----------------------------------------------------------------
    if cmd == "norm2":
        values = req.get("values", [])
        numeric_values = [float(v) for v in values]

        return {
            "ok": True,
            "cmd": "norm2",
            "inputs": numeric_values,
            "result": math.sqrt(sum(v * v for v in numeric_values)),
        }

    # -----------------------------------------------------------------
    # Exemple 4 : écho / debug
    # Utile pour vérifier que le payload reçu est correct.
    # -----------------------------------------------------------------
    if cmd == "echo":
        return {
            "ok": True,
            "cmd": "echo",
            "received": req,
        }

    # -----------------------------------------------------------------
    # Exemple 5 : mock orienté robot / vision
    # Ce bloc montre à quoi peut ressembler une réponse plus riche.
    # -----------------------------------------------------------------
    if cmd == "detect_mock":
        return {
            "ok": True,
            "cmd": "detect_mock",
            "detected": True,
            "label": "ball",
            "confidence": 0.92,
            "cx": 318,
            "cy": 201,
            "bbox": {
                "x": 280,
                "y": 170,
                "w": 76,
                "h": 62,
            },
        }

    # -----------------------------------------------------------------
    # Exemple 6 : télémétrie simulée
    # Ce type de réponse est pratique pour définir un contrat d'interface.
    # -----------------------------------------------------------------
    if cmd == "telemetry_mock":
        return {
            "ok": True,
            "cmd": "telemetry_mock",
            "telemetry": {
                "heading_deg": 124.5,
                "roll_deg": 2.1,
                "pitch_deg": -1.4,
                "yaw_rate_dps": 11.2,
                "battery_v": 14.8,
                "left_motor_pct": 35,
                "right_motor_pct": 37,
            },
        }

    # -----------------------------------------------------------------
    # Exemple 7 : arrêt propre du worker Python
    # Convention : on renvoie stop=True pour dire au helper d'arrêter la boucle.
    # -----------------------------------------------------------------
    if cmd == "quit":
        return {
            "ok": True,
            "cmd": "quit",
            "message": "python worker stopping",
            "stop": True,
        }

    # -----------------------------------------------------------------
    # Commande inconnue
    # Toujours renvoyer quelque chose de propre au C++.
    # -----------------------------------------------------------------
    return {
        "ok": False,
        "error": f"unknown_cmd: {cmd}",
        "known_commands": [
            "ping",
            "add",
            "norm2",
            "echo",
            "detect_mock",
            "telemetry_mock",
            "quit",
        ],
    }


# -----------------------------------------------------------------------------
# MAIN
# -----------------------------------------------------------------------------
def main() -> int:
    """
    Sélectionne automatiquement le mode de fonctionnement.

    - si '--pipe' est présent : mode persistant stdin/stdout JSON
    - sinon : mode CLI one-shot
    """
    if "--pipe" in sys.argv:
        log_err("[worker] starting in PIPE mode")
        return serve_json_loop(pipe_handler)

    log_err("[worker] starting in CLI mode")
    return cli_mode(sys.argv[1:])


if __name__ == "__main__":
    raise SystemExit(main())
