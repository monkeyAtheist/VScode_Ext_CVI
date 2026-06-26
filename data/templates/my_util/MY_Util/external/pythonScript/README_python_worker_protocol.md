# Guide de communication Python <-> C++

Ce dossier contient un **helper Python** et un **worker d'exemple** à donner à un développeur Python pour qu'il sache exactement comment communiquer avec le programme C++.

## Fichiers

- `catj_py_helper_documented.py` : helper standard pour les échanges JSON par `stdin/stdout`
- `example_worker_documented.py` : exemple complet, très commenté

## Principe général

Le programme C++ lance le script Python comme un processus externe.

Deux modes sont possibles.

### 1. Mode one-shot

Le C++ exécute Python avec des arguments, attend une réponse JSON sur `stdout`, puis le script se termine.

Exemple :

```bash
python3 -u example_worker_documented.py add 4 5 6
```

Réponse sur `stdout` :

```json
{"ok":true,"mode":"cli","command":"add","inputs":[4.0,5.0,6.0],"result":15.0}
```

### 2. Mode persistant par pipe JSON

Le C++ lance :

```bash
python3 -u example_worker_documented.py --pipe
```

Ensuite :
- le C++ écrit des lignes JSON dans `stdin`
- Python lit chaque ligne
- Python renvoie une ligne JSON sur `stdout`
- le process Python reste vivant pour traiter plusieurs requêtes

## Règle très importante

- `stdout` = **données du protocole**
- `stderr` = **logs développeur**

Donc :
- ne pas faire de `print()` de debug sur `stdout`
- utiliser `emit_json(...)` pour répondre au C++
- utiliser `log_err(...)` pour les logs humains

## Exemple de requêtes côté C++

```json
{"cmd":"ping"}
{"cmd":"add","values":[1,2,3,4]}
{"cmd":"norm2","values":[3,4]}
{"cmd":"detect_mock"}
{"cmd":"telemetry_mock"}
{"cmd":"quit"}
```

## Exemple de réponses côté Python

```json
{"ok":true,"reply":"pong","mode":"pipe"}
{"ok":true,"cmd":"add","inputs":[1.0,2.0,3.0,4.0],"result":10.0}
{"ok":false,"error":"unknown_cmd: test"}
```

## Contrat conseillé pour le développeur Python

Chaque réponse devrait au minimum contenir :

- `ok: true` si tout s'est bien passé
- `ok: false` + `error: "..."` si une erreur est survenue

Exemple :

```python
return {
    "ok": True,
    "label": "ball",
    "confidence": 0.93,
}
```

ou

```python
return {
    "ok": False,
    "error": "model_not_loaded",
}
```

## Lecture des données envoyées par le C++

Dans le mode pipe, le développeur Python reçoit déjà un `dict` Python dans `pipe_handler(req)`.

Exemple :

```python
def pipe_handler(req: dict) -> dict:
    cmd = req.get("cmd", "")
    if cmd == "add":
        values = req.get("values", [])
        return {"ok": True, "result": sum(float(v) for v in values)}
```

## Écriture des données vers le C++

Ne pas faire :

```python
print({"ok": True})
```

Faire :

```python
emit_json({"ok": True, "result": 123})
```

Dans l'exemple fourni, le plus simple est encore de **retourner un `dict`** depuis `pipe_handler(...)`. Le helper se charge ensuite de l'envoyer correctement au C++.

## Recommandation pratique

Pour un vrai module IA / vision :
- garder le modèle chargé en mémoire en mode `--pipe`
- faire un dispatch sur `cmd`
- renvoyer des objets JSON propres et stables
- écrire les logs sur `stderr`

## Commandes utiles pour tester manuellement

### Mode CLI

```bash
python3 -u example_worker_documented.py add 4 5 6
python3 -u example_worker_documented.py norm2 3 4
python3 -u example_worker_documented.py echo hello world
```

### Mode pipe interactif

```bash
python3 -u example_worker_documented.py --pipe
```

Puis taper manuellement :

```json
{"cmd":"ping"}
{"cmd":"add","values":[1,2,3]}
{"cmd":"detect_mock"}
{"cmd":"quit"}
```

Chaque ligne doit produire une réponse JSON sur la ligne suivante.
