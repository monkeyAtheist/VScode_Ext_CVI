#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
=====================================================================
  logger.py — Logger partagé pour tous les modules du projet
=====================================================================
  Chaque module appelle get_logger('NomModule') pour obtenir
  un logger nommé héritant de la configuration commune.
  Sortie : console (stdout) + fichier robot_bateau.log
=====================================================================
"""

import logging
import sys
from datetime import datetime


def get_logger(name: str) -> logging.Logger:
    """
    Retourne un logger nommé 'BateauRobot.<name>'.
    Les handlers ne sont configurés qu'une seule fois sur le logger racine.
    """
    root = logging.getLogger('BateauRobot')

    if not root.handlers:
        root.setLevel(logging.INFO)

        fmt = logging.Formatter(
            fmt='%(asctime)s  [%(levelname)-8s]  %(name)-28s : %(message)s',
            datefmt='%H:%M:%S'
        )

        # Handler console — niveau INFO
        ch = logging.StreamHandler(sys.stdout)
        ch.setLevel(logging.INFO)
        ch.setFormatter(fmt)
        root.addHandler(ch)

        # Handler fichier — niveau DEBUG (logs complets pour analyse post-course)
        log_filename = f"robot_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"
        fh = logging.FileHandler(log_filename, encoding='utf-8')
        fh.setLevel(logging.DEBUG)
        fh.setFormatter(fmt)
        root.addHandler(fh)

    return logging.getLogger(f'BateauRobot.{name}')
