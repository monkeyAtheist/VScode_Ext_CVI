#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
=====================================================================
  mode_course.py — Épreuve de collecte intelligente (v3)
=====================================================================
  CHANGEMENT v3 :
    La détection des balles vient maintenant du C++ via TraitementBalles.
    Le type d'une balle collectée est lu directement dans l'objet Balle
    construit par traitement_balles.py (qui consomme le C++).

    Plus de lecture du capteur couleur TCS230 pour identifier les balles :
    c'est le C++ (vision par caméra) qui fait cette identification.

  Référence : Cahier des charges §3.8
  Durée max  : 5 minutes (300 secondes)

  Scores (CdC §3.8.2) :
    Ping-pong orange Ø 4 cm → -5  pts
    Piscine rouge    Ø 7 cm → +10 pts
    Piscine autres   Ø 7 cm → -10 pts

  Stratégie de collecte :
    1. Navigation FGM pour explorer le bassin
    2. Dès qu'une balle rouge est visible → mode guidage visuel
    3. À l'approche (< 0.5 m) → activation convoyeur rapide
    4. Identification du type via vision C++ (Balle.type_balle)
    5. Score temps réel sur LCD
    6. Retour au ponton dans les 30 dernières secondes
    7. Verrouillage OBLIGATOIRE
=====================================================================
"""

import math
import time
import threading
from typing import Optional

from logger import get_logger
from config import (
    COLLECTE_DUREE_MAX, COLLECTE_DIST_PONTON,
    SCORE_BASE_COLLECTE, SCORE_PINGPONG_ORANGE,
    SCORE_PISCINE_ROUGE, SCORE_PISCINE_AUTRE,
    SCORE_BONUS_PONTON, SCORE_BONUS_AFFICHEUR,
    CONVOYEUR_VITESSE_NORMAL, CONVOYEUR_VITESSE_RAPIDE,
    LIDAR_ANGLE_AVANT
)
from traitement_balles import Balle

logger = get_logger('ModeCourse')

# Distance seuil pour activer le convoyeur en mode rapide
DIST_COLLECTE_RAPIDE_M = 0.50
# Distance seuil pour considérer qu'une balle est "dans" le système
DIST_BALLE_COLLECTEE_M = 0.20
# Anti-rebond : délai minimum entre deux collectes (secondes)
DELAI_ANTI_REBOND_S    = 1.5


class ModeCourse:
    """
    Gère l'épreuve de collecte intelligente des balles (5 minutes).

    Dépend de :
      ESP32Interface   — actionneurs, convoyeur, LCD
      ControleurLidar  — détection retour ponton
      NavigationGuidage — navigation + guidage visuel
      TraitementBalles  — identification visuelle (backend C++)
    """

    def __init__(self, esp32, lidar, navigation, vision):
        self._esp32    = esp32
        self._lidar    = lidar
        self._nav      = navigation
        self._vision   = vision

        # ── État de l'épreuve ─────────────────────────────────────────────────
        self.score             = 0
        self.score_predit      = 0
        self.premiere_balle    = False
        self.retour_ponton     = False
        self.verrouille        = False
        self._t_debut          = None
        self._en_cours         = False
        self._t_derniere_collecte = 0.0   # Anti-rebond

        # ── Compteur par type ─────────────────────────────────────────────────
        self.comptage = {
            'pingpong_orange': 0,
            'piscine_rouge':   0,
            'piscine_autre':   0,
        }

        self._points_balle = {
            'pingpong_orange': SCORE_PINGPONG_ORANGE,
            'piscine_rouge':   SCORE_PISCINE_ROUGE,
            'piscine_autre':   SCORE_PISCINE_AUTRE,
        }

        self._thread_collecte: Optional[threading.Thread] = None

    # =========================================================================
    # PRÉPARATION
    # =========================================================================

    def preparer(self, score_predit: int = 0):
        """
        Enregistre le score prédit et l'affiche sur le LCD.
        DOIT être appelé AVANT le signal de départ (CdC §3.8.1).
        """
        self.score_predit = score_predit
        logger.info(f"Collecte prête — Score prédit : {score_predit} pts")
        self._esp32.lcd_ecrire("COLLECTE PRETE  ", f"Predit:{score_predit:>8}")

    # =========================================================================
    # CONTRÔLE DE L'ÉPREUVE
    # =========================================================================

    def demarrer(self):
        """
        Lance l'épreuve : navigation + thread de supervision de collecte.
        """
        self._t_debut  = time.time()
        self._en_cours = True
        self.score     = 0

        logger.info("╔══════════════════════════════════════╗")
        logger.info("║   COLLECTE — DÉPART (5 minutes)      ║")
        logger.info(f"║   Score prédit : {self.score_predit:>6} pts          ║")
        logger.info("╚══════════════════════════════════════╝")

        # Guidage visuel vers les balles rouges (vision C++)
        self._nav.activer_mode_cible(True)
        self._nav.demarrer()

        self._thread_collecte = threading.Thread(
            target=self._boucle_collecte,
            name='CollecteThread',
            daemon=True
        )
        self._thread_collecte.start()
        self._esp32.lcd_ecrire("COLLECTE ACTIVE ", f"Score:{self.score:>8}")

    def _boucle_collecte(self):
        """
        Thread de supervision :
          - gère le convoyeur selon la proximité des balles
          - détecte les balles entrées dans le système (via vision C++)
          - met à jour le score et l'afficheur LCD
          - surveille le retour au ponton
          - déclenche le verrouillage à T-0
        """
        while self._en_cours:
            restant = self.temps_restant()

            # ── Fin du temps imparti ──────────────────────────────────────────
            if restant <= 0:
                logger.info("Temps 5min écoulé — verrouillage automatique")
                self.verrouiller()
                return

            # ── Lecture des balles visibles (données C++) ─────────────────────
            balles_proches = [
                b for b in self._vision.balles_detectees()
                if b.distance_m < DIST_COLLECTE_RAPIDE_M
            ]
            balles_collectees = [
                b for b in balles_proches
                if b.distance_m < DIST_BALLE_COLLECTEE_M
            ]

            # ── Gestion du convoyeur ──────────────────────────────────────────
            if balles_proches:
                self._esp32.convoyeur_start(CONVOYEUR_VITESSE_RAPIDE)
            else:
                self._esp32.convoyeur_start(CONVOYEUR_VITESSE_NORMAL)

            # ── Enregistrement des balles collectées (avec anti-rebond) ───────
            now = time.time()
            if balles_collectees and \
               (now - self._t_derniere_collecte) > DELAI_ANTI_REBOND_S:
                # Prend la balle la plus proche et la plus confiante
                balle = max(balles_collectees, key=lambda b: b.confidence)
                self.enregistrer_balle(balle.type_balle)
                self._t_derniere_collecte = now

            # ── Vérification retour ponton ────────────────────────────────────
            self._verifier_retour_ponton()

            # ── 30 dernières secondes : retourner au ponton ───────────────────
            if restant < 30 and not self.retour_ponton:
                self._nav.activer_mode_cible(False)   # Stoppe le guidage balles
                logger.info(f"{restant:.0f}s restantes — tentative retour ponton")

            # ── Mise à jour LCD ───────────────────────────────────────────────
            mins = int(restant) // 60
            secs = int(restant) % 60
            self._esp32.lcd_ecrire(
                f"Score:{self.score:>8}     ",
                f"Restant:{mins:01d}m{secs:02d}s  "
            )

            if int(restant) % 30 == 0 and int(restant) > 0:
                logger.info(f"Collecte : {restant:.0f}s | Score : {self.score}")

            time.sleep(0.3)

    def enregistrer_balle(self, type_balle: str):
        """
        Enregistre une balle collectée et met à jour le score.

        Le type_balle est fourni par le C++ (via l'objet Balle).
        Aucun capteur hardware supplémentaire n'est nécessaire.

        type_balle : 'pingpong_orange' | 'piscine_rouge' | 'piscine_autre'
        """
        if self.verrouille:
            return
        if type_balle not in self._points_balle:
            logger.warning(f"Type balle inconnu : {type_balle}")
            return

        # Bonus de base : première balle (CdC §3.8.2)
        if not self.premiere_balle:
            self.premiere_balle = True
            self.score += SCORE_BASE_COLLECTE
            logger.info(f"1ère balle ! +{SCORE_BASE_COLLECTE} pts de base")

        pts = self._points_balle[type_balle]
        self.score += pts
        self.comptage[type_balle] = self.comptage.get(type_balle, 0) + 1

        signe = '+' if pts >= 0 else ''
        logger.info(
            f"Balle [{type_balle}] → {signe}{pts} pts | "
            f"Total : {self.score} pts | Comptage : {self.comptage}"
        )
        self._esp32.lcd_score(self.score, fige=False)

    def _verifier_retour_ponton(self):
        """Bonus +100 pts si retour au ponton détecté via LiDAR (CdC §3.8.2)."""
        if self.retour_ponton:
            return
        dist = self._lidar.distance_secteur(180, LIDAR_ANGLE_AVANT)
        if dist < COLLECTE_DIST_PONTON:
            self.retour_ponton = True
            self.score += SCORE_BONUS_PONTON
            logger.info(f"Retour ponton ! +{SCORE_BONUS_PONTON} pts")
            self._esp32.lcd_score(self.score, fige=False)

    def verrouiller(self):
        """
        Verrouille le système de collecte — FIN OFFICIELLE (CdC §3.8.2).
        OBLIGATOIRE sous peine de disqualification.
        """
        if self.verrouille:
            return

        self._en_cours  = False
        self.verrouille = True

        self._esp32.convoyeur_stop()
        self._nav.arreter()
        self._esp32.lcd_score(self.score, fige=True)
        self._afficher_bilan()

    # =========================================================================
    # CALCUL DES BONUS
    # =========================================================================

    def calcul_bonus_prediction(self) -> int:
        """Bonus = ceil(0.5 × Score − |Score_réel − Score_prédit|) (CdC §3.8.1)."""
        ecart = abs(self.score - self.score_predit)
        bonus = math.ceil(0.5 * self.score - ecart)
        logger.info(f"Bonus prédiction : ceil(0.5×{self.score} − {ecart}) = {bonus}")
        return bonus

    def calcul_bonus_afficheur(self, ecart_affiche: int = 0) -> int:
        """Bonus afficheur LCD = ceil(0.5 × Score − écart) + 50 (CdC §3.8.3)."""
        bonus = math.ceil(0.5 * self.score - ecart_affiche) + SCORE_BONUS_AFFICHEUR
        logger.info(f"Bonus afficheur : {bonus} pts")
        return bonus

    # =========================================================================
    # UTILITAIRES
    # =========================================================================

    def temps_restant(self) -> float:
        if self._t_debut is None:
            return COLLECTE_DUREE_MAX
        return max(0.0, COLLECTE_DUREE_MAX - (time.time() - self._t_debut))

    def _afficher_bilan(self):
        pp = self.comptage.get('pingpong_orange', 0)
        pr = self.comptage.get('piscine_rouge',   0)
        pa = self.comptage.get('piscine_autre',   0)

        logger.info("╔══════════════════════════════════════════╗")
        logger.info("║         BILAN FINAL — COLLECTE (v3)     ║")
        logger.info("╠══════════════════════════════════════════╣")
        logger.info(f"║  [C++] Ping-pong orange : {pp:>2}  ({SCORE_PINGPONG_ORANGE:+d}pts/balle) ║")
        logger.info(f"║  [C++] Piscine rouge    : {pr:>2}  ({SCORE_PISCINE_ROUGE:+d}pts/balle) ║")
        logger.info(f"║  [C++] Piscine autres   : {pa:>2}  ({SCORE_PISCINE_AUTRE:+d}pts/balle)║")
        if self.premiere_balle:
            logger.info(f"║  Score de base          : +{SCORE_BASE_COLLECTE} pts              ║")
        if self.retour_ponton:
            logger.info(f"║  Bonus ponton           : +{SCORE_BONUS_PONTON} pts             ║")
        logger.info("╠══════════════════════════════════════════╣")
        logger.info(f"║  SCORE TOTAL            : {self.score:>8} pts        ║")
        logger.info(f"║  Score prédit           : {self.score_predit:>8} pts        ║")
        logger.info(f"║  Bonus prédiction       : {self.calcul_bonus_prediction():>8} pts        ║")
        logger.info("╚══════════════════════════════════════════╝")
