# Intelligent Boats — Macroplastique Challenge (v3)
## Architecture Raspberry Pi 4B + ESP32 + C++ camera_worker

---

## Nouveauté v3 — Délégation caméra au C++

Toute la partie caméra (capture, traitement vidéo, détection et classification
des balles) est gérée par un programme **C++ externe** (`camera_worker`).

Python communique avec lui via **stdin/stdout (JSON Lines)** — le même
protocole que celui décrit dans `catj_py_helper.py` et `README_python_worker_protocol.md`.

```
Raspberry Pi 4B
│
├──[UART /dev/ttyAMA0]──▶ ESP32         (PCA9685, LCD, IMU, GPS…)
├──[USB  /dev/ttyUSB0]──▶ RPLidar C1   (navigation)
└──[pipe stdin/stdout]──▶ ./camera_worker  ← NOUVEAU v3
      │
      ├── Python → C++ : {"cmd":"get_detections"}\n
      └── C++ → Python : {"ok":true,"detections":[...]}\n
```

---

## Structure des fichiers Python

```
robot_v3/
├── main.py                ← POINT D'ENTRÉE → python3 main.py
├── config.py              ← Constantes (dont CPP_CAMERA_BINARY)
├── logger.py              ← Logger partagé
├── catj_py_helper.py      ← Helper protocole C++/Python (fourni)
│
├── protocole_uart.py      ← Trames JSON ESP32
├── esp32_interface.py     ← Communication UART ESP32
│
├── camera_client.py       ★ NOUVEAU : client vers C++ caméra
├── traitement_balles.py   ★ MODIFIÉ : consomme camera_client
│
├── controleur_lidar.py    ← RPLidar C1 (inchangé)
├── navigation.py          ← FGM + cap + guidage visuel (sans cv2)
├── mode_labyrinthe.py     ← Contre-la-montre (inchangé)
├── mode_course.py         ★ MODIFIÉ : collecte via vision C++
└── demarrage.py           ← Init + homologation (inchangé)
```

---

## Contrat attendu du programme C++

### Commande `get_detections`

```json
// Python → C++ (stdin du C++)
{"cmd":"get_detections"}

// C++ → Python (stdout du C++)
{
  "ok": true,
  "frame_id": 1234,
  "timestamp_ms": 98765,
  "detections": [
    {
      "type":       "piscine_rouge",
      "cx":         320,
      "cy":         240,
      "rayon_px":   28.5,
      "distance_m": 1.42,
      "angle_deg":  5.2,
      "confidence": 0.91
    }
  ]
}
```

### Types de balles reconnus

| `type`            | Description              | Score  |
|-------------------|--------------------------|--------|
| `pingpong_orange` | Ping-pong orange Ø 4 cm  | −5 pts |
| `piscine_rouge`   | Piscine rouge Ø 7 cm     | +10 pts|
| `piscine_autre`   | Piscine autre couleur     | −10 pts|

### Autres commandes supportées

```json
{"cmd":"ping"}          → {"ok":true,"reply":"pong"}
{"cmd":"get_frame_info"} → {"ok":true,"width":640,"height":480,"fps":30}
{"cmd":"set_params",...} → {"ok":true}
{"cmd":"quit"}           → {"ok":true,"stop":true}
```

---

## Configuration (config.py)

```python
CPP_CAMERA_BINARY    = './camera_worker'   # Chemin du binaire C++
CPP_CAMERA_ARGS      = ['--pipe']          # Arguments de lancement
CPP_CAMERA_TIMEOUT_S = 2.0                 # Timeout réponse (s)
CPP_CAMERA_REFRESH_S = 0.10                # Cadence refresh (s)
```

---

## Installation

```bash
pip3 install pyserial rplidar-roboticia
# OpenCV n'est plus nécessaire côté Python
```

---

## Lancement

```bash
cd robot_v3/
python3 main.py
```

Si `camera_worker` est introuvable → **mode simulation automatique**
(détections fictives générées pour tester la logique Python).

---

## Filtres appliqués côté Python (traitement_balles.py)

| Filtre              | Valeur par défaut |
|---------------------|-------------------|
| Confidence minimale | 0.50              |
| Distance minimale   | 0.10 m            |
| Distance maximale   | 6.00 m            |
| Anti-rebond collecte| 1.50 s            |
