#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
=====================================================================
  demarrage.py — Séquence de démarrage et homologation du robot
=====================================================================
  Ce module gère :
    1. La vérification de tous les sous-systèmes au démarrage
    2. L'initialisation séquencée (ordre critique)
    3. La séquence d'homologation statique (auto-vérification)
    4. La séquence d'homologation dynamique (ligne droite + demi-tour)
    5. L'affichage des résultats de diagnostic sur le LCD

  Checklist homologation statique (CdC §3.3.1) :
       Périmètre non déployé < 2500 mm  (10 pts)
       Périmètre déployé < 3500 mm      (10 pts)
       Bouton arrêt d'urgence présent   (10 pts)

  Checklist homologation dynamique (CdC §3.6.1) :
       Équilibre (ligne de flottaison)  (10 pts — contrôle jury)
       Ligne droite 7.5 m               (10 pts)
       Demi-tour + retour               (10 pts)
=====================================================================
"""

import time

from logger import get_logger
from config import (
    NAV_VITESSE_MS, NAV_TEMPS_DEMI_TOUR,
    GPS_FIX_TIMEOUT_S, STAB_ACTIF_PAR_DEFAUT,
    HOMO_PERIMETRE_MAX_REPOS, HOMO_PERIMETRE_MAX_DEPLOYE
)

logger = get_logger('Demarrage')


class Demarrage:
    """
    Module de démarrage, diagnostic et homologation du robot.

    Dépend de :
      ESP32Interface   — accès à tous les capteurs et actionneurs
      ControleurLidar  — vérification du LiDAR
      TraitementBalles — vérification de la caméra

    Utilisation :
        dem = Demarrage(esp32, lidar, vision)
        ok = dem.initialiser()             # vérification complète
        dem.homologation_dynamique()       # séquence physique
    """

    def __init__(self, esp32, lidar, vision):
        self._esp32  = esp32
        self._lidar  = lidar
        self._vision = vision

        # Résultats du diagnostic au démarrage
        self.diagnostic = {
            'esp32_connecte':    False,
            'lidar_pret':        False,
            'camera_prete':      False,
            'gps_fix':           False,
            'imu_pret':          False,
            'compass_pret':      False,
            'urgence_ok':        False,
            'stabilisateur_ok':  False,
        }

    # =========================================================================
    # INITIALISATION COMPLÈTE
    # =========================================================================

    def initialiser(self) -> bool:
        """
        Lance la séquence complète d'initialisation et de diagnostic.

        Retourne True si tous les systèmes critiques sont opérationnels.
        Les systèmes non critiques (GPS, baro) émettent un avertissement.
        """
        logger.info("═" * 60)
        logger.info("  INTELLIGENT BOATS — DÉMARRAGE DU SYSTÈME")
        logger.info("  Commune de Pornichet (44) — IBM Mécénat")
        logger.info("═" * 60)

        self._esp32.lcd_ecrire("ROBOT BATEAU    ", "Demarrage...")

        # ── Vérification ESP32 ────────────────────────────────────────────────
        self._verifier_esp32()

        # ── Vérification LiDAR ────────────────────────────────────────────────
        self._verifier_lidar()

        # ── Vérification caméra ────────────────────────────────────────────────
        self._verifier_camera()

        # ── Vérification capteurs ESP32 ───────────────────────────────────────
        self._verifier_capteurs_esp32()

        # ── Affichage du bilan de diagnostic ─────────────────────────────────
        self._afficher_bilan_diagnostic()

        # ── Systèmes critiques (doivent tous être OK) ─────────────────────────
        critique_ok = all([
            self.diagnostic['esp32_connecte'],
            self.diagnostic['lidar_pret'],
            self.diagnostic['urgence_ok'],
        ])

        if critique_ok:
            self._esp32.lcd_ecrire("Systeme PRET    ", "Attente depart")
            logger.info("   Système prêt — tous les systèmes critiques opérationnels")
        else:
            self._esp32.lcd_ecrire("ERREUR SYSTEME  ", "Verifier logs!")
            logger.error("   Systèmes critiques en défaut — consulter les logs")

        return critique_ok

    # =========================================================================
    # VÉRIFICATIONS INDIVIDUELLES
    # =========================================================================

    def _verifier_esp32(self):
        """Vérifie la connexion et la réponse de l'ESP32."""
        logger.info("Vérification ESP32...")
        etat = self._esp32.etat
        if etat.valide or self._esp32._simulation:
            self.diagnostic['esp32_connecte'] = True
            logger.info("ESP32 connecté et opérationnel")
        else:
            logger.error("ESP32 ne répond pas")

    def _verifier_lidar(self):
        """Vérifie que le LiDAR est démarré et fournit des données."""
        logger.info("Vérification LiDAR...")
        # Attente jusqu'à 5 s pour le premier scan
        for _ in range(10):
            if self._lidar.est_pret():
                self.diagnostic['lidar_pret'] = True
                logger.info("LiDAR RPLidar C1 opérationnel")
                return
            time.sleep(0.5)
        logger.error("LiDAR non prêt (aucun scan reçu)")

    def _verifier_camera(self):
        """Vérifie que la caméra capture des frames."""
        logger.info("Vérification caméra...")
        if self._vision is None:
            logger.warning("Module vision non initialisé")
            return
        # Attente de quelques frames
        time.sleep(1.0)
        stats = self._vision.stats()
        if stats.get('camera_active') and stats.get('frames_traitees', 0) > 0:
            self.diagnostic['camera_prete'] = True
            logger.info(
                f"     Caméra opérationnelle "
                f"({stats['frames_traitees']} frames)"
            )
        else:
            logger.warning("Caméra non disponible (mode sans vision)")

    def _verifier_capteurs_esp32(self):
        """Vérifie les capteurs accessibles via l'ESP32."""
        logger.info("Vérification capteurs ESP32...")

        # ── IMU MPU-6050 ──────────────────────────────────────────────────────
        imu = self._esp32.lire_imu()
        if imu.valide:
            self.diagnostic['imu_pret'] = True
            logger.info(
                f"IMU MPU-6050 — "
                f"ax:{imu.ax:.2f}g ay:{imu.ay:.2f}g az:{imu.az:.2f}g"
            )
        else:
            logger.warning("IMU MPU-6050 non disponible")

        # ── Boussole HMC5883 ──────────────────────────────────────────────────
        compass = self._esp32.lire_compass()
        if compass.valide:
            self.diagnostic['compass_pret'] = True
            logger.info(f"Boussole HMC5883 — cap:{compass.heading_deg:.1f}°")
        else:
            logger.warning("Boussole HMC5883 non disponible")

        # ── GPS ───────────────────────────────────────────────────────────────
        logger.info("  Attente du fix GPS (max 30s)...")
        self._esp32.lcd_ecrire("Attente GPS fix ", "Patientez...")
        for i in range(GPS_FIX_TIMEOUT_S // 2):
            gps = self._esp32.lire_gps()
            if gps.fix and gps.hdop < 5.0:
                self.diagnostic['gps_fix'] = True
                logger.info(
                    f"     GPS fix obtenu — "
                    f"lat:{gps.lat:.5f} lon:{gps.lon:.5f} "
                    f"sat:{gps.satellites} hdop:{gps.hdop:.1f}"
                )
                break
            time.sleep(2.0)
        if not self.diagnostic['gps_fix']:
            logger.warning("    GPS — pas de fix (navigation sans GPS possible)")

        # ── Bouton d'arrêt d'urgence ──────────────────────────────────────────
        if not self._esp32.urgence_active():
            self.diagnostic['urgence_ok'] = True
            logger.info("     Bouton d'urgence en position repos (OK)")
        else:
            logger.error(
                "     URGENCE ACTIVE au démarrage — "
                "vérifier le bouton rouge !"
            )

        # ── Stabilisateur ─────────────────────────────────────────────────────
        self._esp32.stabilisateur(STAB_ACTIF_PAR_DEFAUT)
        self.diagnostic['stabilisateur_ok'] = True
        logger.info(
            f"     Stabilisateur "
            f"{'activé' if STAB_ACTIF_PAR_DEFAUT else 'désactivé'}"
        )

        # ── Baromètre BMP280 ──────────────────────────────────────────────────
        baro = self._esp32.lire_baro()
        if baro.valide:
            logger.info(
                f"     BMP280 — "
                f"{baro.temp_c:.1f}°C | {baro.pression_hpa:.1f} hPa | "
                f"alt:{baro.altitude_m:.0f}m"
            )
        else:
            logger.warning("    BMP280 non disponible")

    # =========================================================================
    # HOMOLOGATION DYNAMIQUE (CdC §3.6.1)
    # =========================================================================

    def homologation_dynamique(self):
        """
        Exécute la séquence complète d'homologation dynamique.

        Critères évalués (10 pts chacun, total 30 pts) :
          1. Équilibre — contrôle visuel jury (non automatisable)
          2. Ligne droite 7.5 m
          3. Demi-tour + retour au point de départ
        """
        logger.info("╔══════════════════════════════════════════╗")
        logger.info("║   HOMOLOGATION DYNAMIQUE — CdC §3.6.1   ║")
        logger.info("╚══════════════════════════════════════════╝")
        self._esp32.lcd_ecrire("HOMOLOGATION    ", "Preparation...")
        time.sleep(1.0)

        # ── Critère 2 : Ligne droite 7.5 m ───────────────────────────────────
        logger.info("─── Critère 2 : Ligne droite 7.5 m ───")
        self._esp32.lcd_ecrire("LIGNE DROITE    ", "7.5 m...")
        self._sequence_ligne_droite(7.5)

        time.sleep(1.0)  # Pause entre les deux tests

        # ── Critère 3 : Demi-tour + retour ───────────────────────────────────
        logger.info("─── Critère 3 : Demi-tour + retour ───")
        self._esp32.lcd_ecrire("DEMI-TOUR       ", "Execution...")
        self._sequence_demi_tour_retour()

        logger.info("╔══════════════════════════════════════════╗")
        logger.info("║   HOMOLOGATION DYNAMIQUE — TERMINÉE      ║")
        logger.info("║   Critère 1 (équilibre) → jury visuel    ║")
        logger.info("╚══════════════════════════════════════════╝")
        self._esp32.lcd_ecrire("HOMOLOG. FAITE  ", "OK Jury?")

    def _sequence_ligne_droite(self, distance_m: float):
        """
        Fait avancer le robot en ligne droite sur `distance_m` mètres.
        La durée est calculée à partir de NAV_VITESSE_MS.
          À calibrer sur l'eau avec la vitesse réelle du robot.
        """
        duree = distance_m / NAV_VITESSE_MS
        logger.info(
            f"  Avancer {distance_m}m à {NAV_VITESSE_MS}m/s → {duree:.1f}s"
        )
        self._esp32.gouvernail_centre()
        self._esp32.propulsion_avant('normal')
        time.sleep(duree)
        self._esp32.propulsion_arret()
        logger.info("  Ligne droite terminée")

    def _sequence_demi_tour_retour(self):
        """
        Séquence : ligne droite 7.5m → demi-tour → retour 7.5m.
        """
        duree_aller = 7.5 / NAV_VITESSE_MS

        # ── Aller ─────────────────────────────────────────────────────────────
        logger.info(f"  Aller : {duree_aller:.1f}s avancer")
        self._esp32.gouvernail_centre()
        self._esp32.propulsion_avant('normal')
        time.sleep(duree_aller)
        self._esp32.propulsion_arret()
        time.sleep(0.5)

        # ── Demi-tour ─────────────────────────────────────────────────────────
        logger.info("  Demi-tour en cours...")
        self._esp32.demi_tour('droite')
        time.sleep(0.5)

        # ── Retour ────────────────────────────────────────────────────────────
        logger.info(f"  Retour : {duree_aller:.1f}s avancer")
        self._esp32.gouvernail_centre()
        self._esp32.propulsion_avant('normal')
        time.sleep(duree_aller)
        self._esp32.propulsion_arret()
        logger.info("  Séquence demi-tour terminée")

    # =========================================================================
    # BILAN DIAGNOSTIC
    # =========================================================================

    def _afficher_bilan_diagnostic(self):
        """Affiche le tableau récapitulatif du diagnostic dans les logs."""
        logger.info("╔══════════════════════════════════════════════╗")
        logger.info("║           BILAN DIAGNOSTIC DÉMARRAGE         ║")
        logger.info("╠══════════════════════════════════════════════╣")
        for cle, etat in self.diagnostic.items():
            symbole = "  " if etat else "  "
            label   = cle.replace('_', ' ').upper()
            logger.info(f"║  {symbole}  {label:<38} ║")
        logger.info("╚══════════════════════════════════════════════╝")

    def homologation_statique_auto(self) -> dict:
        """
        Auto-vérification des critères statiques mesurables.
        Retourne un dict des critères avec True/False.
        Les mesures de périmètre doivent être fournies manuellement.

        Note : la vérification réelle reste à faire par le jury.
        """
        logger.info("=== Auto-vérification homologation statique ===")
        resultats = {
            'perimetre_repos_ok':   False,  # À mesurer physiquement
            'perimetre_deploye_ok': False,  # À mesurer physiquement
            'bouton_urgence_ok':    self.diagnostic.get('urgence_ok', False),
        }
        logger.info(
            f"  Périmètre non déployé max : {HOMO_PERIMETRE_MAX_REPOS} mm "
            "→ vérification manuelle requise"
        )
        logger.info(
            f"  Périmètre déployé max : {HOMO_PERIMETRE_MAX_DEPLOYE} mm "
            "→ vérification manuelle requise"
        )
        logger.info(
            f"  Bouton d'urgence : "
            f"{'OK' if resultats['bouton_urgence_ok'] else 'ABSENT/ACTIF'}"
        )
        return resultats
