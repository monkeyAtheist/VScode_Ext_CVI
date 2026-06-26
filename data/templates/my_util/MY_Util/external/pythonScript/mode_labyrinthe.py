#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
=====================================================================
  mode_labyrinthe.py — Épreuve contre-la-montre (labyrinthe)
=====================================================================
  Référence : Cahier des charges §3.7

  Règles :
    - Parcours aller-retour dans un labyrinthe de flotteurs
    - Départ = arrivée (même zone, ponton)
    - Largeur minimale entre obstacles : 1 m
    - Aucune impasse dans le labyrinthe
    - Malus : +2 secondes par contact avec un obstacle
    - Disqualification si circuit non complété
    - Toute assistance manuelle = disqualification

  Algorithme de navigation dans le labyrinthe :
    → Wall-Following simplifié (suivre la paroi droite par défaut)
       combiné avec le Follow-the-Gap du module navigation.
    → La détection de la zone de retour s'effectue par mesure
       de la distance arrière (LiDAR) — courte = ponton proche.

  Calcul des points (N équipes, P position classement) :
    1ère place : 200 pts
    Autres     : ceil(2 × (N - P + 1) × 100 / N)
=====================================================================
"""

import math
import threading
import time

from logger import get_logger
from config import (
    LABY_MALUS_CONTACT_S, LABY_DIST_WALL_FOLLOW,
    LIDAR_DIST_EVITEMENT, LIDAR_ANGLE_AVANT, LIDAR_ANGLE_LATERAL,
    NAV_PERIODE_S, GOUV_CENTRE
)

logger = get_logger('ModeLabyrinthe')


class ModeLabyrinthe:
    """
    Gère l'épreuve de contre-la-montre dans le labyrinthe de flotteurs.

    Dépend de :
      ESP32Interface   — actionneurs (propulsion, gouvernail)
      ControleurLidar  — distances aux obstacles
      NavigationGuidage — navigation autonome de base

    Cycle de vie d'une épreuve :
      1. préparer()        → arme l'ESC, vérifie les capteurs
      2. demarrer()        → lance le chrono + la navigation labyrinthe
      3. [automatique]     → navigation jusqu'au retour au ponton
      4. terminer()        → arrêt + calcul du temps final
         OU terminer est appelé automatiquement si ponton détecté

    La détection de contact est gérée via le callback signaler_contact().
    """

    def __init__(self, esp32, lidar, navigation):
        self._esp32      = esp32
        self._lidar      = lidar
        self._nav        = navigation

        self._t_debut    = None
        self._t_fin      = None
        self._contacts   = 0
        self._en_cours   = False
        self._retour_ok  = False

        self._thread_laby = None

    # =========================================================================
    # PRÉPARATION
    # =========================================================================

    def preparer(self) -> bool:
        """
        Vérifie que tous les capteurs sont opérationnels avant le départ.
        Affiche un message de préparation sur le LCD.
        Retourne True si le robot est prêt.
        """
        logger.info("=== Préparation épreuve LABYRINTHE ===")
        self._esp32.lcd_ecrire("LABYRINTHE PRET ", "En attente dep.")

        # Vérification LiDAR
        if not self._lidar.est_pret():
            logger.error("LiDAR non prêt — épreuve annulée")
            self._esp32.lcd_ecrire("ERREUR LiDAR    ", "Pas de signal!")
            return False

        # Vérification boussole
        compass = self._esp32.lire_compass()
        if not compass.valide:
            logger.warning("Boussole non disponible — navigation sans cap absolu")

        logger.info("Robot prêt pour le labyrinthe")
        return True

    # =========================================================================
    # CONTRÔLE DE L'ÉPREUVE
    # =========================================================================

    def demarrer(self):
        """
        Démarre le chronomètre et la navigation autonome dans le labyrinthe.
        À appeler au signal du jury, au départ de la zone.
        """
        self._t_debut   = time.time()
        self._contacts  = 0
        self._retour_ok = False
        self._en_cours  = True

        logger.info("╔══════════════════════════════════╗")
        logger.info("║   LABYRINTHE — DÉPART CHRONO     ║")
        logger.info("╚══════════════════════════════════╝")
        self._esp32.lcd_ecrire("LABYRINTHE GO!  ", "Chrono lance!")

        # Lancement de la navigation labyrinthe dans un thread dédié
        self._thread_laby = threading.Thread(
            target=self._boucle_labyrinthe,
            name='LabyrintheThread',
            daemon=True
        )
        self._thread_laby.start()

    def signaler_contact(self):
        """
        Enregistre un contact avec un obstacle du parcours.
        Malus : +LABY_MALUS_CONTACT_S secondes au temps final.
        """
        self._contacts += 1
        malus = self._contacts * LABY_MALUS_CONTACT_S
        logger.warning(
            f"Contact #{self._contacts} enregistré "
            f"(malus total : +{malus}s)"
        )

    def terminer(self) -> float:
        """
        Arrête le chrono et la navigation.
        Retourne le temps final corrigé (brut + malus contacts).
        """
        self._en_cours = False
        self._t_fin = time.time()
        self._nav.arreter()
        self._esp32.arret_total()

        temps_brut  = self._t_fin - self._t_debut
        malus_total = self._contacts * LABY_MALUS_CONTACT_S
        temps_final = temps_brut + malus_total

        logger.info("╔══════════════════════════════════════╗")
        logger.info("║   LABYRINTHE — RÉSULTATS             ║")
        logger.info(f"║  Temps brut   : {temps_brut:>8.2f} s        ║")
        logger.info(f"║  Contacts     : {self._contacts:>2}  (+{malus_total}s)      ║")
        logger.info(f"║  TEMPS FINAL  : {temps_final:>8.2f} s        ║")
        logger.info("╚══════════════════════════════════════╝")

        self._esp32.lcd_ecrire(
            f"TEMPS:{temps_final:.1f}s   ",
            f"Contacts:{self._contacts:>2}       "
        )
        return temps_final

    # =========================================================================
    # BOUCLE DE NAVIGATION DANS LE LABYRINTHE
    # =========================================================================

    def _boucle_labyrinthe(self):
        """
        Boucle de navigation spécifique au labyrinthe.
        Combine wall-following et Follow-the-Gap.

        Stratégie :
          - Priorité absolue : obstacles devant (FGM)
          - Sinon : tenter de suivre la paroi droite (mur droit)
          - Détection de la fin : distance arrière < seuil ponton
        """
        self._nav.demarrer()

        while self._en_cours:
            dist = self._lidar.lire_directions()
            d_avant  = dist.get('avant',  math.inf)
            d_droite = dist.get('droite', math.inf)
            d_gauche = dist.get('gauche', math.inf)
            d_arriere = dist.get('arriere', math.inf)

            # ── Détection du retour au ponton ─────────────────────────────────
            # La paroi arrière devient proche quand le robot est revenu
            if d_arriere < 300 and self._t_debut and \
               (time.time() - self._t_debut) > 15.0:
                if not self._retour_ok:
                    logger.info("Zone de départ détectée — circuit complété !")
                    self._retour_ok = True
                    self.terminer()
                    return

            # La navigation est déléguée au module NavigationGuidage (FGM)
            # La boucle ici se concentre sur le suivi de paroi (wall-following)
            if d_avant > LIDAR_DIST_EVITEMENT:
                self._wall_following(d_droite, d_gauche)

            time.sleep(NAV_PERIODE_S)

    def _wall_following(self, d_droite: float, d_gauche: float):
        """
        Suivi de paroi simple : maintient une distance constante
        de la paroi droite (LABY_DIST_WALL_FOLLOW).

        Si la paroi droite est trop proche  → corriger à gauche
        Si la paroi droite est trop lointaine → corriger à droite
        Sinon → avancer tout droit
        """
        erreur = LABY_DIST_WALL_FOLLOW - d_droite

        if abs(erreur) < 80:
            # Dans la zone de tolérance : ligne droite
            self._esp32.gouvernail_centre()
            self._esp32.propulsion_avant('normal')
            return

        if erreur > 0:
            # Trop proche de la paroi droite → corriger à gauche
            self._esp32.gouvernail_gauche(False)  # Correction légère
        else:
            # Trop loin de la paroi droite → corriger à droite
            self._esp32.gouvernail_droite(False)  # Correction légère

        self._esp32.propulsion_avant('normal')
        logger.debug(f"Wall-following : droite={d_droite:.0f}mm erreur={erreur:.0f}mm")

    # =========================================================================
    # CALCUL DES POINTS (statique, appelé après classement)
    # =========================================================================

    @staticmethod
    def calculer_points(position: int, nb_equipes: int) -> int:
        """
        Calcule les points obtenus selon la position dans le classement.

        Formule CdC §3.7.1 :
          - 1ère place : 200 pts
          - Autres : ceil(2 × (N - P + 1) × 100 / N)

        position   : rang (1 = premier)
        nb_equipes : nombre total d'équipes qualifiées
        """
        if nb_equipes <= 0:
            return 0
        if position == 1:
            return 200
        pts = math.ceil(2 * (nb_equipes - position + 1) * 100 / nb_equipes)
        logger.info(
            f"Points labyrinthe P={position}/N={nb_equipes} "
            f"→ ceil(2×({nb_equipes}-{position}+1)×100/{nb_equipes}) = {pts}"
        )
        return pts

    # =========================================================================
    # PROPRIÉTÉS
    # =========================================================================

    @property
    def temps_ecoule(self) -> float:
        """Temps écoulé depuis le départ (0 si non démarré)."""
        if self._t_debut is None:
            return 0.0
        fin = self._t_fin if self._t_fin else time.time()
        return fin - self._t_debut

    @property
    def circuit_complete(self) -> bool:
        """True si le robot a complété le circuit."""
        return self._retour_ok
