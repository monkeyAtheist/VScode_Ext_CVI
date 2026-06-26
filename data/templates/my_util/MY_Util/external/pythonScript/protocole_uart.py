#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
=====================================================================
  protocole_uart.py — Définition du protocole de communication UART
=====================================================================
  Architecture de communication :
    Raspberry Pi 4 ──[UART /dev/ttyAMA0 @ 115200]──▶ ESP32

  Format des trames (JSON Lines — une commande par ligne) :
  ┌─────────────────────────────────────────────────────────────┐
  │  ENVOI (Pi → ESP32)                                         │
  │  {"cmd": "NOM_CMD", "params": {...}}\n                      │
  │                                                             │
  │  RÉPONSE (ESP32 → Pi)                                       │
  │  {"status": "ok"|"error", "data": {...}, "msg": "..."}\n   │
  └─────────────────────────────────────────────────────────────┘

  Chaque classe de trame fournit :
    - build()  → bytes prêts à envoyer sur l'UART
    - parse()  → dict Python depuis une réponse JSON reçue

  Toutes les classes héritent de TrameBase.
=====================================================================
"""

import json
from dataclasses import dataclass, field
from typing import Any, Optional


# =====================================================================
# CLASSE DE BASE
# =====================================================================

class TrameBase:
    """
    Classe de base pour toutes les trames du protocole.
    Fournit les méthodes build() et parse().
    """
    CMD = ""   # Nom de la commande — à surcharger dans chaque sous-classe

    def _payload(self) -> dict:
        """
        Retourne le dictionnaire de paramètres de la trame.
        À surcharger dans les sous-classes si des paramètres sont nécessaires.
        """
        return {}

    def build(self) -> bytes:
        """
        Sérialise la trame en bytes UTF-8 avec délimiteur '\n'.
        Format : {"cmd": "...", "params": {...}}\n
        """
        trame = {"cmd": self.CMD, "params": self._payload()}
        return (json.dumps(trame, ensure_ascii=False) + '\n').encode('utf-8')

    @staticmethod
    def parse(ligne: str) -> dict:
        """
        Désérialise une ligne JSON reçue de l'ESP32.
        Retourne un dict vide en cas d'erreur de parsing.

        ligne : chaîne de caractères brute (avec ou sans '\n')
        """
        try:
            return json.loads(ligne.strip())
        except json.JSONDecodeError:
            return {}

    @staticmethod
    def est_ok(reponse: dict) -> bool:
        """Retourne True si la réponse indique un succès."""
        return reponse.get('status') == 'ok'

    @staticmethod
    def get_data(reponse: dict) -> dict:
        """Extrait le champ 'data' d'une réponse, ou {} si absent."""
        return reponse.get('data', {})


# =====================================================================
# TRAMES SYSTÈME
# =====================================================================

class TramePing(TrameBase):
    """
    Heartbeat — vérifie que l'ESP32 est connecté et opérationnel.
    Réponse attendue : {"status": "ok", "data": {"uptime_ms": 12345}}
    """
    CMD = "PING"


class TrameGetStatus(TrameBase):
    """
    Demande l'état complet de tous les sous-systèmes de l'ESP32.
    Réponse contient les états : GPS, IMU, compass, baro, urgence, etc.
    """
    CMD = "GET_STATUS"


class TrameArretTotal(TrameBase):
    """
    Arrêt immédiat de TOUS les actionneurs (ESC, servo, convoyeur).
    Commande de sécurité — réponse attendue immédiatement.
    """
    CMD = "ARRET_TOTAL"


# =====================================================================
# TRAMES PROPULSION (PCA9685)
# =====================================================================

class TrameMoteurPropulsion(TrameBase):
    """
    Commande de l'ESC via le PCA9685 du canal propulsion.
    La valeur est en microsecondes (µs) — standard PPM pour ESC brushless.

    valeur_us : int entre 1000 µs (arrière) et 2000 µs (avant)
                1500 µs = neutre / arrêt
    """
    CMD = "MOTOR_PROPULSION"

    def __init__(self, valeur_us: int):
        # Limites de sécurité matérielle
        self.valeur_us = max(1000, min(2000, int(valeur_us)))

    def _payload(self) -> dict:
        return {"us": self.valeur_us}


class TrameServoGouvernail(TrameBase):
    """
    Commande du servo gouvernail via le PCA9685.
    L'angle est en degrés (0°–180°).

    angle_deg : int — 90° = centre, >90° = droite, <90° = gauche
    """
    CMD = "SERVO_GOUVERNAIL"

    def __init__(self, angle_deg: int):
        self.angle_deg = max(0, min(180, int(angle_deg)))

    def _payload(self) -> dict:
        return {"angle": self.angle_deg}


# =====================================================================
# TRAMES CONVOYEUR (DRV8833)
# =====================================================================

class TrameConvoyeur(TrameBase):
    """
    Commande du moteur de convoyeur (ramassage des balles) via DRV8833.

    vitesse   : int 0–100 (% de la vitesse maximale)
    direction : str 'avant' | 'arriere' | 'stop'
    """
    CMD = "CONVOYEUR"

    def __init__(self, vitesse: int, direction: str = 'avant'):
        self.vitesse   = max(0, min(100, int(vitesse)))
        self.direction = direction if direction in ('avant', 'arriere', 'stop') else 'stop'

    def _payload(self) -> dict:
        return {"vitesse": self.vitesse, "direction": self.direction}


# =====================================================================
# TRAMES AFFICHEUR LCD
# =====================================================================

class TrameLCDEcrire(TrameBase):
    """
    Envoie deux lignes à afficher sur le LCD 1602 (max 16 car. chacune).

    ligne1 : str — ligne supérieure du LCD
    ligne2 : str — ligne inférieure du LCD (facultatif)
    """
    CMD = "LCD_WRITE"

    def __init__(self, ligne1: str, ligne2: str = ''):
        self.ligne1 = ligne1[:16]
        self.ligne2 = ligne2[:16]

    def _payload(self) -> dict:
        return {"l1": self.ligne1, "l2": self.ligne2}


class TrameLCDEffacer(TrameBase):
    """Efface le contenu du LCD 1602."""
    CMD = "LCD_CLEAR"


# =====================================================================
# TRAMES CAPTEURS — LECTURE
# =====================================================================

class TrameGetIMU(TrameBase):
    """
    Lecture MPU-6050 : accélération (g) et vitesse angulaire (°/s).
    Réponse data : {ax, ay, az, gx, gy, gz, temp_c}
    """
    CMD = "GET_IMU"


class TrameGetCompass(TrameBase):
    """
    Lecture HMC5883 : cap magnétique.
    Réponse data : {heading_deg, mx, my, mz}
    """
    CMD = "GET_COMPASS"


class TrameGetGPS(TrameBase):
    """
    Lecture GPS : position et vitesse.
    Réponse data : {lat, lon, alt_m, speed_kmh, fix, satellites, hdop}
    """
    CMD = "GET_GPS"


class TrameGetBaro(TrameBase):
    """
    Lecture BMP280 : pression, température, altitude estimée.
    Réponse data : {temp_c, pression_hpa, altitude_m}
    """
    CMD = "GET_BARO"


class TrameGetRTC(TrameBase):
    """
    Lecture DS3231 : date et heure précises.
    Réponse data : {datetime_iso: "2025-08-01T10:30:00"}
    """
    CMD = "GET_RTC"


class TrameGetUrgence(TrameBase):
    """
    État du bouton d'arrêt d'urgence géré par l'ESP32.
    Réponse data : {actif: true|false}
    """
    CMD = "GET_URGENCE"


# =====================================================================
# TRAMES STABILISATEUR
# =====================================================================

class TrameStabilisateur(TrameBase):
    """
    Active ou désactive le stabilisateur de roulis (géré par ESP32).
    Le stabilisateur utilise les données MPU-6050 pour compenser.

    actif : bool
    """
    CMD = "STABILISATEUR"

    def __init__(self, actif: bool):
        self.actif = actif

    def _payload(self) -> dict:
        return {"actif": self.actif}


# =====================================================================
# TRAMES EEPROM (AT24CS64)
# =====================================================================

class TrameEEPROMEcrire(TrameBase):
    """
    Écriture d'une valeur dans l'EEPROM AT24CS64.
    Utilisation : sauvegarder paramètres, compteurs, etc.

    adresse : int (0–8191 pour 64 Kbit)
    valeur  : int (0–255, 1 octet)
    """
    CMD = "EEPROM_WRITE"

    def __init__(self, adresse: int, valeur: int):
        self.adresse = adresse
        self.valeur  = valeur & 0xFF

    def _payload(self) -> dict:
        return {"addr": self.adresse, "val": self.valeur}


class TrameEEPROMLire(TrameBase):
    """
    Lecture d'une valeur depuis l'EEPROM AT24CS64.
    Réponse data : {addr: x, val: y}
    """
    CMD = "EEPROM_READ"

    def __init__(self, adresse: int):
        self.adresse = adresse

    def _payload(self) -> dict:
        return {"addr": self.adresse}


# =====================================================================
# TRAME COPROCESSEUR ATmega328
# =====================================================================

class TrameCoprocesseur(TrameBase):
    """
    Commande déléguée au coprocesseur ATmega328 via l'ESP32.
    Le contenu de 'payload' dépend du firmware du coprocesseur.

    commande : str — identifiant de la commande ATmega
    params   : dict — paramètres de la commande
    """
    CMD = "COPROCESSEUR"

    def __init__(self, commande: str, params: dict = None):
        self.commande = commande
        self.params   = params or {}

    def _payload(self) -> dict:
        return {"sub_cmd": self.commande, "sub_params": self.params}


# =====================================================================
# DATACLASSES — Structures de données des capteurs
# =====================================================================

@dataclass
class DonneesIMU:
    """Données brutes du MPU-6050."""
    ax: float = 0.0          # Accélération X (g)
    ay: float = 0.0          # Accélération Y (g)
    az: float = 0.0          # Accélération Z (g)
    gx: float = 0.0          # Gyro X (°/s)
    gy: float = 0.0          # Gyro Y (°/s)
    gz: float = 0.0          # Gyro Z (°/s)
    temp_c: float = 0.0      # Température capteur (°C)
    valide: bool = False

    @classmethod
    def depuis_dict(cls, d: dict) -> 'DonneesIMU':
        return cls(
            ax=d.get('ax', 0.0), ay=d.get('ay', 0.0), az=d.get('az', 0.0),
            gx=d.get('gx', 0.0), gy=d.get('gy', 0.0), gz=d.get('gz', 0.0),
            temp_c=d.get('temp_c', 0.0), valide=True
        )


@dataclass
class DonneesCompass:
    """Données du magnétomètre HMC5883."""
    heading_deg: float = 0.0   # Cap magnétique (0° = Nord)
    mx: float = 0.0
    my: float = 0.0
    mz: float = 0.0
    valide: bool = False

    @classmethod
    def depuis_dict(cls, d: dict) -> 'DonneesCompass':
        return cls(
            heading_deg=d.get('heading_deg', 0.0),
            mx=d.get('mx', 0.0), my=d.get('my', 0.0), mz=d.get('mz', 0.0),
            valide=True
        )


@dataclass
class DonneesGPS:
    """Données du module GPS."""
    lat: float = 0.0
    lon: float = 0.0
    alt_m: float = 0.0
    speed_kmh: float = 0.0
    fix: bool = False           # True si position fixée
    satellites: int = 0
    hdop: float = 99.9          # Dilution horizontale (< 2 = bon)
    valide: bool = False

    @classmethod
    def depuis_dict(cls, d: dict) -> 'DonneesGPS':
        return cls(
            lat=d.get('lat', 0.0), lon=d.get('lon', 0.0),
            alt_m=d.get('alt_m', 0.0), speed_kmh=d.get('speed_kmh', 0.0),
            fix=d.get('fix', False), satellites=d.get('satellites', 0),
            hdop=d.get('hdop', 99.9), valide=True
        )


@dataclass
class DonneesBaro:
    """Données du baromètre BMP280."""
    temp_c: float = 0.0
    pression_hpa: float = 1013.25
    altitude_m: float = 0.0
    valide: bool = False

    @classmethod
    def depuis_dict(cls, d: dict) -> 'DonneesBaro':
        return cls(
            temp_c=d.get('temp_c', 0.0),
            pression_hpa=d.get('pression_hpa', 1013.25),
            altitude_m=d.get('altitude_m', 0.0),
            valide=True
        )


@dataclass
class EtatESP32:
    """État complet retourné par GET_STATUS."""
    imu: DonneesIMU      = field(default_factory=DonneesIMU)
    compass: DonneesCompass = field(default_factory=DonneesCompass)
    gps: DonneesGPS      = field(default_factory=DonneesGPS)
    baro: DonneesBaro    = field(default_factory=DonneesBaro)
    urgence_active: bool = False
    stabilisateur_actif: bool = False
    uptime_ms: int       = 0
    firmware: str        = "unknown"
    valide: bool         = False
