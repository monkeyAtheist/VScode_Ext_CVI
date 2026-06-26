#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
=====================================================================
  navigation.py — Navigation et guidage du bateau (v3)
=====================================================================
  CHANGEMENT v3 :
    Les imports OpenCV (cv2) ont été supprimés.
    Le guidage visuel utilise désormais les objets Balle produits
    par traitement_balles.py (qui consomme le C++), pas de frames.

  Ce module fusionne les données de tous les capteurs disponibles
  (LiDAR, boussole HMC5883, IMU MPU-6050 via ESP32) pour produire
  des commandes de propulsion et de gouvernail.

  Algorithmes embarqués :
    1. Follow-the-Gap Method (FGM) — évitement d'obstacles LiDAR
    2. Cap magnétique (HMC5883) — maintien d'un cap absolu
    3. Correcteur P — gouvernail proportionnel à l'erreur de cap
    4. Recul d'urgence — déclenchement automatique si collision
    5. Guidage vers cible visuelle — poursuite d'une balle Balle

  Machine à états :
    STOP, AVANCER, VIRER_DROITE, VIRER_GAUCHE, RECULER, SUIVRE_CIBLE
=====================================================================
"""

import math
import threading
import time
from typing import Optional

from logger import get_logger
from config import (
    NAV_PERIODE_S, NAV_TOLERANCE_CAP, NAV_KP_CAP,
    LIDAR_DIST_URGENCE, LIDAR_DIST_EVITEMENT,
    GOUV_CENTRE, GOUV_DROITE_MAX, GOUV_GAUCHE_MAX,
    GOUV_CORRECTION, GOUV_CORRECTION_G,
)
from traitement_balles import Balle

logger = get_logger('Navigation')


class NavigationGuidage:
    """
    Module central de navigation autonome du bateau.

    Fusionne :
      - LiDAR (ControleurLidar)     — détection et évitement d'obstacles
      - ESP32 (ESP32Interface)       — boussole, GPS, IMU, actionneurs
      - Vision (TraitementBalles)    — guidage vers les balles en mode collecte

    La boucle de navigation tourne dans un thread daemon à NAV_FREQUENCE_HZ.
    """

    STOP         = 'STOP'
    AVANCER      = 'AVANCER'
    VIRER_DROITE = 'VIRER_DROITE'
    VIRER_GAUCHE = 'VIRER_GAUCHE'
    RECULER      = 'RECULER'
    SUIVRE_CIBLE = 'SUIVRE_CIBLE'

    def __init__(self, esp32, lidar, vision=None):
        """
        esp32  : instance ESP32Interface
        lidar  : instance ControleurLidar
        vision : instance TraitementBalles (optionnel — None si pas de caméra C++)
        """
        self._esp32  = esp32
        self._lidar  = lidar
        self._vision = vision

        self._etat          = self.STOP
        self._cap_cible     = None
        self._mode_cible    = False
        self._actif         = False
        self._thread        = None
        self._verrou_etat   = threading.Lock()

    # =========================================================================
    # DÉMARRAGE / ARRÊT
    # =========================================================================

    def demarrer(self):
        """Lance la boucle de navigation dans un thread daemon."""
        if self._actif:
            return
        self._actif = True
        self._thread = threading.Thread(
            target=self._boucle,
            name='NavigationThread',
            daemon=True
        )
        self._thread.start()
        logger.info("Navigation/guidage démarré")

    def arreter(self):
        """Arrête la navigation et coupe les actionneurs."""
        self._actif = False
        self._esp32.arret_total()
        with self._verrou_etat:
            self._etat = self.STOP
        logger.info("Navigation/guidage arrêté")

    # =========================================================================
    # CONFIGURATION
    # =========================================================================

    def definir_cap_cible(self, cap_deg: Optional[float]):
        """Définit le cap magnétique à maintenir. None = désactivé."""
        self._cap_cible = cap_deg
        if cap_deg is not None:
            logger.info(f"Cap cible : {cap_deg:.1f}°")

    def activer_mode_cible(self, actif: bool):
        """
        Active/désactive le guidage visuel vers les balles.
        Nécessite que vision != None au moment de l'appel.
        """
        if actif and self._vision is None:
            logger.warning("Mode cible demandé mais aucun module vision configuré")
            return
        self._mode_cible = actif
        logger.info(f"Mode guidage visuel : {'ACTIF' if actif else 'INACTIF'}")

    def reagir_collision_physique(self):
        """Callback externe : force un recul d'urgence immédiat."""
        logger.warning("Collision physique → recul forcé")
        with self._verrou_etat:
            self._etat = self.RECULER
        self._esp32.recul_urgence(2.0)
        with self._verrou_etat:
            self._etat = self.STOP

    # =========================================================================
    # BOUCLE PRINCIPALE
    # =========================================================================

    def _boucle(self):
        """Boucle de contrôle cadencée à NAV_FREQUENCE_HZ."""
        while self._actif:
            t0 = time.time()
            try:
                self._iteration()
            except Exception as err:
                logger.error(f"Erreur boucle navigation : {err}")
            time.sleep(max(0.0, NAV_PERIODE_S - (time.time() - t0)))

    def _iteration(self):
        """
        Une itération de la machine à états.

        Ordre de priorité :
          1. Urgence ESP32
          2. Collision imminente (LiDAR)
          3. Guidage visuel vers balle (si mode_cible actif)
          4. Évitement FGM (LiDAR)
          5. Maintien de cap (boussole)
          6. Avancer tout droit
        """
        # ── Priorité 1 : urgence ──────────────────────────────────────────────
        if self._esp32.urgence_active():
            if self._etat != self.STOP:
                logger.critical("Urgence active — navigation arrêtée")
                self._esp32.arret_total()
                self._changer_etat(self.STOP)
            return

        dist    = self._lidar.lire_directions()
        d_avant = dist.get('avant',        math.inf)
        d_av_dr = dist.get('avant_droite', math.inf)
        d_av_gc = dist.get('avant_gauche', math.inf)
        d_droit = dist.get('droite',       math.inf)
        d_gauch = dist.get('gauche',       math.inf)

        # ── Priorité 2 : collision imminente (LiDAR) ──────────────────────────
        if d_avant < LIDAR_DIST_URGENCE:
            if self._etat != self.RECULER:
                logger.warning(f"Collision imminente {d_avant:.0f}mm → recul")
                self._changer_etat(self.RECULER)
                self._esp32.recul_urgence(1.5)
                self._changer_etat(self.STOP)
            return

        # ── Priorité 3 : guidage visuel (C++ caméra) ─────────────────────────
        if self._mode_cible and self._vision:
            cible = self._vision.meilleure_cible()
            if cible and cible.distance_m < 3.0:
                self._guider_vers_cible(cible)
                return

        # ── Priorité 4 : évitement FGM ────────────────────────────────────────
        if d_avant < LIDAR_DIST_EVITEMENT:
            self._eviter_obstacle(d_droit, d_gauch, d_avant)
            return

        seuil = LIDAR_DIST_EVITEMENT * 0.65
        if d_av_dr < seuil and self._etat != self.VIRER_GAUCHE:
            self._changer_etat(self.VIRER_GAUCHE)
            self._esp32.gouvernail(GOUV_CORRECTION_G)
            self._esp32.propulsion_avant('normal')
            return
        if d_av_gc < seuil and self._etat != self.VIRER_DROITE:
            self._changer_etat(self.VIRER_DROITE)
            self._esp32.gouvernail(GOUV_CORRECTION)
            self._esp32.propulsion_avant('normal')
            return

        # ── Priorité 5 : maintien de cap ──────────────────────────────────────
        if self._cap_cible is not None:
            self._maintenir_cap()
            return

        # ── Priorité 6 : avancer tout droit ──────────────────────────────────
        if self._etat != self.AVANCER:
            self._changer_etat(self.AVANCER)
            self._esp32.gouvernail_centre()
            self._esp32.propulsion_avant('normal')

    # =========================================================================
    # SOUS-ROUTINES
    # =========================================================================

    def _eviter_obstacle(self, d_droite, d_gauche, d_avant):
        """Follow-the-Gap : vire vers le côté le plus dégagé."""
        if d_droite >= d_gauche:
            if self._etat != self.VIRER_DROITE:
                logger.info(
                    f"FGM : {d_avant:.0f}mm → DROITE "
                    f"(dr:{d_droite:.0f} gc:{d_gauche:.0f})"
                )
                self._changer_etat(self.VIRER_DROITE)
                self._esp32.gouvernail_droite(True)
                self._esp32.propulsion_avant('lent')
        else:
            if self._etat != self.VIRER_GAUCHE:
                logger.info(
                    f"FGM : {d_avant:.0f}mm → GAUCHE "
                    f"(gc:{d_gauche:.0f} dr:{d_droite:.0f})"
                )
                self._changer_etat(self.VIRER_GAUCHE)
                self._esp32.gouvernail_gauche(True)
                self._esp32.propulsion_avant('lent')

    def _maintenir_cap(self):
        """Correcteur P sur le cap magnétique (boussole HMC5883 via ESP32)."""
        compass = self._esp32.lire_compass()
        if not compass.valide:
            return

        erreur = self._cap_cible - compass.heading_deg
        while erreur > 180:  erreur -= 360
        while erreur < -180: erreur += 360

        if abs(erreur) < NAV_TOLERANCE_CAP:
            if self._etat != self.AVANCER:
                self._changer_etat(self.AVANCER)
                self._esp32.gouvernail_centre()
                self._esp32.propulsion_avant('normal')
            return

        correction = NAV_KP_CAP * erreur
        angle_gouv = int(GOUV_CENTRE + correction)
        angle_gouv = max(GOUV_GAUCHE_MAX, min(GOUV_DROITE_MAX, angle_gouv))
        self._esp32.gouvernail(angle_gouv)
        self._esp32.propulsion_avant('normal')
        self._changer_etat(self.VIRER_DROITE if erreur > 0 else self.VIRER_GAUCHE)

    def _guider_vers_cible(self, cible: Balle):
        """
        Guide le bateau vers la balle cible fournie par le C++ (via TraitementBalles).
        Utilise l'angle_deg de la Balle (calculé par le C++) pour commander le gouvernail.

        cible.angle_deg : positif = balle à droite → gouvernail droite
        """
        angle_gouv = int(GOUV_CENTRE + cible.angle_deg * 0.8)
        angle_gouv = max(GOUV_GAUCHE_MAX, min(GOUV_DROITE_MAX, angle_gouv))
        vitesse    = 'lent' if cible.distance_m < 0.8 else 'normal'

        self._esp32.gouvernail(angle_gouv)
        self._esp32.propulsion_avant(vitesse)

        if self._etat != self.SUIVRE_CIBLE:
            logger.info(f"Guidage visuel → {cible}")
        self._changer_etat(self.SUIVRE_CIBLE)

    # =========================================================================
    # UTILITAIRES
    # =========================================================================

    def _changer_etat(self, nouvel_etat: str):
        with self._verrou_etat:
            if self._etat != nouvel_etat:
                logger.debug(f"Nav : {self._etat} → {nouvel_etat}")
            self._etat = nouvel_etat

    @property
    def etat(self) -> str:
        with self._verrou_etat:
            return self._etat

    @property
    def en_mouvement(self) -> bool:
        return self._actif and self._etat != self.STOP
