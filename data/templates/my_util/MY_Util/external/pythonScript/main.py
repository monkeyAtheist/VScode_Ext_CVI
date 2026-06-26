#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
=====================================================================
  main.py — Programme principal du robot bateau autonome (v3)
=====================================================================
  Intelligent Boats — Macroplastique Challenge
  Commune de Pornichet (44) — IBM Mécénat

  Nouveauté v3 — Architecture caméra C++ :
  ─────────────────────────────────────────
  Le traitement vidéo est délégué à un programme C++ externe.
  Python communique avec lui via stdin/stdout (JSON Lines),
  en utilisant le protocole défini dans catj_py_helper.py.

  ┌──────────────────────────────────────────────────────────────┐
  │                   RASPBERRY PI 4B                            │
  │                                                              │
  │  main.py (ce fichier — orchestrateur Python)                 │
  │    │                                                         │
  │    ├─[UART /dev/ttyAMA0]──▶ ESP32 (hardware bas niveau)     │
  │    │                                                         │
  │    ├─[USB  /dev/ttyUSB0]──▶ RPLidar C1 (direct)             │
  │    │                                                         │
  │    └─[pipe stdin/stdout]──▶ Processus C++ ./camera_worker   │
  │          │                   (capture + vision + détection)  │
  │          │                                                   │
  │          ├── Python → C++ : {"cmd":"get_detections"}\n       │
  │          └── C++ → Python : {"ok":true,"detections":[...]}\n │
  └──────────────────────────────────────────────────────────────┘

  Protocole Python ↔ C++ (voir README_python_worker_protocol.md) :
    - 1 commande JSON par ligne sur stdin  du C++
    - 1 réponse  JSON par ligne sur stdout du C++
    - catj_py_helper.py définit ce protocole côté Python-worker
    - camera_client.py l'implémente côté Python-client (ce projet)

  Fichiers du projet :
    config.py              ← constantes (UART, LiDAR, C++, scores…)
    logger.py              ← logger partagé
    catj_py_helper.py      ← helper protocole C++/Python (fourni)
    protocole_uart.py      ← trames JSON ESP32
    esp32_interface.py     ← communication UART ESP32
    controleur_lidar.py    ← RPLidar C1 (USB, thread 360°)
    camera_client.py       ← ★ NOUVEAU : client vers C++ caméra
    traitement_balles.py   ← ★ MODIFIÉ : consomme les données C++
    navigation.py          ← guidage (FGM + cap + vision C++)
    mode_labyrinthe.py     ← contre-la-montre
    mode_course.py         ← ★ MODIFIÉ : collecte via vision C++
    demarrage.py           ← init + homologation
    main.py                ← CE FICHIER

  Dépendances Python :
    pip3 install pyserial rplidar-roboticia

  Lancement :
    python3 main.py
=====================================================================
"""

import signal
import sys
import time
import threading

from logger import get_logger

# ── Importation de tous les modules du projet ─────────────────────────────────
from config            import UART_PORT, UART_BAUDRATE, LIDAR_PORT, \
                              CPP_CAMERA_BINARY, CPP_CAMERA_ARGS
from esp32_interface   import ESP32Interface
from controleur_lidar  import ControleurLidar
from camera_client     import CameraClient
from traitement_balles import TraitementBalles
from navigation        import NavigationGuidage
from mode_labyrinthe   import ModeLabyrinthe
from mode_course       import ModeCourse
from demarrage         import Demarrage

logger = get_logger('Main')


# =====================================================================
# ORCHESTRATEUR PRINCIPAL
# =====================================================================

class RobotBateau:
    """
    Classe principale — orchestre tous les sous-systèmes.

    Changements v3 par rapport à v2 :
      - CameraClient instancié et passé à TraitementBalles
      - TraitementBalles ne fait plus de traitement vidéo interne
      - demarrer() lance aussi le processus C++ caméra
      - arreter() ferme proprement le processus C++ caméra

    Ordre d'initialisation :
      1. ESP32 (UART)
      2. LiDAR (USB)
      3. CameraClient → lance le binaire C++ en sous-processus
      4. TraitementBalles (consomme CameraClient)
      5. NavigationGuidage (fusionne LiDAR + ESP32 + Vision)
      6. Modules d'épreuves
      7. Module de démarrage
      8. Thread de surveillance d'urgence
    """

    def __init__(self):
        logger.info("═" * 62)
        logger.info("  INTELLIGENT BOATS — MACROPLASTIQUE CHALLENGE  (v3)")
        logger.info("  Raspberry Pi 4B + ESP32 + C++ camera worker")
        logger.info("═" * 62)

        # ── 1. Couche matérielle ───────────────────────────────────────────────
        self.esp32  = ESP32Interface(UART_PORT, UART_BAUDRATE)
        self.lidar  = ControleurLidar(LIDAR_PORT)

        # ── 2. Caméra C++ ─────────────────────────────────────────────────────
        # CameraClient lance le binaire C++ et communique via JSON Lines
        self.cam_client = CameraClient(CPP_CAMERA_BINARY, CPP_CAMERA_ARGS)

        # TraitementBalles consomme le CameraClient — aucun OpenCV ici
        self.vision = TraitementBalles(self.cam_client)

        # ── 3. Navigation ─────────────────────────────────────────────────────
        self.nav = NavigationGuidage(self.esp32, self.lidar, self.vision)

        # ── 4. Modules d'épreuves ─────────────────────────────────────────────
        self.labyrinthe = ModeLabyrinthe(self.esp32, self.lidar, self.nav)
        self.course     = ModeCourse(self.esp32, self.lidar, self.nav, self.vision)

        # ── 5. Démarrage / homologation ───────────────────────────────────────
        self.dem = Demarrage(self.esp32, self.lidar, self.vision)

        # Flag d'urgence global
        self._urgence_globale   = False
        self._thread_surveillance: threading.Thread = None

    # =========================================================================
    # DÉMARRAGE
    # =========================================================================

    def demarrer(self) -> bool:
        """
        Établit toutes les connexions et lance les sous-systèmes.

        Retourne True si les systèmes critiques sont opérationnels.
        """
        logger.info("=== Démarrage du système ===")

        # ── ESP32 ─────────────────────────────────────────────────────────────
        logger.info("Connexion ESP32 (UART)…")
        if not self.esp32.connecter():
            logger.error("Impossible de connecter l'ESP32")
            return False

        # ── LiDAR ─────────────────────────────────────────────────────────────
        logger.info("Démarrage RPLidar C1…")
        lidar_ok = self.lidar.demarrer()
        if not lidar_ok:
            logger.warning("LiDAR non disponible — navigation dégradée")

        # ── Processus C++ caméra ──────────────────────────────────────────────
        logger.info(f"Lancement processus C++ caméra : {CPP_CAMERA_BINARY}…")
        cam_ok = self.cam_client.demarrer()
        if not cam_ok:
            logger.warning(
                "Processus C++ caméra non disponible — "
                "guidage visuel désactivé"
            )

        # ── Diagnostic complet ────────────────────────────────────────────────
        systeme_ok = self.dem.initialiser()

        # ── Surveillance d'urgence (thread daemon) ────────────────────────────
        self._thread_surveillance = threading.Thread(
            target=self._surveiller_urgence,
            name='SurveillanceUrgence',
            daemon=True
        )
        self._thread_surveillance.start()

        return systeme_ok

    def arreter(self):
        """
        Arrête proprement tous les sous-systèmes dans l'ordre inverse.
        Appelé dans le bloc finally de main().
        """
        logger.info("=== Arrêt du système ===")

        # Ordre d'arrêt : couches hautes → couches basses
        for nom, fn in [
            ("navigation",    self.nav.arreter),
            ("actionneurs",   self.esp32.arret_total),
            ("C++ caméra",    self.cam_client.arreter),
            ("LiDAR",         self.lidar.arreter),
            ("ESP32 UART",    self.esp32.deconnecter),
        ]:
            try:
                fn()
                logger.info(f"  ✓ {nom} arrêté")
            except Exception as err:
                logger.error(f"  ✗ Erreur arrêt {nom} : {err}")

        logger.info("Système arrêté proprement")

    # =========================================================================
    # SURVEILLANCE D'URGENCE
    # =========================================================================

    def _surveiller_urgence(self):
        """Thread daemon — surveille l'urgence ESP32 à 5 Hz."""
        while True:
            try:
                if self.esp32.urgence_active() and not self._urgence_globale:
                    self._urgence_globale = True
                    logger.critical("!!! ARRÊT D'URGENCE GLOBAL !!!")
                    self.nav.arreter()
                    self.esp32.arret_total()
                    self.esp32.lcd_ecrire("!!! URGENCE !!!", "  Appuyer reset ")
            except Exception:
                pass
            time.sleep(0.2)

    def reset_urgence(self):
        """Remet à zéro le flag d'urgence (usage test uniquement)."""
        self._urgence_globale = False
        logger.info("Flag d'urgence réinitialisé")

    # =========================================================================
    # ÉPREUVES
    # =========================================================================

    def lancer_homologation(self):
        """Homologation dynamique : ligne droite 7.5m + demi-tour (CdC §3.6.1)."""
        if self._urgence_globale:
            logger.error("Urgence active — homologation bloquée")
            return
        self.dem.homologation_dynamique()

    def lancer_labyrinthe(self) -> float:
        """
        Contre-la-montre dans le labyrinthe (CdC §3.7).
        Retourne le temps final en secondes, ou -1 si annulé.
        """
        if self._urgence_globale:
            return -1.0
        if not self.labyrinthe.preparer():
            return -1.0

        self.labyrinthe.demarrer()
        try:
            while (not self._urgence_globale
                   and not self.labyrinthe.circuit_complete):
                time.sleep(0.5)
        except KeyboardInterrupt:
            logger.info("Fin manuelle labyrinthe (Ctrl+C)")

        if not self.labyrinthe.circuit_complete:
            return self.labyrinthe.terminer()
        return self.labyrinthe.temps_ecoule

    def lancer_collecte(self, score_predit: int = 0) -> int:
        """
        Épreuve de collecte intelligente 5 min (CdC §3.8).
        Les balles sont identifiées par le C++ (vision caméra).
        Retourne le score final.
        """
        if self._urgence_globale:
            return 0

        self.course.preparer(score_predit)
        self.course.demarrer()

        try:
            while (not self._urgence_globale
                   and not self.course.verrouille):
                time.sleep(0.5)
        except KeyboardInterrupt:
            logger.info("Fin manuelle collecte (Ctrl+C)")

        if not self.course.verrouille:
            self.course.verrouiller()

        return self.course.score

    # =========================================================================
    # TESTS
    # =========================================================================

    def test_camera_cpp(self):
        """
        Affiche en temps réel les détections envoyées par le C++.
        Utile pour vérifier que le binaire C++ fonctionne correctement.
        """
        logger.info("=== TEST CAMÉRA C++ (Ctrl+C pour arrêter) ===")
        logger.info(
            f"Client : {CPP_CAMERA_BINARY} | "
            f"Simulation : {self.cam_client._simulation}"
        )
        try:
            frame_prev = -1
            while True:
                balles = self.vision.balles_detectees()
                frame  = self.cam_client._cache_frame_id
                age    = self.cam_client.age_cache_ms()

                if frame != frame_prev:
                    frame_prev = frame
                    if balles:
                        for b in balles:
                            logger.info(f"  [frame {frame}] {b}")
                    else:
                        logger.info(f"  [frame {frame}] Aucune balle (cache age:{age}ms)")

                time.sleep(0.2)
        except KeyboardInterrupt:
            pass

    def test_capteurs(self):
        """Lecture complète de tous les capteurs ESP32."""
        logger.info("=== TEST CAPTEURS ESP32 ===")
        imu     = self.esp32.lire_imu()
        compass = self.esp32.lire_compass()
        gps     = self.esp32.lire_gps()
        baro    = self.esp32.lire_baro()

        logger.info(f"IMU     : ax={imu.ax:.2f}g  ay={imu.ay:.2f}g  az={imu.az:.2f}g")
        logger.info(f"Compass : cap={compass.heading_deg:.1f}°")
        logger.info(f"GPS     : lat={gps.lat:.5f} lon={gps.lon:.5f} fix={gps.fix}")
        logger.info(f"Baro    : {baro.temp_c:.1f}°C {baro.pression_hpa:.1f}hPa")
        logger.info(f"Urgence : {self.esp32.urgence_active()}")
        logger.info(f"Stats UART  : {self.esp32.stats()}")
        logger.info(f"Stats caméra: {self.cam_client.stats()}")
        logger.info(f"Stats vision: {self.vision.stats()}")

    def test_convoyeur(self, duree: float = 5.0):
        """Test du convoyeur DRV8833 pendant `duree` secondes."""
        logger.info(f"=== TEST CONVOYEUR ({duree}s) ===")
        self.esp32.convoyeur_start(80)
        time.sleep(duree)
        self.esp32.convoyeur_stop()
        logger.info("Convoyeur arrêté")


# =====================================================================
# MENU INTERACTIF
# =====================================================================

def afficher_menu() -> str:
    """Affiche le menu principal."""
    print()
    print("╔══════════════════════════════════════════════════════╗")
    print("║   INTELLIGENT BOATS — MACROPLASTIQUE CHALLENGE      ║")
    print("║   Raspberry Pi 4B + ESP32 + C++ camera_worker       ║")
    print("╠══════════════════════════════════════════════════════╣")
    print("║  ÉPREUVES :                                         ║")
    print("║    1. Homologation dynamique     (CdC §3.6.1)       ║")
    print("║    2. Contre-la-montre           (CdC §3.7)         ║")
    print("║    3. Collecte intelligente      (CdC §3.8)         ║")
    print("╠══════════════════════════════════════════════════════╣")
    print("║  TESTS :                                            ║")
    print("║    4. Test caméra C++ (détections temps réel)       ║")
    print("║    5. Test capteurs ESP32                           ║")
    print("║    6. Test propulsion                               ║")
    print("║    7. Test convoyeur (5s)                           ║")
    print("║    8. Homologation statique (auto-vérif)            ║")
    print("║    9. Ping C++ camera_worker                        ║")
    print("║    r. Reset urgence                                 ║")
    print("╠══════════════════════════════════════════════════════╣")
    print("║    0. Quitter                                       ║")
    print("╚══════════════════════════════════════════════════════╝")
    return input("  Votre choix : ").strip().lower()


# =====================================================================
# GESTIONNAIRE DE SIGNAL
# =====================================================================

_robot_global: RobotBateau = None


def _handler_signal(sig, frame):
    """Arrêt propre sur Ctrl+C / SIGINT."""
    logger.info("SIGINT reçu — arrêt en cours…")
    if _robot_global:
        _robot_global.arreter()
    sys.exit(0)


# =====================================================================
# POINT D'ENTRÉE
# =====================================================================

def main() -> int:
    global _robot_global

    signal.signal(signal.SIGINT, _handler_signal)
    robot = None

    try:
        robot         = RobotBateau()
        _robot_global = robot

        systeme_ok = robot.demarrer()
        if not systeme_ok:
            logger.warning(
                "Certains systèmes sont en défaut. "
                "Vous pouvez quand même continuer en mode dégradé."
            )

        while True:
            choix = afficher_menu()

            # ── 1 : Homologation dynamique ────────────────────────────────────
            if choix == '1':
                print("\n[HOMOLOGATION DYNAMIQUE — CdC §3.6.1]")
                print("Bassin libre sur 8m minimum.")
                input("ENTRÉE au signal du jury…")
                robot.lancer_homologation()
                print("Homologation terminée — attendre validation jury.")

            # ── 2 : Contre-la-montre ──────────────────────────────────────────
            elif choix == '2':
                print("\n[CONTRE-LA-MONTRE — CdC §3.7]")
                print("Ctrl+C pour terminer manuellement.")
                input("ENTRÉE au signal de départ…")
                temps = robot.lancer_labyrinthe()
                if temps >= 0:
                    print(f"\n✓ Temps réalisé : {temps:.2f} s")
                else:
                    print("\n✗ Épreuve annulée.")

            # ── 3 : Collecte ──────────────────────────────────────────────────
            elif choix == '3':
                print("\n[COLLECTE INTELLIGENTE — CdC §3.8]")
                print("Identification des balles : processus C++ caméra")
                print("Durée max : 5 minutes")
                try:
                    score_predit = int(input("Score prédit (à communiquer au jury) : "))
                except ValueError:
                    score_predit = 0
                    print("Valeur invalide → 0")
                print(f"Prédiction : {score_predit} pts")
                input("ENTRÉE au signal de départ…")
                score = robot.lancer_collecte(score_predit)
                print(f"\n✓ Score final  : {score} pts")
                print(f"  Bonus prédict : {robot.course.calcul_bonus_prediction()} pts")
                print(f"  Bonus affich  : {robot.course.calcul_bonus_afficheur()} pts")

            # ── 4 : Test caméra C++ ───────────────────────────────────────────
            elif choix == '4':
                print("\n[TEST CAMÉRA C++ — Ctrl+C pour arrêter]")
                robot.test_camera_cpp()

            # ── 5 : Test capteurs ─────────────────────────────────────────────
            elif choix == '5':
                print("\n[TEST CAPTEURS ESP32]")
                robot.test_capteurs()

            # ── 6 : Test propulsion ───────────────────────────────────────────
            elif choix == '6':
                print("\n[TEST PROPULSION]")
                print("  1. Avancer 3s  2. Demi-tour  3. Ligne droite 7.5m")
                sc = input("Choix : ").strip()
                if sc == '1':
                    robot.esp32.propulsion_avant('normal')
                    time.sleep(3.0)
                    robot.esp32.propulsion_arret()
                elif sc == '2':
                    robot.esp32.demi_tour('droite')
                elif sc == '3':
                    from config import NAV_VITESSE_MS
                    robot.esp32.gouvernail_centre()
                    robot.esp32.propulsion_avant('normal')
                    time.sleep(7.5 / NAV_VITESSE_MS)
                    robot.esp32.propulsion_arret()
                print("Test terminé.")

            # ── 7 : Test convoyeur ────────────────────────────────────────────
            elif choix == '7':
                print("\n[TEST CONVOYEUR DRV8833 — 5 s]")
                robot.test_convoyeur(5.0)

            # ── 8 : Homologation statique ─────────────────────────────────────
            elif choix == '8':
                print("\n[HOMOLOGATION STATIQUE — CdC §3.3.1]")
                res = robot.dem.homologation_statique_auto()
                for cle, val in res.items():
                    print(f"  {'✓' if val else '⚠'} {cle.replace('_', ' ')}")

            # ── 9 : Ping C++ ──────────────────────────────────────────────────
            elif choix == '9':
                print("\n[PING C++ camera_worker]")
                rep = robot.cam_client._envoyer_commande('ping')
                if rep.get('ok'):
                    print(f"✓ Réponse : {rep}")
                else:
                    print(f"✗ Pas de réponse : {rep}")

            # ── r : Reset urgence ─────────────────────────────────────────────
            elif choix == 'r':
                robot.reset_urgence()
                print("Flag d'urgence réinitialisé.")

            # ── 0 : Quitter ────────────────────────────────────────────────────
            elif choix == '0':
                print("\nArrêt du programme…")
                break

            else:
                print("Choix invalide.")

    except KeyboardInterrupt:
        logger.info("Interruption clavier")

    except Exception as err:
        logger.critical(f"Erreur critique : {err}", exc_info=True)

    finally:
        if robot:
            robot.arreter()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
