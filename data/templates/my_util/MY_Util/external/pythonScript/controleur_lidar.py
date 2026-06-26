#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
=====================================================================
  controleur_lidar.py — Interface RPLidar C1 (USB direct sur Pi)
=====================================================================
  Le RPLidar C1 est le SEUL capteur branché directement sur la
  Raspberry Pi (USB) et non via l'ESP32.

  Il fournit un scan 360° continu mis à jour dans un thread daemon.
  Les données sont accessibles via des méthodes thread-safe.

  Convention angulaire (0° = avant du bateau) :
      0°   → avant      90°  → droite
      180° → arrière    270° → gauche
=====================================================================
"""

import math
import threading
import time

from logger import get_logger
from config import (
    LIDAR_PORT, LIDAR_DIST_URGENCE, LIDAR_DIST_EVITEMENT,
    LIDAR_ANGLE_AVANT, LIDAR_ANGLE_LATERAL
)

try:
    from rplidar import RPLidar as _RPLidar
except ImportError:
    _RPLidar = None
    print("[AVERTISSEMENT] rplidar absent — pip3 install rplidar-roboticia")

logger = get_logger('LiDAR')


class ControleurLidar:
    """
    Encapsule la communication avec le RPLidar C1 branché en USB.

    Le scan est stocké dans un dict {angle (0–359): distance (mm)}
    mis à jour en continu par un thread daemon.

    Méthodes principales :
      demarrer()                → lance la lecture
      arreter()                 → arrêt propre
      distance_secteur(a, da)   → distance minimale dans un secteur
      lire_directions()         → dict des 6 distances directionnelles
      collision_imminente()     → bool urgence
      scan_complet()            → dict complet {angle: distance}
    """

    def __init__(self, port: str = LIDAR_PORT):
        self._port   = port
        self._lidar  = None
        self._scan   = {}
        self._lock   = threading.Lock()
        self._actif  = False
        self._thread = None
        self._nb_scans = 0

    # =========================================================================
    # DÉMARRAGE / ARRÊT
    # =========================================================================

    def demarrer(self) -> bool:
        """
        Démarre le LiDAR et son thread de lecture.
        Attend 2.5 s pour la montée en vitesse du moteur interne.
        """
        if _RPLidar is None:
            logger.error("Bibliothèque rplidar non disponible — LiDAR désactivé")
            return False
        try:
            self._lidar = _RPLidar(self._port)
            self._actif = True
            self._thread = threading.Thread(
                target=self._lire_en_continu,
                name='LidarThread',
                daemon=True
            )
            self._thread.start()
            time.sleep(2.5)  # Montée en vitesse du moteur LiDAR
            logger.info(f"RPLidar C1 démarré sur {self._port}")
            return True
        except Exception as err:
            logger.error(f"Échec démarrage LiDAR : {err}")
            return False

    def arreter(self):
        """Arrête proprement le LiDAR et son thread."""
        self._actif = False
        if self._lidar:
            try:
                self._lidar.stop()
                self._lidar.stop_motor()
                self._lidar.disconnect()
            except Exception:
                pass
        logger.info(f"LiDAR arrêté — {self._nb_scans} scans effectués")

    # =========================================================================
    # THREAD DE LECTURE
    # =========================================================================

    def _lire_en_continu(self):
        """
        Boucle de lecture des scans (thread daemon).
        Chaque scan est un itérable de triplets (qualité, angle, distance_mm).
        """
        try:
            for scan in self._lidar.iter_scans():
                if not self._actif:
                    break
                self._nb_scans += 1
                with self._lock:
                    for (_, angle, distance) in scan:
                        if distance > 0:
                            a = int(round(angle)) % 360
                            self._scan[a] = distance
        except Exception as err:
            if self._actif:
                logger.error(f"Erreur lecture LiDAR : {err}")

    # =========================================================================
    # CONSULTATION DES DONNÉES (thread-safe)
    # =========================================================================

    def distance_secteur(self, centre: float, demi_angle: float) -> float:
        """
        Retourne la distance minimale dans un secteur angulaire.

        centre     : angle central du secteur (0–360°)
        demi_angle : demi-largeur du secteur (degrés)
        Retourne   : distance min en mm, ou math.inf si aucune mesure
        """
        valeurs = []
        with self._lock:
            for angle, dist in self._scan.items():
                diff = abs(angle - centre) % 360
                if diff > 180:
                    diff = 360 - diff
                if diff <= demi_angle:
                    valeurs.append(dist)
        return min(valeurs) if valeurs else math.inf

    def lire_directions(self) -> dict:
        """
        Retourne un dictionnaire avec les distances dans 6 directions.

        Clés : 'avant', 'avant_droite', 'droite',
               'arriere', 'gauche', 'avant_gauche'
        """
        return {
            'avant':        self.distance_secteur(0,   LIDAR_ANGLE_AVANT),
            'avant_droite': self.distance_secteur(45,  LIDAR_ANGLE_AVANT),
            'droite':       self.distance_secteur(90,  LIDAR_ANGLE_LATERAL),
            'arriere':      self.distance_secteur(180, LIDAR_ANGLE_AVANT),
            'gauche':       self.distance_secteur(270, LIDAR_ANGLE_LATERAL),
            'avant_gauche': self.distance_secteur(315, LIDAR_ANGLE_AVANT),
        }

    def collision_imminente(self) -> bool:
        """Retourne True si obstacle < LIDAR_DIST_URGENCE devant le robot."""
        return self.distance_secteur(0, LIDAR_ANGLE_AVANT) < LIDAR_DIST_URGENCE

    def obstacle_en_approche(self) -> bool:
        """Retourne True si obstacle < LIDAR_DIST_EVITEMENT devant le robot."""
        return self.distance_secteur(0, LIDAR_ANGLE_AVANT) < LIDAR_DIST_EVITEMENT

    def scan_complet(self) -> dict:
        """Retourne une copie du scan 360° courant {angle: distance_mm}."""
        with self._lock:
            return dict(self._scan)

    def est_pret(self) -> bool:
        """Retourne True si le LiDAR a déjà effectué au moins un scan."""
        return self._nb_scans > 0
