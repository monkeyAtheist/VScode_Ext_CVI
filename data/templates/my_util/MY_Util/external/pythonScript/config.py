"""
=====================================================================
  config.py — Configuration centralisée du projet v3
=====================================================================
  Architecture :
    Raspberry Pi 4B ←── UART ──→ ESP32
    Raspberry Pi 4B ←── USB  ──→ RPLidar C1
    Raspberry Pi 4B ←── pipe ──→ Processus C++ (caméra)

  Nouveauté v3 :
    Toute la caméra est gérée par un programme C++ externe.
    La Raspberry Pi communique avec lui via stdin/stdout (JSON Lines).
    Le protocole est défini dans catj_py_helper.py / README_python_worker_protocol.md
=====================================================================
"""

# =====================================================================
# COMMUNICATION UART Raspberry Pi ↔ ESP32
# =====================================================================

UART_PORT         = '/dev/ttyAMA0'
UART_BAUDRATE     = 115200
UART_TIMEOUT      = 0.5
UART_RETRY_MAX    = 3
UART_DELIM_FIN    = '\n'
UART_HEARTBEAT_S  = 2.0


# =====================================================================
# LIDAR RPLidar C1 (USB direct sur la Raspberry Pi)
# =====================================================================

LIDAR_PORT            = '/dev/ttyUSB0'
LIDAR_BAUDRATE        = 115200
LIDAR_DIST_URGENCE    = 200           # (mm)
LIDAR_DIST_EVITEMENT  = 500           # (mm)
LIDAR_DIST_FLOTTEUR   = 800           # (mm)
LIDAR_ANGLE_AVANT     = 20            # (°)
LIDAR_ANGLE_LATERAL   = 50            # (°)


# =====================================================================
# PROCESSUS C++ CAMÉRA — COMMUNICATION PAR PIPE JSON
# =====================================================================
# Le programme C++ gère tout le traitement vidéo (capture, détection,
# classification des balles). Python le lance comme sous-processus et
# communique via stdin/stdout au format JSON Lines.
#
# Protocole (voir README_python_worker_protocol.md) :
#   Python → C++ : {"cmd": "NOM_CMD", ...}\n
#   C++ → Python : {"ok": true/false, "data": {...}}\n

# Chemin vers le binaire C++ de la caméra (à adapter selon le build)
CPP_CAMERA_BINARY     = './camera_worker'

# Arguments supplémentaires passés au binaire C++ au démarrage
# Exemple : ['--camera', '0', '--width', '640', '--height', '480']
CPP_CAMERA_ARGS       = ['--pipe']

# Délai max (secondes) pour recevoir une réponse du C++
CPP_CAMERA_TIMEOUT_S  = 2.0

# Intervalle de rafraîchissement du cache de détections (secondes)
CPP_CAMERA_REFRESH_S  = 0.10          # ~10 FPS côté Python

# Nombre max de tentatives en cas d'échec d'une commande
CPP_CAMERA_RETRY_MAX  = 2

# ── Commandes disponibles côté C++ (voir contrat dans README) ─────────────────
CPP_CMD_PING          = "ping"          # Test de connectivité → {"ok":true,"reply":"pong"}
CPP_CMD_GET_DETECT    = "get_detections"  # Lecture des balles détectées
CPP_CMD_GET_FRAME     = "get_frame_info"  # Info sur le flux vidéo (W, H, FPS)
CPP_CMD_SET_PARAMS    = "set_params"    # Mise à jour des paramètres de détection
CPP_CMD_QUIT          = "quit"          # Arrêt propre du processus C++

# ── Format attendu pour get_detections ────────────────────────────────────────
# Réponse C++ :
# {
#   "ok": true,
#   "frame_id": 1234,
#   "timestamp_ms": 98765,
#   "detections": [
#     {
#       "type": "piscine_rouge",     <- "pingpong_orange"|"piscine_rouge"|"piscine_autre"
#       "cx": 320,                   <- centre X dans l'image (pixels)
#       "cy": 240,                   <- centre Y dans l'image (pixels)
#       "rayon_px": 28.5,            <- rayon en pixels
#       "distance_m": 1.42,          <- distance estimée (mètres)
#       "angle_deg": 5.2,            <- angle horizontal relatif (°, + = droite)
#       "confidence": 0.91           <- score de confiance 0-1
#     }
#   ]
# }


# =====================================================================
# COMMANDES UART VERS ESP32
# =====================================================================

CMD_PING              = "PING"
CMD_GET_STATUS        = "GET_STATUS"
CMD_GET_IMU           = "GET_IMU"
CMD_GET_COMPASS       = "GET_COMPASS"
CMD_GET_GPS           = "GET_GPS"
CMD_GET_BARO          = "GET_BARO"
CMD_GET_RTC           = "GET_RTC"
CMD_GET_URGENCE       = "GET_URGENCE"

CMD_MOTOR_PROPULSION  = "MOTOR_PROPULSION"
CMD_SERVO_GOUVERNAIL  = "SERVO_GOUVERNAIL"
CMD_CONVOYEUR         = "CONVOYEUR"
CMD_ARRET_TOTAL       = "ARRET_TOTAL"
CMD_STABILISATEUR     = "STABILISATEUR"

CMD_LCD_WRITE         = "LCD_WRITE"
CMD_LCD_CLEAR         = "LCD_CLEAR"

CMD_EEPROM_WRITE      = "EEPROM_WRITE"
CMD_EEPROM_READ       = "EEPROM_READ"
CMD_COPROCESSEUR      = "COPROCESSEUR"


# =====================================================================
# PROPULSION (µs vers PCA9685 via ESP32)
# =====================================================================

ESC_NEUTRE            = 1500
ESC_AVANT_RAPIDE      = 1900
ESC_AVANT_NORMAL      = 1650
ESC_AVANT_LENT        = 1550
ESC_ARRIERE           = 1300

GOUV_CENTRE           = 90
GOUV_DROITE_MAX       = 135
GOUV_GAUCHE_MAX       = 45
GOUV_CORRECTION       = 110
GOUV_CORRECTION_G     = 70


# =====================================================================
# NAVIGATION
# =====================================================================

NAV_VITESSE_MS        = 0.4          # (m/s) — À CALIBRER sur l'eau
NAV_TEMPS_DEMI_TOUR   = 3.0          # (s)   — À CALIBRER sur l'eau
NAV_FREQUENCE_HZ      = 10
NAV_PERIODE_S         = 0.1
NAV_TOLERANCE_CAP     = 8.0          # (°)
NAV_KP_CAP            = 0.5
NAV_TOLERANCE_WP_M    = 1.5          # (m)


# =====================================================================
# COLLECTE (CdC §3.8)
# =====================================================================

COLLECTE_DUREE_MAX    = 300          # (s) 5 minutes
COLLECTE_DIST_PONTON  = 300          # (mm)

SCORE_BASE_COLLECTE   = 20
SCORE_PINGPONG_ORANGE = -5
SCORE_PISCINE_ROUGE   = +10
SCORE_PISCINE_AUTRE   = -10
SCORE_BONUS_PONTON    = 100
SCORE_BONUS_AFFICHEUR = 50

CONVOYEUR_VITESSE_NORMAL  = 80
CONVOYEUR_VITESSE_RAPIDE  = 100
CONVOYEUR_ARRET           = 0


# =====================================================================
# LABYRINTHE (CdC §3.7)
# =====================================================================

LABY_LARGEUR_MIN_MM   = 1000
LABY_MALUS_CONTACT_S  = 2
LABY_DIST_WALL_FOLLOW = 400


# =====================================================================
# HOMOLOGATION (CdC §3.3.1)
# =====================================================================

HOMO_PERIMETRE_MAX_REPOS    = 2500   # (mm)
HOMO_PERIMETRE_MAX_DEPLOYE  = 3500   # (mm)


# =====================================================================
# GPS / STABILISATEUR
# =====================================================================

GPS_FIX_TIMEOUT_S     = 30
GPS_PRECISION_MIN_M   = 5.0
STAB_ACTIF_PAR_DEFAUT = True
STAB_ANGLE_MAX_DEG    = 15.0
