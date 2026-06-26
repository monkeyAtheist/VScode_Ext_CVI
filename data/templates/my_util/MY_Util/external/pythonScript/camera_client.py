"""
=====================================================================
  camera_client.py — Client Python vers le processus C++ caméra
=====================================================================
  Ce module est le SEUL point de contact entre le code Python
  du robot et le programme C++ qui gère la caméra.

  Principe de fonctionnement :
  ─────────────────────────────
  Python lance le binaire C++ en tant que sous-processus.
  La communication se fait via stdin/stdout au format JSON Lines,
  en utilisant le protocole défini dans catj_py_helper.py.

  Sens des échanges :
    Python → C++ (stdin  du C++) : commandes JSON ("get_detections", …)
    C++ → Python (stdout du C++) : réponses JSON avec les détections

  Ce module N'UTILISE PAS catj_py_helper.py directement
  (ce helper est conçu pour un Python-worker, pas pour un client).
  Il implémente le même protocole JSON Lines côté client.

  Thread-safety :
    Un threading.Lock protège toutes les opérations sur les pipes.
    Un thread daemon rafraîchit le cache de détections en arrière-plan.

  Mode simulation :
    Si le binaire C++ est introuvable, des détections fictives sont
    générées pour permettre de tester le reste du code sans hardware.

  Contrat attendu du C++ (voir README_python_worker_protocol.md) :
  ───────────────────────────────────────────────────────────────────
  Commande :  {"cmd": "get_detections"}
  Réponse  :  {
                "ok": true,
                "frame_id": 1234,
                "timestamp_ms": 98765,
                "detections": [
                  {
                    "type":        "piscine_rouge",
                    "cx":          320,
                    "cy":          240,
                    "rayon_px":    28.5,
                    "distance_m":  1.42,
                    "angle_deg":   5.2,
                    "confidence":  0.91
                  }
                ]
              }
=====================================================================
"""

import json
import subprocess
import threading
import time
from typing import Any, Dict, List, Optional

from catj_py_helper import log_err      # log sur stderr uniquement
from logger import get_logger
from config import (
    CPP_CAMERA_BINARY, CPP_CAMERA_ARGS,
    CPP_CAMERA_TIMEOUT_S, CPP_CAMERA_REFRESH_S, CPP_CAMERA_RETRY_MAX,
    CPP_CMD_PING, CPP_CMD_GET_DETECT, CPP_CMD_GET_FRAME,
    CPP_CMD_SET_PARAMS, CPP_CMD_QUIT
)

logger = get_logger('CameraClient')


class CameraClient:
    """
    Client Python qui pilote le programme C++ de traitement caméra.

    Le C++ est lancé en sous-processus et reçoit des commandes JSON
    sur son stdin. Ses réponses JSON arrivent sur son stdout.

    Utilisation :
        cam = CameraClient()
        ok = cam.demarrer()
        detections = cam.lire_detections()   # liste de dict bruts
        cam.arreter()
    """

    def __init__(self,
                 binaire: str = CPP_CAMERA_BINARY,
                 args: List[str] = None):
        self._binaire    = binaire
        self._args       = args if args is not None else CPP_CAMERA_ARGS
        self._process    = None            # subprocess.Popen
        self._lock       = threading.Lock()
        self._actif      = False
        self._simulation = False

        # Cache des dernières détections (mis à jour par le thread de refresh)
        self._cache_detections: List[Dict] = []
        self._cache_frame_id:   int        = -1
        self._cache_ts_ms:      int        = 0

        # Thread daemon de rafraîchissement du cache
        self._thread_refresh: Optional[threading.Thread] = None

        # Statistiques
        self._nb_requetes = 0
        self._nb_erreurs  = 0

    # =========================================================================
    # DÉMARRAGE / ARRÊT
    # =========================================================================

    def demarrer(self) -> bool:
        """
        Lance le binaire C++ et vérifie la connexion par un PING.

        Retourne True si le processus C++ répond correctement.
        Si le binaire est introuvable, passe en mode simulation.
        """
        cmd = [self._binaire] + self._args
        log_err(f"[CameraClient] Lancement : {' '.join(cmd)}")

        try:
            self._process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,   # stderr du C++ ignoré / log séparé
                bufsize=1,                # line-buffered
                text=True,               # mode texte (pas bytes)
                encoding='utf-8',
            )
            self._actif = True
            logger.info(f"Processus C++ caméra démarré (PID {self._process.pid})")

        except FileNotFoundError:
            logger.warning(
                f"Binaire '{self._binaire}' introuvable — "
                "MODE SIMULATION ACTIVÉ"
            )
            self._simulation = True
            self._actif      = True

        # Test de connectivité
        pong = self._envoyer_commande(CPP_CMD_PING)
        if not pong.get('ok'):
            logger.error("C++ caméra ne répond pas au PING")
            return False

        # Info sur le flux vidéo
        info = self._envoyer_commande(CPP_CMD_GET_FRAME)
        if info.get('ok'):
            d = info.get('data', info)
            logger.info(
                f"Flux vidéo C++ : "
                f"{d.get('width','?')}×{d.get('height','?')} "
                f"@ {d.get('fps','?')} FPS"
            )

        # Lancement du thread de rafraîchissement
        self._thread_refresh = threading.Thread(
            target=self._boucle_refresh,
            name='CameraRefreshThread',
            daemon=True
        )
        self._thread_refresh.start()

        logger.info("Client caméra C++ prêt")
        return True

    def arreter(self):
        """
        Envoie la commande 'quit' au C++ puis termine le sous-processus.
        """
        self._actif = False

        if self._process and not self._simulation:
            try:
                self._envoyer_commande(CPP_CMD_QUIT, attendre=False)
                self._process.stdin.close()
                self._process.wait(timeout=3.0)
            except Exception:
                try:
                    self._process.kill()
                except Exception:
                    pass

        logger.info(
            f"Client caméra arrêté — "
            f"{self._nb_requetes} requêtes, "
            f"{self._nb_erreurs} erreurs"
        )

    # =========================================================================
    # COMMUNICATION JSON LINES (bas niveau)
    # =========================================================================

    def _envoyer_commande(self,
                          cmd: str,
                          params: Dict = None,
                          attendre: bool = True) -> Dict:
        """
        Envoie une commande JSON au C++ et attend optionnellement la réponse.

        Protocole (identique au helper catj_py_helper) :
          → Python écrit sur stdin  du C++ : {"cmd": "...", ...}\n
          ← Python lit  sur stdout du C++ : {"ok": true/false, ...}\n

        cmd      : nom de la commande (ex: "get_detections")
        params   : dict de paramètres supplémentaires (fusionnés dans la trame)
        attendre : si False, n'attend pas la réponse (fire-and-forget)
        """
        if self._simulation:
            return self._reponse_simulee(cmd, params)

        # Construction de la trame JSON — même format que catj_py_helper.emit_json
        trame: Dict[str, Any] = {"cmd": cmd}
        if params:
            trame.update(params)

        ligne = json.dumps(trame, ensure_ascii=False, separators=(',', ':')) + '\n'

        with self._lock:
            for tentative in range(1, CPP_CAMERA_RETRY_MAX + 1):
                try:
                    # Écriture sur stdin du processus C++
                    self._process.stdin.write(ligne)
                    self._process.stdin.flush()
                    self._nb_requetes += 1

                    if not attendre:
                        return {"ok": True}

                    # Lecture d'une ligne JSON sur stdout du processus C++
                    # readline() bloque jusqu'à '\n' ou EOF
                    reponse_brute = self._process.stdout.readline()

                    if not reponse_brute:
                        raise EOFError("Le processus C++ a fermé son stdout")

                    return json.loads(reponse_brute.strip())

                except (json.JSONDecodeError, EOFError, BrokenPipeError) as err:
                    self._nb_erreurs += 1
                    logger.warning(
                        f"Erreur comm C++ (tentative {tentative}/"
                        f"{CPP_CAMERA_RETRY_MAX}) : {err}"
                    )
                    time.sleep(0.05 * tentative)

        logger.error(f"Commande '{cmd}' échouée après {CPP_CAMERA_RETRY_MAX} tentatives")
        return {"ok": False, "error": f"max_retries_exceeded:{cmd}"}

    # =========================================================================
    # MODE SIMULATION
    # =========================================================================

    def _reponse_simulee(self, cmd: str, params: Dict = None) -> Dict:
        """
        Génère des réponses fictives quand le binaire C++ n'est pas disponible.
        Permet de tester toute la logique Python sans hardware caméra.
        """
        log_err(f"[SIMULATION caméra] cmd={cmd}")

        if cmd == CPP_CMD_PING:
            return {"ok": True, "reply": "pong", "mode": "simulation"}

        if cmd == CPP_CMD_GET_FRAME:
            return {
                "ok": True,
                "width": 640, "height": 480, "fps": 30,
                "mode": "simulation"
            }

        if cmd == CPP_CMD_GET_DETECT:
            # Simulation : une balle rouge visible à ~1.5 m, légèrement à droite
            import math
            t = time.time()
            angle = math.sin(t * 0.3) * 15.0          # Oscillation pour simuler le mouvement
            distance = 1.5 + math.sin(t * 0.1) * 0.3
            return {
                "ok": True,
                "frame_id":    int(t * 30) % 100000,
                "timestamp_ms": int(t * 1000),
                "detections": [
                    {
                        "type":       "piscine_rouge",
                        "cx":         int(320 + angle * 5),
                        "cy":         240,
                        "rayon_px":   28.5,
                        "distance_m": round(distance, 2),
                        "angle_deg":  round(angle, 1),
                        "confidence": 0.91
                    }
                ]
            }

        if cmd == CPP_CMD_QUIT:
            return {"ok": True, "stop": True}

        return {"ok": False, "error": f"unknown_cmd:{cmd}"}

    # =========================================================================
    # THREAD DE RAFRAÎCHISSEMENT DU CACHE
    # =========================================================================

    def _boucle_refresh(self):
        """
        Thread daemon : interroge périodiquement le C++ pour mettre à jour
        le cache de détections.

        Cadence : CPP_CAMERA_REFRESH_S (~10 Hz par défaut).
        La navigation lit le cache sans bloquer sur une commande UART.
        """
        while self._actif:
            try:
                rep = self._envoyer_commande(CPP_CMD_GET_DETECT)

                if rep.get('ok'):
                    detections = rep.get('detections', [])
                    frame_id   = rep.get('frame_id',   self._cache_frame_id)
                    ts_ms      = rep.get('timestamp_ms', int(time.time() * 1000))

                    # Mise à jour atomique du cache
                    self._cache_detections = detections
                    self._cache_frame_id   = frame_id
                    self._cache_ts_ms      = ts_ms
                else:
                    logger.debug(
                        f"get_detections non OK : {rep.get('error', '?')}"
                    )

            except Exception as err:
                logger.error(f"Erreur thread refresh caméra : {err}")

            time.sleep(CPP_CAMERA_REFRESH_S)

    # =========================================================================
    # INTERFACE PUBLIQUE — LECTURE DES DÉTECTIONS
    # =========================================================================

    def lire_detections_brutes(self) -> List[Dict]:
        """
        Retourne la liste brute des détections du cache courant.

        Chaque élément est un dict fourni directement par le C++ :
          {
            "type":       "piscine_rouge" | "pingpong_orange" | "piscine_autre",
            "cx":         int,         # centre X dans l'image
            "cy":         int,         # centre Y dans l'image
            "rayon_px":   float,       # rayon en pixels
            "distance_m": float,       # distance estimée en mètres
            "angle_deg":  float,       # angle horizontal (° / + = droite)
            "confidence": float        # 0.0 – 1.0
          }
        """
        return list(self._cache_detections)

    def age_cache_ms(self) -> int:
        """Retourne l'âge du cache en millisecondes (fraîcheur des données)."""
        if self._cache_ts_ms == 0:
            return 99999
        return int(time.time() * 1000) - self._cache_ts_ms

    def mettre_a_jour_params(self, params: Dict) -> bool:
        """
        Envoie de nouveaux paramètres de détection au C++.
        Exemple : seuils HSV, résolution, FPS…

        params : dict de paramètres (dépend du firmware C++)
        """
        rep = self._envoyer_commande(CPP_CMD_SET_PARAMS, params)
        return rep.get('ok', False)

    def est_connecte(self) -> bool:
        """Retourne True si le processus C++ est actif et répond."""
        if not self._actif:
            return False
        if self._simulation:
            return True
        return (self._process is not None
                and self._process.poll() is None)

    def stats(self) -> Dict:
        """Statistiques de communication."""
        return {
            'requetes':     self._nb_requetes,
            'erreurs':      self._nb_erreurs,
            'simulation':   self._simulation,
            'frame_id':     self._cache_frame_id,
            'age_cache_ms': self.age_cache_ms(),
            'nb_detections': len(self._cache_detections),
        }
