#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
=====================================================================
  traitement_balles.py — Traitement et classification des balles
=====================================================================
  CHANGEMENT v3 :
    Ce module ne fait plus de traitement vidéo OpenCV directement.
    Il consomme les détections brutes produites par le programme C++
    (via camera_client.py) et les convertit en objets Balle Python
    avec leur logique métier (priorité, score, filtrage).

  Responsabilités de ce module :
    1. Recevoir les dicts bruts du C++ (via CameraClient)
    2. Les convertir en dataclasses Balle typées
    3. Appliquer les règles métier : score, priorité, filtrage
    4. Exposer une interface identique à la v2 (drop-in replacement)

  Responsabilités du C++ (NON gérées ici) :
    - Capture vidéo
    - Traitement d'image (HSV, contours, filtres)
    - Estimation de la distance (formule sténopé)
    - Calcul de l'angle horizontal

  Contrat attendu du C++ pour chaque détection :
    {
      "type":        "pingpong_orange" | "piscine_rouge" | "piscine_autre",
      "cx":          int,      # centre X en pixels
      "cy":          int,      # centre Y en pixels
      "rayon_px":    float,    # rayon en pixels
      "distance_m":  float,    # distance en mètres
      "angle_deg":   float,    # angle horizontal (°, + = droite)
      "confidence":  float     # 0.0 – 1.0
    }

  Filtres appliqués côté Python :
    - confidence >= SEUIL_CONFIANCE_MIN
    - distance_m dans [DIST_MIN_M, DIST_MAX_M]
    - type_balle reconnu dans la table des scores
=====================================================================
"""

import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from logger import get_logger
from config import (
    SCORE_PINGPONG_ORANGE, SCORE_PISCINE_ROUGE, SCORE_PISCINE_AUTRE
)

logger = get_logger('TraitementBalles')

# ── Filtres de qualité appliqués aux détections C++ ───────────────────────────
SEUIL_CONFIANCE_MIN = 0.50   # Confiance minimale acceptée (0.0–1.0)
DIST_MIN_M          = 0.10   # Distance minimale en mètres (bruit de proximité)
DIST_MAX_M          = 6.00   # Distance maximale fiable en mètres

# Table des scores métier (CdC §3.8.2)
_SCORE_PAR_TYPE: Dict[str, int] = {
    'pingpong_orange': SCORE_PINGPONG_ORANGE,   # -5  pts
    'piscine_rouge':   SCORE_PISCINE_ROUGE,     # +10 pts
    'piscine_autre':   SCORE_PISCINE_AUTRE,     # -10 pts
}


# =====================================================================
# DATACLASSE — Balle détectée
# =====================================================================

@dataclass
class Balle:
    """
    Représente une balle détectée et classifiée.

    Construite depuis un dict brut fourni par le C++.
    Ajoute la logique métier : score, priorité, collectibilité.
    """
    type_balle:  str   = 'inconnue'
    score:       int   = 0
    distance_m:  float = 0.0
    angle_deg:   float = 0.0
    cx:          int   = 0          # Centre X dans l'image (pixels)
    cy:          int   = 0          # Centre Y dans l'image (pixels)
    rayon_px:    float = 0.0
    confidence:  float = 0.0       # Score de confiance du C++ (0–1)
    timestamp:   float = field(default_factory=time.time)

    # ── Méthodes de commodité ─────────────────────────────────────────────────

    @property
    def est_collectible(self) -> bool:
        """True si la collecte de cette balle rapporte des points (> 0)."""
        return self.score > 0

    @property
    def priorite(self) -> float:
        """
        Score de priorité de collecte.
        Formule : score / distance → la balle rouge proche = priorité max.
        Une balle négative ou inconnue retourne 0 (pas de priorité).
        """
        if self.score <= 0 or self.distance_m <= 0:
            return 0.0
        return self.score / self.distance_m

    @classmethod
    def depuis_dict(cls, d: Dict) -> Optional['Balle']:
        """
        Construit une Balle depuis le dict brut renvoyé par le C++.

        Retourne None si le dict ne passe pas les filtres de qualité :
          - type_balle inconnu
          - confidence trop faible
          - distance hors plage

        d : dict brut de la détection C++ (voir contrat dans l'en-tête)
        """
        type_balle = d.get('type', 'inconnue')
        if type_balle not in _SCORE_PAR_TYPE:
            logger.debug(f"Type balle inconnu ignoré : '{type_balle}'")
            return None

        confidence = float(d.get('confidence', 0.0))
        if confidence < SEUIL_CONFIANCE_MIN:
            logger.debug(
                f"Détection ignorée (confidence {confidence:.2f} < "
                f"{SEUIL_CONFIANCE_MIN})"
            )
            return None

        distance_m = float(d.get('distance_m', 0.0))
        if not (DIST_MIN_M <= distance_m <= DIST_MAX_M):
            logger.debug(
                f"Détection ignorée (distance {distance_m:.2f}m "
                f"hors plage [{DIST_MIN_M}, {DIST_MAX_M}]m)"
            )
            return None

        return cls(
            type_balle  = type_balle,
            score       = _SCORE_PAR_TYPE[type_balle],
            distance_m  = round(distance_m, 3),
            angle_deg   = round(float(d.get('angle_deg', 0.0)), 1),
            cx          = int(d.get('cx', 0)),
            cy          = int(d.get('cy', 0)),
            rayon_px    = float(d.get('rayon_px', 0.0)),
            confidence  = round(confidence, 3),
        )

    def __str__(self) -> str:
        return (
            f"Balle({self.type_balle} | "
            f"{self.score:+d}pts | "
            f"dist:{self.distance_m:.2f}m | "
            f"angle:{self.angle_deg:+.1f}° | "
            f"conf:{self.confidence:.2f})"
        )


# =====================================================================
# CLASSE PRINCIPALE
# =====================================================================

class TraitementBalles:
    """
    Couche métier des balles — consomme les détections du C++ et
    expose une interface haut niveau au reste du robot.

    Dépend de :
      CameraClient — pour obtenir les détections brutes du C++

    Cette classe ne fait AUCUN traitement d'image.
    Elle délègue entièrement la vision au processus C++.

    Utilisation :
        vision = TraitementBalles(camera_client)
        balles = vision.balles_detectees()
        cible  = vision.meilleure_cible()
    """

    def __init__(self, camera_client):
        """
        camera_client : instance de CameraClient
        """
        self._client = camera_client
        self._nb_conversions = 0
        self._nb_ignorees    = 0
        logger.info("Module TraitementBalles initialisé (backend C++)")

    # =========================================================================
    # CONVERSION DES DÉTECTIONS BRUTES
    # =========================================================================

    def _convertir_detections(self) -> List[Balle]:
        """
        Lit les détections brutes du C++ (via le cache du CameraClient)
        et les convertit en objets Balle avec filtrage qualité.

        Les détections refusées (mauvaise confiance, distance hors plage)
        sont comptabilisées et loggées en DEBUG.
        """
        brutes = self._client.lire_detections_brutes()
        balles: List[Balle] = []

        for d in brutes:
            balle = Balle.depuis_dict(d)
            if balle is not None:
                balles.append(balle)
                self._nb_conversions += 1
            else:
                self._nb_ignorees += 1

        return balles

    # =========================================================================
    # INTERFACE PUBLIQUE — identique à la v2
    # =========================================================================

    def balles_detectees(self) -> List[Balle]:
        """
        Retourne la liste de toutes les balles détectées et valides
        (après filtrage confiance et distance).
        """
        return self._convertir_detections()

    def balles_positives(self) -> List[Balle]:
        """Retourne uniquement les balles dont la collecte rapporte des points."""
        return [b for b in self.balles_detectees() if b.score > 0]

    def balles_negatives(self) -> List[Balle]:
        """Retourne les balles dont la collecte fait perdre des points."""
        return [b for b in self.balles_detectees() if b.score < 0]

    def meilleure_cible(self) -> Optional[Balle]:
        """
        Retourne la balle avec la meilleure priorité de collecte.
        Priorité = score / distance (balle rouge proche = priorité max).
        Retourne None si aucune balle positive n'est visible.
        """
        positives = self.balles_positives()
        if not positives:
            return None
        return max(positives, key=lambda b: b.priorite)

    def balle_la_plus_proche(self) -> Optional[Balle]:
        """Retourne la balle (toutes confondues) la plus proche du robot."""
        balles = self.balles_detectees()
        if not balles:
            return None
        return min(balles, key=lambda b: b.distance_m)

    def nb_balles_par_type(self) -> Dict[str, int]:
        """
        Retourne le nombre de balles visibles par type.
        Utile pour les logs et l'affichage LCD.
        """
        comptage: Dict[str, int] = {}
        for b in self.balles_detectees():
            comptage[b.type_balle] = comptage.get(b.type_balle, 0) + 1
        return comptage

    def stats(self) -> Dict:
        """Statistiques du module de traitement."""
        return {
            'conversions_ok':  self._nb_conversions,
            'ignorees':        self._nb_ignorees,
            'balles_visibles': len(self.balles_detectees()),
            'client_stats':    self._client.stats(),
        }

    # =========================================================================
    # MÉTHODES DÉLÉGUÉES AU CLIENT
    # =========================================================================

    def demarrer(self) -> bool:
        """Délègue le démarrage au CameraClient."""
        return self._client.demarrer()

    def arreter(self):
        """Délègue l'arrêt au CameraClient."""
        self._client.arreter()
