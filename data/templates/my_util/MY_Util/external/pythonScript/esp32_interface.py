#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
=====================================================================
  esp32_interface.py — Interface de communication UART avec l'ESP32
=====================================================================
  Ce module est le SEUL point de contact entre le Python de la
  Raspberry Pi et le firmware de l'ESP32.

  Responsabilités :
    - Ouvrir et gérer le port série UART
    - Envoyer des trames (JSON Lines) vers l'ESP32
    - Lire et parser les réponses
    - Maintenir un heartbeat pour détecter les déconnexions
    - Mettre à jour un cache d'état des capteurs (EtatESP32)
    - Exposer des méthodes haut niveau pour chaque commande

  Thread-safety :
    Un threading.Lock protège toutes les opérations sur le port série.
    Le thread de heartbeat s'exécute en daemon et peut être arrêté.

  Mode dégradé :
    Si le port UART n'est pas disponible (simulation sur PC),
    les commandes sont loggées et des valeurs fictives sont retournées.
=====================================================================
"""

import serial
import threading
import time
import math

from logger import get_logger
from protocole_uart import (
    TrameBase, TramePing, TrameGetStatus,
    TrameMoteurPropulsion, TrameServoGouvernail,
    TrameConvoyeur, TrameArretTotal,
    TrameLCDEcrire, TrameLCDEffacer,
    TrameGetIMU, TrameGetCompass, TrameGetGPS,
    TrameGetBaro, TrameGetRTC, TrameGetUrgence,
    TrameStabilisateur, TrameEEPROMEcrire, TrameEEPROMLire,
    TrameCoprocesseur,
    DonneesIMU, DonneesCompass, DonneesGPS, DonneesBaro, EtatESP32
)
from config import (
    UART_PORT, UART_BAUDRATE, UART_TIMEOUT,
    UART_RETRY_MAX, UART_HEARTBEAT_S,
    ESC_NEUTRE, GOUV_CENTRE, STAB_ACTIF_PAR_DEFAUT
)

logger = get_logger('ESP32Interface')


class ESP32Interface:
    """
    Interface haut niveau vers l'ESP32 via UART.

    Toutes les interactions avec le hardware bas niveau (moteurs,
    capteurs, afficheur…) passent par cette classe.

    Utilisation :
        esp = ESP32Interface()
        ok = esp.connecter()
        esp.propulsion_avant('normal')
        gps = esp.lire_gps()
        esp.deconnecter()
    """

    def __init__(self, port: str = UART_PORT, baudrate: int = UART_BAUDRATE):
        self._port     = port
        self._baudrate = baudrate
        self._serial   = None
        self._lock     = threading.Lock()
        self._connecte = False
        self._simulation = False

        # Cache de l'état complet de l'ESP32
        self.etat = EtatESP32()

        # Thread de heartbeat
        self._hb_actif  = False
        self._hb_thread = None

        # Compteurs de télémétrie
        self._nb_envois  = 0
        self._nb_erreurs = 0

    # =========================================================================
    # CONNEXION / DÉCONNEXION
    # =========================================================================

    def connecter(self) -> bool:
        """
        Ouvre le port UART et vérifie la connexion avec l'ESP32 via PING.
        Si le port n'existe pas, passe en mode simulation (logs uniquement).

        Retourne True si la connexion est établie.
        """
        try:
            self._serial = serial.Serial(
                port=self._port,
                baudrate=self._baudrate,
                timeout=UART_TIMEOUT,
                write_timeout=1.0
            )
            time.sleep(0.5)      # Attente stabilisation du port série
            self._serial.flushInput()
            self._connecte = True
            logger.info(f"Port UART ouvert : {self._port} @ {self._baudrate} bauds")

        except serial.SerialException as err:
            logger.warning(
                f"Port UART {self._port} inaccessible : {err}\n"
                "→ Passage en MODE SIMULATION (aucun hardware réel)"
            )
            self._simulation = True
            self._connecte   = True  # Simulation = "connecté"

        # Test de connectivité via PING
        ok = self._ping_esp32()
        if ok:
            # Activation du stabilisateur au démarrage
            self.stabilisateur(STAB_ACTIF_PAR_DEFAUT)
            self._demarrer_heartbeat()
            logger.info("ESP32 connecté et opérationnel")
        else:
            logger.error("ESP32 ne répond pas au PING — vérifiez le câblage UART")

        return ok

    def deconnecter(self):
        """Arrête le heartbeat et ferme le port UART proprement."""
        self._arreter_heartbeat()
        if self._serial and self._serial.is_open:
            try:
                self._serial.close()
            except Exception:
                pass
        self._connecte = False
        logger.info("Interface ESP32 déconnectée")

    # =========================================================================
    # ENVOI / RÉCEPTION DES TRAMES (bas niveau)
    # =========================================================================

    def _envoyer(self, trame: TrameBase, attendre_reponse: bool = True) -> dict:
        """
        Envoie une trame vers l'ESP32 et attend optionnellement la réponse.

        Thread-safe via threading.Lock.
        Réessaie jusqu'à UART_RETRY_MAX fois en cas d'échec.

        Retourne : dict de la réponse ou {} en cas d'erreur.
        """
        if not self._connecte:
            logger.error("Tentative d'envoi sans connexion active")
            return {}

        if self._simulation:
            return self._reponse_simulee(trame)

        with self._lock:
            for tentative in range(1, UART_RETRY_MAX + 1):
                try:
                    # Envoi de la trame
                    self._serial.write(trame.build())
                    self._serial.flush()
                    self._nb_envois += 1

                    if not attendre_reponse:
                        return {"status": "ok"}

                    # Lecture de la réponse (une ligne JSON)
                    ligne = self._serial.readline()
                    if not ligne:
                        raise TimeoutError("Pas de réponse de l'ESP32")

                    reponse = TrameBase.parse(ligne.decode('utf-8', errors='replace'))
                    if reponse:
                        return reponse
                    raise ValueError("Réponse JSON invalide")

                except (serial.SerialException, TimeoutError, ValueError) as err:
                    self._nb_erreurs += 1
                    logger.warning(f"Tentative {tentative}/{UART_RETRY_MAX} échouée : {err}")
                    time.sleep(0.05 * tentative)    # Backoff exponentiel léger
                    try:
                        self._serial.flushInput()   # Vider le buffer avant retry
                    except Exception:
                        pass

        logger.error(f"Commande {trame.CMD} échouée après {UART_RETRY_MAX} tentatives")
        return {}

    def _reponse_simulee(self, trame: TrameBase) -> dict:
        """
        Génère des réponses fictives en mode simulation.
        Permet de tester la logique Python sans hardware.
        """
        logger.debug(f"[SIMULATION] Commande : {trame.CMD} {trame._payload()}")
        # Réponses génériques selon le type de commande
        simulations = {
            "PING":             {"status": "ok", "data": {"uptime_ms": 1000}},
            "GET_IMU":          {"status": "ok", "data": {"ax": 0.0, "ay": 0.0, "az": 1.0, "gx": 0.0, "gy": 0.0, "gz": 0.0, "temp_c": 22.0}},
            "GET_COMPASS":      {"status": "ok", "data": {"heading_deg": 0.0, "mx": 100, "my": 0, "mz": 0}},
            "GET_GPS":          {"status": "ok", "data": {"lat": 47.258, "lon": -2.350, "alt_m": 5.0, "speed_kmh": 0.0, "fix": True, "satellites": 6, "hdop": 1.5}},
            "GET_BARO":         {"status": "ok", "data": {"temp_c": 20.0, "pression_hpa": 1013.25, "altitude_m": 5.0}},
            "GET_URGENCE":      {"status": "ok", "data": {"actif": False}},
            "GET_STATUS":       {"status": "ok", "data": {"urgence_active": False, "stabilisateur_actif": True, "uptime_ms": 5000, "firmware": "sim-1.0"}},
        }
        return simulations.get(trame.CMD, {"status": "ok", "data": {}})

    # =========================================================================
    # HEARTBEAT
    # =========================================================================

    def _demarrer_heartbeat(self):
        """Lance le thread de heartbeat qui pinge l'ESP32 périodiquement."""
        self._hb_actif = True
        self._hb_thread = threading.Thread(
            target=self._boucle_heartbeat,
            name='HeartbeatThread',
            daemon=True
        )
        self._hb_thread.start()

    def _arreter_heartbeat(self):
        """Arrête le thread de heartbeat."""
        self._hb_actif = False

    def _boucle_heartbeat(self):
        """
        Envoie un PING à l'ESP32 toutes les UART_HEARTBEAT_S secondes.
        Si l'ESP32 ne répond pas, une alarme est loggée.
        Met à jour en même temps l'état complet via GET_STATUS.
        """
        while self._hb_actif:
            try:
                # Mise à jour complète de l'état à chaque heartbeat
                rep = self._envoyer(TrameGetStatus())
                if TrameBase.est_ok(rep):
                    d = TrameBase.get_data(rep)
                    self.etat.urgence_active      = d.get('urgence_active', False)
                    self.etat.stabilisateur_actif = d.get('stabilisateur_actif', False)
                    self.etat.uptime_ms           = d.get('uptime_ms', 0)
                    self.etat.firmware            = d.get('firmware', 'unknown')
                    self.etat.valide              = True
                else:
                    logger.warning("Heartbeat : GET_STATUS sans réponse valide")
                    self.etat.valide = False

            except Exception as err:
                logger.error(f"Erreur heartbeat : {err}")

            time.sleep(UART_HEARTBEAT_S)

    # =========================================================================
    # VÉRIFICATION CONNECTIVITÉ
    # =========================================================================

    def _ping_esp32(self) -> bool:
        """Envoie un PING et vérifie que l'ESP32 répond."""
        rep = self._envoyer(TramePing())
        return TrameBase.est_ok(rep)

    # =========================================================================
    # INTERFACE PUBLIQUE — PROPULSION ET GOUVERNAIL
    # =========================================================================

    def propulsion(self, valeur_us: int):
        """
        Commande directe de l'ESC en microsecondes.
        valeur_us : 1000 (arrière) → 1500 (neutre) → 2000 (avant)
        """
        self._envoyer(TrameMoteurPropulsion(valeur_us), attendre_reponse=False)
        logger.debug(f"Propulsion → {valeur_us} µs")

    def propulsion_avant(self, mode: str = 'normal'):
        """
        Propulsion avant selon le mode.
        mode : 'lent' | 'normal' | 'rapide'
        """
        from config import ESC_AVANT_LENT, ESC_AVANT_NORMAL, ESC_AVANT_RAPIDE
        table = {'lent': ESC_AVANT_LENT, 'normal': ESC_AVANT_NORMAL, 'rapide': ESC_AVANT_RAPIDE}
        self.propulsion(table.get(mode, ESC_AVANT_NORMAL))

    def propulsion_arret(self):
        """Signal neutre à l'ESC — arrêt de la propulsion."""
        self.propulsion(ESC_NEUTRE)

    def propulsion_arriere(self):
        """Marche arrière — uniquement en cas d'urgence."""
        from config import ESC_ARRIERE
        self.propulsion(ESC_ARRIERE)

    def gouvernail(self, angle_deg: int):
        """
        Commande directe du servo gouvernail.
        angle_deg : 0°–180° (90° = centre)
        """
        self._envoyer(TrameServoGouvernail(angle_deg), attendre_reponse=False)
        logger.debug(f"Gouvernail → {angle_deg}°")

    def gouvernail_centre(self):
        """Recentre le gouvernail (ligne droite)."""
        self.gouvernail(GOUV_CENTRE)

    def gouvernail_droite(self, puissant: bool = True):
        """Braque à droite — puissant=True pour virage serré."""
        from config import GOUV_DROITE_MAX, GOUV_CORRECTION
        self.gouvernail(GOUV_DROITE_MAX if puissant else GOUV_CORRECTION)

    def gouvernail_gauche(self, puissant: bool = True):
        """Braque à gauche — puissant=True pour virage serré."""
        from config import GOUV_GAUCHE_MAX, GOUV_CORRECTION_G
        self.gouvernail(GOUV_GAUCHE_MAX if puissant else GOUV_CORRECTION_G)

    def arret_total(self):
        """
        Arrêt IMMÉDIAT de TOUS les actionneurs via l'ESP32.
        Utilisé par l'urgence et en fin d'épreuve.
        """
        self._envoyer(TrameArretTotal(), attendre_reponse=False)
        logger.info("ARRET TOTAL transmis à l'ESP32")

    def demi_tour(self, sens: str = 'droite'):
        """
        Effectue un demi-tour complet (homologation dynamique §3.6.1).
        Séquence : braquage fond + avance NAV_TEMPS_DEMI_TOUR + recentrage.
        """
        from config import NAV_TEMPS_DEMI_TOUR
        logger.info(f"Demi-tour {sens}")
        if sens == 'droite':
            self.gouvernail_droite(True)
        else:
            self.gouvernail_gauche(True)
        self.propulsion_avant('normal')
        time.sleep(NAV_TEMPS_DEMI_TOUR)
        self.gouvernail_centre()

    def recul_urgence(self, duree: float = 1.5):
        """Séquence de recul : stop → arrière → stop + recentrage."""
        logger.warning(f"Recul d'urgence ({duree}s)")
        self.propulsion_arret()
        time.sleep(0.3)
        self.propulsion_arriere()
        time.sleep(duree)
        self.propulsion_arret()
        self.gouvernail_centre()

    # =========================================================================
    # INTERFACE PUBLIQUE — CONVOYEUR
    # =========================================================================

    def convoyeur_start(self, vitesse: int = None, direction: str = 'avant'):
        """
        Démarre le convoyeur de ramassage des balles.
        vitesse : 0–100 (% de la puissance, None = valeur par défaut)
        """
        from config import CONVOYEUR_VITESSE_NORMAL
        v = vitesse if vitesse is not None else CONVOYEUR_VITESSE_NORMAL
        self._envoyer(TrameConvoyeur(v, direction), attendre_reponse=False)
        logger.debug(f"Convoyeur START {v}% {direction}")

    def convoyeur_stop(self):
        """Arrête le convoyeur."""
        self._envoyer(TrameConvoyeur(0, 'stop'), attendre_reponse=False)
        logger.debug("Convoyeur STOP")

    # =========================================================================
    # INTERFACE PUBLIQUE — AFFICHEUR LCD
    # =========================================================================

    def lcd_ecrire(self, ligne1: str, ligne2: str = ''):
        """Envoie deux lignes de texte au LCD 1602 via l'ESP32."""
        self._envoyer(TrameLCDEcrire(ligne1, ligne2), attendre_reponse=False)

    def lcd_effacer(self):
        """Efface le LCD."""
        self._envoyer(TrameLCDEffacer(), attendre_reponse=False)

    def lcd_score(self, score: int, fige: bool = False):
        """
        Affiche le score sur le LCD (CdC §3.8.3).
        fige=True → indique visuellement que l'épreuve est terminée.
        """
        if fige:
            self.lcd_ecrire("== FIN EPREUVE =", f"Score:{score:>8}")
        else:
            self.lcd_ecrire("COLLECTE SCORE  ", f"Points:{score:>7}")

    # =========================================================================
    # INTERFACE PUBLIQUE — LECTURE DES CAPTEURS
    # =========================================================================

    def lire_imu(self) -> DonneesIMU:
        """Lit les données du MPU-6050 (accéléromètre + gyroscope)."""
        rep = self._envoyer(TrameGetIMU())
        if TrameBase.est_ok(rep):
            return DonneesIMU.depuis_dict(TrameBase.get_data(rep))
        return DonneesIMU()

    def lire_compass(self) -> DonneesCompass:
        """Lit le cap magnétique du HMC5883."""
        rep = self._envoyer(TrameGetCompass())
        if TrameBase.est_ok(rep):
            return DonneesCompass.depuis_dict(TrameBase.get_data(rep))
        return DonneesCompass()

    def lire_gps(self) -> DonneesGPS:
        """Lit la position GPS."""
        rep = self._envoyer(TrameGetGPS())
        if TrameBase.est_ok(rep):
            return DonneesGPS.depuis_dict(TrameBase.get_data(rep))
        return DonneesGPS()

    def lire_baro(self) -> DonneesBaro:
        """Lit la pression/température du BMP280."""
        rep = self._envoyer(TrameGetBaro())
        if TrameBase.est_ok(rep):
            return DonneesBaro.depuis_dict(TrameBase.get_data(rep))
        return DonneesBaro()

    def urgence_active(self) -> bool:
        """
        Retourne True si le bouton d'arrêt d'urgence est enfoncé.
        Utilisé aussi le cache du heartbeat pour éviter de spammer l'UART.
        """
        if self.etat.valide:
            return self.etat.urgence_active
        rep = self._envoyer(TrameGetUrgence())
        return TrameBase.get_data(rep).get('actif', False)

    def stabilisateur(self, actif: bool):
        """Active ou désactive le stabilisateur de roulis."""
        self._envoyer(TrameStabilisateur(actif), attendre_reponse=False)
        logger.info(f"Stabilisateur {'activé' if actif else 'désactivé'}")

    # =========================================================================
    # INTERFACE PUBLIQUE — EEPROM ET COPROCESSEUR
    # =========================================================================

    def eeprom_ecrire(self, adresse: int, valeur: int) -> bool:
        """Écrit un octet dans l'EEPROM AT24CS64."""
        rep = self._envoyer(TrameEEPROMEcrire(adresse, valeur))
        return TrameBase.est_ok(rep)

    def eeprom_lire(self, adresse: int) -> Optional[int]:
        """Lit un octet depuis l'EEPROM AT24CS64."""
        rep = self._envoyer(TrameEEPROMLire(adresse))
        if TrameBase.est_ok(rep):
            return TrameBase.get_data(rep).get('val')
        return None

    def coprocesseur(self, commande: str, params: dict = None) -> dict:
        """Délègue une commande au coprocesseur ATmega328 via l'ESP32."""
        rep = self._envoyer(TrameCoprocesseur(commande, params))
        return TrameBase.get_data(rep)

    # =========================================================================
    # TÉLÉMÉTRIE
    # =========================================================================

    def stats(self) -> dict:
        """Retourne les statistiques de communication UART."""
        return {
            'envois':  self._nb_envois,
            'erreurs': self._nb_erreurs,
            'taux_erreur': (
                f"{self._nb_erreurs / max(1, self._nb_envois) * 100:.1f}%"
            ),
            'simulation': self._simulation,
        }


# Importation optionnelle pour les annotations de type
from typing import Optional
