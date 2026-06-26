(() => {
  const $ = (id) => document.getElementById(id);
  const qs = (selector) => Array.from(document.querySelectorAll(selector));

  const ui = {
    wsBadge: $('wsBadge'),
    modeBadge: $('modeBadge'),
    missionBadge: $('missionBadge'),
    overlayBadge: $('overlayBadge'),
    lidarBadge: $('lidarBadge'),

    statusText: $('statusText'),
    autoState: $('autoState'),
    targetVal: $('targetVal'),
    fpsVal: $('fpsVal'),
    batteryVal: $('batteryVal'),

    headingVal: $('headingVal'),
    northVal: $('northVal'),
    rollVal: $('rollVal'),
    pitchVal: $('pitchVal'),
    yawVal: $('yawVal'),
    gyroVecVal: $('gyroVecVal'),

    lidarStatusVal: $('lidarStatusVal'),
    lidarHzVal: $('lidarHzVal'),
    lidarSamplesVal: $('lidarSamplesVal'),
    lidarFrontVal: $('lidarFrontVal'),
    lidarFrontRightVal: $('lidarFrontRightVal'),
    lidarRightVal: $('lidarRightVal'),
    lidarRearVal: $('lidarRearVal'),
    lidarLeftVal: $('lidarLeftVal'),
    lidarFrontLeftVal: $('lidarFrontLeftVal'),

    leftThruster: $('leftThruster'),
    rightThruster: $('rightThruster'),
    conveyor: $('conveyor'),
    leftThrusterValue: $('leftThrusterValue'),
    rightThrusterValue: $('rightThrusterValue'),
    conveyorValue: $('conveyorValue'),
    camPanVal: $('camPanVal'),
    camTiltVal: $('camTiltVal'),

    expRange: $('expRange'),
    brightRange: $('brightRange'),
    contrastRange: $('contrastRange'),

    manualLockBanner: $('manualLockBanner'),
    logBox: $('logBox'),
    detectionsBox: $('detectionsBox'),
    videoFeed: $('videoFeed'),
    compassCanvas: $('compassCanvas'),
    gyroCanvas: $('gyroCanvas'),
    lidarCanvas: $('lidarCanvas'),

    // Profile / configuration fields
    profileBaseMode: $('profileBaseMode'),
    profileStreamCamera: $('profileStreamCamera'),
    profileVisionEnabled: $('profileVisionEnabled'),
    profileOverlayDefault: $('profileOverlayDefault'),
    profileNetworkControl: $('profileNetworkControl'),
    profileTelemetryPeriod: $('profileTelemetryPeriod'),
    profileJpegQuality: $('profileJpegQuality'),

    profileCameraBackend: $('profileCameraBackend'),
    profileCameraDevice: $('profileCameraDevice'),
    profileCameraReference: $('profileCameraReference'),
    profileCameraResolution: $('profileCameraResolution'),
    profileCameraFps: $('profileCameraFps'),
    profileAiFps: $('profileAiFps'),
    profileCameraShowImage: $('profileCameraShowImage'),
    profileCameraRecording: $('profileCameraRecording'),
    profileRecordingPath: $('profileRecordingPath'),
    profileCodec: $('profileCodec'),
    profileOnnxModel: $('profileOnnxModel'),
    profileScoreThreshold: $('profileScoreThreshold'),
    profileNmsThreshold: $('profileNmsThreshold'),

    profileLidarEnabled: $('profileLidarEnabled'),
    profileLidarPort: $('profileLidarPort'),
    profileLidarBaud: $('profileLidarBaud'),
    profileLidarMock: $('profileLidarMock'),
    profileLidarMaxDistance: $('profileLidarMaxDistance'),
    profileLidarAvoidDistance: $('profileLidarAvoidDistance'),
    profileLidarWebPoints: $('profileLidarWebPoints'),

    detectionCountVal: $('detectionCountVal'),
    primaryDetectionVal: $('primaryDetectionVal'),
    confidenceVal: $('confidenceVal'),
    videoResolutionLive: $('videoResolutionLive'),
    videoResolutionLiveDuplicate: $('videoResolutionLiveDuplicate'),

    speedHudVal: $('speedHudVal'),
    turnHudVal: $('turnHudVal'),
    driveStateVal: $('driveStateVal'),
    headingMiniVal: $('headingMiniVal'),
    leftPowerBar: $('leftPowerBar'),
    rightPowerBar: $('rightPowerBar'),
    conveyorPowerBar: $('conveyorPowerBar'),
    avgThrustVal: $('avgThrustVal'),
    diffThrustVal: $('diffThrustVal'),
    videoHeadingVal: $('videoHeadingVal'),
    videoModeMini: $('videoModeMini'),
    videoMissionMini: $('videoMissionMini'),
    northValDuplicate: $('northValDuplicate'),
    modeInfoVal: $('modeInfoVal'),
    missionInfoVal: $('missionInfoVal'),
    overlayInfoVal: $('overlayInfoVal'),
    trackingVal: $('trackingVal'),
    statusDetection: $('statusDetection'),
    statusDetectionMini: $('statusDetectionMini'),
    cameraDetectionIndicator: $('cameraDetectionIndicator'),

    visionCfgForm: $('visionCfgForm'),
    visionCfgMessage: $('visionCfgMessage'),
    visionCfgPath: $('visionCfgPath'),
    visionCfgResetPath: $('visionCfgResetPath'),
    visionCfgRuntime: $('visionCfgRuntime'),
  };

  const wsUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
  let ws = null;
  let reconnectTimer = null;
  let currentMode = 'manual';
  let manualLocked = false;
  let lastLidarPoints = [];
  let lastLidarMaxDistance = 8000;
  let lastTelemetry = null;
  let systemProfile = null;
  let keyboardDriveActive = false;
  const activeKeys = new Set();

  function has(el) {
    return !!el;
  }

  function setText(el, value) {
    if (!el) return;
    el.textContent = value;
  }

  function setHtml(el, value) {
    if (!el) return;
    el.innerHTML = value;
  }

  function setValue(el, value) {
    if (!el) return;
    el.value = value;
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  function signedPercentText(v) {
    if (!Number.isFinite(v)) return '--';
    const n = Math.round(v);
    return `${n > 0 ? '+' : ''}${n} %`;
  }

  function setPowerBar(el, value) {
    if (!el) return;
    const v = clamp(Number(value) || 0, -100, 100);
    const width = `${Math.abs(v) / 2}%`;
    el.style.width = width;
    el.style.left = v >= 0 ? '50%' : `${50 - Math.abs(v) / 2}%`;
  }

  function computeDriveState(left, right) {
    if (Math.abs(left) < 2 && Math.abs(right) < 2) return 'Idle';
    if (left > 0 && right > 0) return 'Forward';
    if (left < 0 && right < 0) return 'Backward';
    if (left < right) return 'Rotate left';
    if (right < left) return 'Rotate right';
    return 'Mixed';
  }

  function getLiveVideoResolution() {
    if (!ui.videoFeed) return '--';
    return ui.videoFeed.naturalWidth && ui.videoFeed.naturalHeight
      ? `${ui.videoFeed.naturalWidth} × ${ui.videoFeed.naturalHeight}`
      : '--';
  }

  function updateResolutionLabels() {
    const res = getLiveVideoResolution();
    setText(ui.videoResolutionLive, res);
    setText(ui.videoResolutionLiveDuplicate, res);
  }

  function setBadge(el, text, enabled, extraClass = '') {
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('badge-on', !!enabled);
    el.classList.toggle('badge-off', !enabled);
    if (extraClass) {
      el.classList.toggle(extraClass, true);
    }
  }

  function boolText(v) {
    return v ? 'ON' : 'OFF';
  }

  function maybeText(v, fallback = '--') {
    if (v === null || v === undefined) return fallback;
    const s = String(v).trim();
    return s ? s : fallback;
  }

  function mmText(v) {
    return Number.isFinite(v) && v > 0 ? `${Math.round(v)} mm` : '--';
  }

  function percentText(v) {
    return Number.isFinite(v) ? `${Math.round(v)} %` : '--';
  }

  function logLine(msg, cls = 'logLine') {
    if (!ui.logBox) {
      console.log(msg);
      return;
    }
    const line = document.createElement('div');
    line.className = cls;
    const ts = new Date().toLocaleTimeString();
    line.textContent = `[${ts}] ${msg}`;
    ui.logBox.prepend(line);
    while (ui.logBox.childElementCount > 80) {
      ui.logBox.removeChild(ui.logBox.lastChild);
    }
  }

  function fetchJson(url) {
    return fetch(url, { cache: 'no-store' }).then((res) => {
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res.json();
    });
  }

  function postFormJson(url, bodyText = '') {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: bodyText,
      cache: 'no-store'
    }).then(async (res) => {
      const text = await res.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; }
      catch { data = { ok: false, error: text || `HTTP ${res.status}` }; }
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || data.message || `HTTP ${res.status}`);
      }
      return data;
    });
  }

  async function loadSystemProfile() {
    try {
      systemProfile = await fetchJson('/api/system_profile');
      renderSystemProfile(systemProfile);
    } catch (err) {
      logLine(`Impossible de charger /api/system_profile : ${err.message}`, 'logLineErr');
    }
  }

  async function loadInitialTelemetry() {
    try {
      const data = await fetchJson('/api/telemetry');
      applyTelemetry(data);
    } catch (err) {
      logLine(`Impossible de charger /api/telemetry : ${err.message}`, 'logLineErr');
    }
  }

  function renderSystemProfile(profile) {
    if (!profile) return;

    setText(ui.profileBaseMode, maybeText(profile.base_mode));
    setText(ui.profileStreamCamera, boolText(!!profile.stream_camera));
    setText(ui.profileVisionEnabled, boolText(!!profile.vision_enabled));
    setText(ui.profileOverlayDefault, boolText(!!profile.overlay_default));
    setText(ui.profileNetworkControl, boolText(!!profile.allow_network_control));
    setText(ui.profileTelemetryPeriod, `${profile.telemetry_period_ms ?? '--'} ms`);
    setText(ui.profileJpegQuality, `${profile.jpeg_quality ?? '--'}`);

    const cam = profile.camera || {};
    setText(ui.profileCameraBackend, maybeText(cam.backend));
    setText(ui.profileCameraDevice, `${cam.device ?? '--'}`);
    setText(ui.profileCameraReference, maybeText(cam.reference));
    setText(ui.profileCameraResolution, (cam.width && cam.height) ? `${cam.width} × ${cam.height}` : '--');
    setText(ui.profileCameraFps, cam.fps !== undefined ? `${cam.fps} fps` : '--');
    setText(ui.profileAiFps, cam.ai_fps !== undefined ? `${cam.ai_fps} fps` : '--');
    setText(ui.profileCameraShowImage, boolText(!!cam.show_image));
    setText(ui.profileCameraRecording, boolText(!!cam.recording_enabled));
    setText(ui.profileRecordingPath, maybeText(cam.recording_path));
    setText(ui.profileCodec, maybeText(profile.image_codec));

    const vision = profile.vision || {};
    setText(ui.profileOnnxModel, maybeText(vision.onnx_model));
    setText(ui.profileScoreThreshold, vision.score_threshold !== undefined ? `${vision.score_threshold}` : '--');
    setText(ui.profileNmsThreshold, vision.nms_threshold !== undefined ? `${vision.nms_threshold}` : '--');

    const lidar = profile.lidar || {};
    setText(ui.profileLidarEnabled, boolText(!!lidar.enabled));
    setText(ui.profileLidarPort, maybeText(lidar.port));
    setText(ui.profileLidarBaud, lidar.baudrate !== undefined ? `${lidar.baudrate}` : '--');
    setText(ui.profileLidarMock, boolText(!!lidar.mock));
    setText(ui.profileLidarMaxDistance, lidar.max_distance_mm !== undefined ? `${lidar.max_distance_mm} mm` : '--');
    setText(ui.profileLidarAvoidDistance, lidar.avoid_distance_mm !== undefined ? `${lidar.avoid_distance_mm} mm` : '--');
    setText(ui.profileLidarWebPoints, lidar.web_max_points !== undefined ? `${lidar.web_max_points}` : '--');
  }


  let visionConfig = null;

  function setVisionCfgMessage(msg, kind = '') {
    if (!ui.visionCfgMessage) return;
    ui.visionCfgMessage.textContent = msg;
    ui.visionCfgMessage.classList.toggle('ok', kind === 'ok');
    ui.visionCfgMessage.classList.toggle('err', kind === 'err');
  }

  function inputNameForField(field) {
    return `${field.section}.${field.key}`;
  }

  const visionColorPalette = [
    { name: 'red', label: 'Rouge cible (+10)', hex: '#ff0000' },
    { name: 'orange', label: 'Orange ping-pong (-5)', hex: '#ff8a00' },
    { name: 'white', label: 'Blanc', hex: '#ffffff' },
    { name: 'blue', label: 'Bleu', hex: '#005dff' },
    { name: 'unknown', label: 'Unknown / aucun', hex: '#808080' },
  ];

  function colorHexFromValue(value) {
    const v = String(value || '').trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/i.test(v)) return v;
    if (/^[0-9a-f]{6}$/i.test(v)) return '#' + v;
    const found = visionColorPalette.find((c) => c.name === v);
    return found ? found.hex : '#ff0000';
  }

  function makeSelectOptions(select, field) {
    let options = [];
    if (field.key === 'backend') options = ['auto', 'csi', 'gstreamer', 'usb', 'v4l2'];
    else if (field.key === 'target color' || field.key === 'ignore color') options = visionColorPalette.map((c) => c.name).concat(['custom hex']);
    else options = [field.value || ''];

    for (const optValue of options) {
      const opt = document.createElement('option');
      opt.value = optValue === 'custom hex' ? '__custom__' : optValue;
      opt.textContent = optValue || '--';
      select.appendChild(opt);
    }
    const raw = String(field.value || '').trim().toLowerCase();
    select.value = options.includes(raw) ? raw : (/^#?[0-9a-f]{6}$/i.test(raw) ? '__custom__' : (options[0] || ''));
  }

  function isColorConfigField(field) {
    return field && field.section === 'CAMERA' && (field.key === 'target color' || field.key === 'ignore color');
  }

  function renderVisionConfig(cfg) {
    visionConfig = cfg;
    if (!ui.visionCfgForm) return;

    setText(ui.visionCfgPath, maybeText(cfg.config_path));
    setText(ui.visionCfgResetPath, cfg.reset_exists ? maybeText(cfg.reset_path) : `${maybeText(cfg.reset_path)} (absent)`);
    const rt = cfg.runtime || {};
    setText(ui.visionCfgRuntime, `video ${rt.web_video_fps ?? '--'} fps | JPEG ${rt.jpeg_quality ?? '--'} | sleep ${rt.web_loop_sleep_ms ?? '--'} ms`);

    ui.visionCfgForm.innerHTML = '';
    const fields = Array.isArray(cfg.fields) ? cfg.fields : [];

    for (const field of fields) {
      const wrap = document.createElement('div');
      wrap.className = 'configField';

      const label = document.createElement('label');
      const labelText = document.createElement('span');
      labelText.textContent = field.label || field.key;
      label.appendChild(labelText);

      const keyBadge = document.createElement('span');
      keyBadge.className = 'configPill';
      keyBadge.textContent = `${field.section}.${field.key}`;
      label.appendChild(keyBadge);
      wrap.appendChild(label);

      let input;
      if (field.type === 'bool') {
        input = document.createElement('select');
        for (const v of ['true', 'false']) {
          const opt = document.createElement('option');
          opt.value = v;
          opt.textContent = v;
          input.appendChild(opt);
        }
        const raw = String(field.value || '').trim().toLowerCase();
        input.value = ['1', 'true', 'yes', 'on'].includes(raw) ? 'true' : 'false';
      } else if (field.type === 'select') {
        if (isColorConfigField(field)) {
          input = document.createElement('input');
          input.type = 'hidden';
          input.value = field.value ?? '';

          const colorBox = document.createElement('div');
          colorBox.className = 'colorConfigBox';

          const select = document.createElement('select');
          makeSelectOptions(select, field);
          colorBox.appendChild(select);

          const picker = document.createElement('input');
          picker.type = 'color';
          picker.value = colorHexFromValue(field.value);
          picker.title = 'Couleur personnalisée au format hexadécimal';
          colorBox.appendChild(picker);

          const palette = document.createElement('div');
          palette.className = 'colorPalette';
          visionColorPalette.forEach((c) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'colorSwatch';
            b.title = c.label;
            b.style.background = c.hex;
            b.dataset.value = c.name;
            b.addEventListener('click', () => {
              select.value = c.name;
              picker.value = c.hex;
              input.value = c.name;
            });
            palette.appendChild(b);
          });
          colorBox.appendChild(palette);

          select.addEventListener('change', () => {
            if (select.value === '__custom__') input.value = picker.value;
            else {
              input.value = select.value;
              picker.value = colorHexFromValue(select.value);
            }
          });
          picker.addEventListener('input', () => {
            select.value = '__custom__';
            input.value = picker.value;
          });

          wrap.appendChild(colorBox);
        } else {
          input = document.createElement('select');
          makeSelectOptions(input, field);
        }
      } else {
        input = document.createElement('input');
        input.type = field.type === 'number' ? 'number' : 'text';
        input.value = field.value ?? '';
        if (field.min !== '') input.min = field.min;
        if (field.max !== '') input.max = field.max;
        if (field.step !== '') input.step = field.step;
      }

      input.name = inputNameForField(field);
      input.dataset.live = field.live ? '1' : '0';
      input.dataset.restart = field.restart_required ? '1' : '0';
      wrap.appendChild(input);

      const meta = document.createElement('div');
      meta.className = 'configMeta';
      const livePill = document.createElement('span');
      livePill.className = `configPill ${field.live ? 'live' : ''}`;
      livePill.textContent = field.live ? 'live' : 'save only';
      meta.appendChild(livePill);
      if (field.restart_required) {
        const restartPill = document.createElement('span');
        restartPill.className = 'configPill restart';
        restartPill.textContent = 'restart conseillé';
        meta.appendChild(restartPill);
      }
      wrap.appendChild(meta);

      ui.visionCfgForm.appendChild(wrap);
    }
  }

  async function loadVisionConfig() {
    if (!ui.visionCfgForm) return;
    try {
      setVisionCfgMessage('Chargement des paramètres...', '');
      const data = await fetchJson('/api/vision_config');
      renderVisionConfig(data);
      setVisionCfgMessage('Paramètres chargés.', 'ok');
    } catch (err) {
      setVisionCfgMessage(`Erreur chargement config : ${err.message}`, 'err');
      logLine(`Erreur /api/vision_config : ${err.message}`, 'logLineErr');
    }
  }

  function serializeVisionConfigForm(liveOnly = false) {
    if (!ui.visionCfgForm) return '';
    const params = new URLSearchParams();
    Array.from(ui.visionCfgForm.elements).forEach((el) => {
      if (!el.name) return;
      if (liveOnly && el.dataset.live !== '1') return;
      params.append(el.name, el.value);
    });
    return params.toString();
  }

  async function applyVisionConfig() {
    try {
      const data = await postFormJson('/api/vision_config_apply', serializeVisionConfigForm(true));
      setVisionCfgMessage(data.message || 'Paramètres live appliqués.', 'ok');
      await loadSystemProfile();
    } catch (err) {
      setVisionCfgMessage(`Erreur application live : ${err.message}`, 'err');
      logLine(`Vision config apply: ${err.message}`, 'logLineErr');
    }
  }

  async function saveVisionConfig() {
    try {
      const data = await postFormJson('/api/vision_config_save', serializeVisionConfigForm(false));
      setVisionCfgMessage(data.message || 'config.ini sauvegardé.', 'ok');
      await loadSystemProfile();
      await loadVisionConfig();
    } catch (err) {
      setVisionCfgMessage(`Erreur sauvegarde : ${err.message}`, 'err');
      logLine(`Vision config save: ${err.message}`, 'logLineErr');
    }
  }

  async function makeVisionReset() {
    try {
      const data = await postFormJson('/api/vision_config_make_reset');
      setVisionCfgMessage(data.message || 'Fichier reset créé.', 'ok');
      await loadVisionConfig();
    } catch (err) {
      setVisionCfgMessage(`Erreur création reset : ${err.message}`, 'err');
      logLine(`Vision config make reset: ${err.message}`, 'logLineErr');
    }
  }

  async function resetVisionConfig() {
    const ok = window.confirm('Restaurer config.ini depuis config.reset.ini ? Les réglages courants seront remplacés.');
    if (!ok) return;
    try {
      const data = await postFormJson('/api/vision_config_reset');
      setVisionCfgMessage(data.message || 'config.ini restauré.', 'ok');
      await loadSystemProfile();
      await loadVisionConfig();
    } catch (err) {
      setVisionCfgMessage(`Erreur reset : ${err.message}`, 'err');
      logLine(`Vision config reset: ${err.message}`, 'logLineErr');
    }
  }

  function connectWs() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => {
      setText(ui.wsBadge, 'WS connected');
      if (ui.wsBadge) {
        ui.wsBadge.classList.remove('badge-off');
        ui.wsBadge.classList.add('badge-on');
      }
      logLine('WebSocket connecté.');
    });

    ws.addEventListener('error', () => {
      logLine('WebSocket error : connexion impossible ou frame invalide.', 'logLineErr');
    });

    ws.addEventListener('close', (ev) => {
      setText(ui.wsBadge, 'WS disconnected');
      if (ui.wsBadge) {
        ui.wsBadge.classList.remove('badge-on');
        ui.wsBadge.classList.add('badge-off');
      }
      logLine(`WebSocket fermé: code=${ev.code || 0} reason=${ev.reason || ''}`, 'logLineErr');
      if (!reconnectTimer) {
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          connectWs();
        }, 1200);
      }
    });

    ws.addEventListener('message', (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === 'telemetry' && data.payload) {
          applyTelemetry(data.payload);
        } else if (data.type === 'vision_config' && data.payload) {
          renderVisionConfig(data.payload);
        } else if (data.type === 'echo') {
          logLine(`Echo: ${JSON.stringify(data.payload)}`);
        } else if (data.type === 'info' || data.type === 'error') {
          const msg = (data.payload && (data.payload.message || data.payload.msg))
            ? (data.payload.message || data.payload.msg)
            : (data.message || JSON.stringify(data.payload || {}));
          logLine(`[${data.type}] ${msg}`, data.type === 'error' ? 'logLineErr' : 'logLine');
        }
      } catch (err) {
        console.warn('Message WS illisible', err, ev.data);
      }
    });
  }

  function sendWs(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logLine('Commande ignorée : WebSocket non connecté.', 'logLineErr');
      return;
    }
    ws.send(JSON.stringify(obj));
    logLine(JSON.stringify(obj), 'logLineTx');
  }

  async function requestProgramStop() {
    const payload = { type: 'command', action: 'programme', cmd: 'stop' };

    let sentByWs = false;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(payload));
        sentByWs = true;
        logLine(JSON.stringify(payload), 'logLineTx');
      } catch (err) {
        logLine(`STOP WS impossible: ${err.message}`, 'logLineErr');
      }
    } else {
      logLine('STOP: WebSocket non connecté, fallback HTTP.', 'logLineErr');
    }

    try {
      const r = await fetch('/api/program_stop', { method: 'POST' });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status} ${text}`);
      logLine(sentByWs ? 'STOP programme envoyé par WS + HTTP fallback.' : 'STOP programme envoyé par HTTP fallback.');
    } catch (err) {
      logLine(`STOP HTTP impossible: ${err.message}`, 'logLineErr');
    }
  }

  function sendIfManual(payload) {
    if (manualLocked) {
      logLine('Commande manuelle ignorée en mode AUTO.', 'logLineErr');
      return;
    }
    sendWs(payload);
  }

  function refreshDisplayedValues() {
    const left = has(ui.leftThruster) ? Number(ui.leftThruster.value) : 0;
    const right = has(ui.rightThruster) ? Number(ui.rightThruster.value) : 0;
    const conveyor = has(ui.conveyor) ? Number(ui.conveyor.value) : 0;
    const avg = (left + right) / 2;
    const diff = right - left;

    setText(ui.leftThrusterValue, has(ui.leftThruster) ? signedPercentText(left) : '--');
    setText(ui.rightThrusterValue, has(ui.rightThruster) ? signedPercentText(right) : '--');
    setText(ui.conveyorValue, has(ui.conveyor) ? signedPercentText(conveyor) : '--');

    setPowerBar(ui.leftPowerBar, left);
    setPowerBar(ui.rightPowerBar, right);
    setPowerBar(ui.conveyorPowerBar, conveyor);

    setText(ui.speedHudVal, signedPercentText(avg));
    setText(ui.turnHudVal, signedPercentText(diff / 2));
    setText(ui.avgThrustVal, signedPercentText(avg));
    setText(ui.diffThrustVal, signedPercentText(diff));
    setText(ui.driveStateVal, computeDriveState(left, right));
  }

  function updateManualLockUi() {
    if (ui.manualLockBanner) {
      ui.manualLockBanner.classList.toggle('hidden', !manualLocked);
    }
    qs('[data-manual], #leftThruster, #rightThruster, #conveyor, [data-cam-step], #btnCamCenter, #btnForward, #btnBackward, #btnRotateLeft, #btnRotateRight, #btnStopAll')
      .forEach((elem) => { elem.disabled = manualLocked; });
  }

  function renderDetections(detections) {
    if (!ui.detectionsBox) return;

    const safeDetections = Array.isArray(detections) ? detections : [];
    ui.detectionsBox.innerHTML = '';

    setText(ui.detectionCountVal, `${safeDetections.length}`);

    if (!safeDetections.length) {
      const empty = document.createElement('div');
      empty.className = 'detItem empty';
      empty.textContent = 'Aucune détection.';
      ui.detectionsBox.appendChild(empty);
      setText(ui.primaryDetectionVal, 'none');
      setText(ui.confidenceVal, '--');
      return;
    }

    const best = safeDetections.find((d) => d.primary) || safeDetections[0];
    setText(ui.primaryDetectionVal, maybeText(best.label, 'none'));
    setText(ui.confidenceVal, Number.isFinite(best.confidence) ? `${(best.confidence * 100).toFixed(0)} %` : '--');

    safeDetections.forEach((det, idx) => {
      const div = document.createElement('div');
      div.className = `detItem ${det.primary ? 'primary' : ''}`;
      div.innerHTML = `
        <strong><span>${idx + 1}. ${maybeText(det.label, 'unknown')}</span><span>${((det.confidence || 0) * 100).toFixed(0)}%</span></strong>
        <small>x=${det.x ?? '--'}, y=${det.y ?? '--'}, w=${det.w ?? '--'}, h=${det.h ?? '--'}</small>
      `;
      ui.detectionsBox.appendChild(div);
    });
  }

  function updateDetectionIndicator(vision, detections) {
    const safeDetections = Array.isArray(detections) ? detections : [];
    const hasDetection = !!(vision && vision.object_detected) || safeDetections.length > 0;
    const count = Number.isFinite(Number(vision?.detection_count))
      ? Number(vision.detection_count)
      : safeDetections.length;
    const label = hasDetection ? `OBJET DÉTECTÉ (${count})` : 'AUCUN OBJET';

    setText(ui.statusDetection, 'Détection IA');
    setText(ui.statusDetectionMini, label);
    setText(ui.cameraDetectionIndicator, label);

    [ui.statusDetectionMini, ui.cameraDetectionIndicator].forEach((el) => {
      if (!el) return;
      el.classList.toggle('detection-on', hasDetection);
      el.classList.toggle('detection-off', !hasDetection);
    });
  }

  function sendThrusters() {
    if (!ui.leftThruster || !ui.rightThruster) return;
    sendIfManual({
      type: 'command',
      action: 'thrusters',
      left_pct: Number(ui.leftThruster.value),
      right_pct: Number(ui.rightThruster.value)
    });
  }

  function sendConveyor() {
    if (!ui.conveyor) return;
    sendIfManual({
      type: 'command',
      action: 'conveyor',
      pct: Number(ui.conveyor.value)
    });
  }

  function sendCameraSetting(name, value) {
    sendWs({
      type: 'command',
      action: 'camera_setting',
      setting: name,
      value: Number(value)
    });
  }

  function applyTelemetry(t) {
    if (!t || typeof t !== 'object') return;
    lastTelemetry = t;

    currentMode = t.mode || 'manual';
    manualLocked = !!t.drive_controls_locked;

    if (ui.modeBadge) {
      ui.modeBadge.textContent = `MODE ${currentMode.toUpperCase()}`;
      ui.modeBadge.classList.toggle('badge-manual', currentMode === 'manual');
      ui.modeBadge.classList.toggle('badge-auto', currentMode === 'auto');
    }

    if (ui.missionBadge) {
      ui.missionBadge.textContent = t.mission_enabled ? 'MISSION ON' : 'MISSION OFF';
      ui.missionBadge.classList.toggle('badge-on', !!t.mission_enabled);
      ui.missionBadge.classList.toggle('badge-off', !t.mission_enabled);
    }

    if (ui.overlayBadge) {
      ui.overlayBadge.textContent = t.overlay_enabled ? 'Overlay ON' : 'Overlay OFF';
      ui.overlayBadge.classList.toggle('badge-on', !!t.overlay_enabled);
      ui.overlayBadge.classList.toggle('badge-off', !t.overlay_enabled);
    }

    const lidar = t.lidar || {};
    const lidarConnected = !!lidar.connected;
    if (ui.lidarBadge) {
      ui.lidarBadge.textContent = lidarConnected ? (lidar.mock_mode ? 'LIDAR MOCK' : 'LIDAR ON') : 'LIDAR OFF';
      ui.lidarBadge.classList.toggle('badge-on', lidarConnected);
      ui.lidarBadge.classList.toggle('badge-off', !lidarConnected);
    }

    const vision = t.vision || {};
    const detections = Array.isArray(vision.detections) ? vision.detections : [];

    setText(ui.statusText, `status: ${t.status_text || '--'}`);
    setText(ui.autoState, `auto state: ${t.auto_state || '--'}`);
    setText(ui.targetVal, `Target: ${vision.target || '--'} (${((vision.confidence || 0) * 100).toFixed(0)}%)`);
    setText(ui.fpsVal, `FPS: ${(vision.fps || 0).toFixed(1)}`);
    setText(ui.batteryVal, `Battery: ${(t.battery_v || 0).toFixed(2)} V`);
    updateDetectionIndicator(vision, detections);

    const headingText = `${(t.compass?.heading_deg || 0).toFixed(1)}°`;
    const northText = `${(t.compass?.mag_north_deg || 0).toFixed(1)}°`;

    setText(ui.headingVal, headingText);
    setText(ui.headingMiniVal, headingText);
    setText(ui.videoHeadingVal, headingText);
    setText(ui.northVal, northText);
    setText(ui.northValDuplicate, northText);
    setText(ui.rollVal, `${(t.imu?.roll_deg || 0).toFixed(1)}°`);
    setText(ui.pitchVal, `${(t.imu?.pitch_deg || 0).toFixed(1)}°`);
    setText(ui.yawVal, `${(t.imu?.yaw_rate_dps || 0).toFixed(1)} °/s`);
    setText(ui.gyroVecVal, `${(t.imu?.gyro_x_dps || 0).toFixed(1)} / ${(t.imu?.gyro_y_dps || 0).toFixed(1)} / ${(t.imu?.gyro_z_dps || 0).toFixed(1)}`);

    setText(ui.lidarStatusVal, lidarConnected ? (lidar.status_text || (lidar.mock_mode ? 'mock' : 'running')) : '--');
    setText(ui.lidarHzVal, `${(lidar.scan_hz || 0).toFixed(1)} Hz`);
    setText(ui.lidarSamplesVal, `${Math.round(lidar.sample_count || 0)}`);
    setText(ui.lidarFrontVal, mmText(lidar.front_mm));
    setText(ui.lidarFrontRightVal, mmText(lidar.front_right_mm));
    setText(ui.lidarRightVal, mmText(lidar.right_mm));
    setText(ui.lidarRearVal, mmText(lidar.rear_mm));
    setText(ui.lidarLeftVal, mmText(lidar.left_mm));
    setText(ui.lidarFrontLeftVal, mmText(lidar.front_left_mm));

    if (ui.leftThruster) ui.leftThruster.value = Math.round(t.motors?.left_pct || 0);
    if (ui.rightThruster) ui.rightThruster.value = Math.round(t.motors?.right_pct || 0);
    if (ui.conveyor) ui.conveyor.value = Math.round(t.motors?.conveyor_pct || 0);
    setText(ui.camPanVal, `Pan ${Math.round(t.motors?.cam_pan_deg || 0)}°`);
    setText(ui.camTiltVal, `Tilt ${Math.round(t.motors?.cam_tilt_deg || 0)}°`);

    if (ui.expRange) ui.expRange.value = Math.round(t.camera?.exposure || 0);
    if (ui.brightRange) ui.brightRange.value = Math.round(t.camera?.brightness || 50);
    if (ui.contrastRange) ui.contrastRange.value = Math.round(t.camera?.contrast || 50);

    lastLidarPoints = Array.isArray(lidar.points) ? lidar.points : [];
    lastLidarMaxDistance = Math.max(1000, Number(lidar.max_distance_mm || 8000));

    setText(ui.videoModeMini, currentMode.toUpperCase());
    setText(ui.videoMissionMini, t.mission_enabled ? 'ACTIVE' : 'OFF');
    setText(ui.modeInfoVal, currentMode.toUpperCase());
    setText(ui.missionInfoVal, t.mission_enabled ? 'ACTIVE' : 'OFF');
    setText(ui.overlayInfoVal, t.overlay_enabled ? 'ON' : 'OFF');
    setText(ui.trackingVal, maybeText(t.vision?.target, 'none'));

    updateResolutionLabels();

    refreshDisplayedValues();
    updateManualLockUi();
    renderDetections(detections);
    drawCompass(t.compass?.heading_deg || 0);
    drawGyro(t.imu?.roll_deg || 0, t.imu?.pitch_deg || 0, t.imu?.yaw_rate_dps || 0);
    drawLidar(lastLidarPoints, lastLidarMaxDistance, {
      front: lidar.front_mm || 0,
      right: lidar.right_mm || 0,
      left: lidar.left_mm || 0,
      rear: lidar.rear_mm || 0
    });
  }

  function setThrustersLocal(left, right) {
    if (!ui.leftThruster || !ui.rightThruster) return;
    ui.leftThruster.value = `${Math.round(clamp(left, -100, 100))}`;
    ui.rightThruster.value = `${Math.round(clamp(right, -100, 100))}`;
    refreshDisplayedValues();
  }

  function applyKeyboardDrive() {
    if (!ui.leftThruster || !ui.rightThruster) return;
    if (manualLocked) return;

    let left = 0;
    let right = 0;

    const forward = activeKeys.has('arrowup') || activeKeys.has('w');
    const backward = activeKeys.has('arrowdown') || activeKeys.has('s');
    const rotateLeft = activeKeys.has('arrowleft') || activeKeys.has('a');
    const rotateRight = activeKeys.has('arrowright') || activeKeys.has('d');

    if (forward) {
      left += 60;
      right += 60;
    }
    if (backward) {
      left -= 45;
      right -= 45;
    }
    if (rotateLeft) {
      left -= 35;
      right += 35;
    }
    if (rotateRight) {
      left += 35;
      right -= 35;
    }

    left = clamp(left, -100, 100);
    right = clamp(right, -100, 100);

    setThrustersLocal(left, right);
    sendThrusters();
  }

  function stopKeyboardDrive() {
    keyboardDriveActive = false;
    activeKeys.clear();
    if (!ui.leftThruster || !ui.rightThruster) return;
    setThrustersLocal(0, 0);
    sendIfManual({ type: 'command', action: 'stop_all' });
  }

  function drawCompass(heading) {
    if (!ui.compassCanvas) return;
    const ctx = ui.compassCanvas.getContext('2d');
    const w = ui.compassCanvas.width;
    const h = ui.compassCanvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) * 0.40;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '16px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('N', cx, cy - r - 10);
    ctx.fillText('S', cx, cy + r + 22);
    ctx.fillText('E', cx + r + 18, cy + 6);
    ctx.fillText('W', cx - r - 18, cy + 6);

    for (let i = 0; i < 360; i += 30) {
      const rad = (i - 90) * Math.PI / 180;
      const x1 = cx + Math.cos(rad) * (r - 10);
      const y1 = cy + Math.sin(rad) * (r - 10);
      const x2 = cx + Math.cos(rad) * r;
      const y2 = cy + Math.sin(rad) * r;
      ctx.strokeStyle = '#64748b';
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    const rad = (heading - 90) * Math.PI / 180;
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(rad) * (r - 16), cy + Math.sin(rad) * (r - 16));
    ctx.stroke();

    ctx.fillStyle = '#f8fafc';
    ctx.font = '700 22px Arial';
    ctx.fillText(`${heading.toFixed(1)}°`, cx, cy + 8);
  }

  function drawGyro(roll, pitch, yawRate) {
    if (!ui.gyroCanvas) return;
    const ctx = ui.gyroCanvas.getContext('2d');
    const w = ui.gyroCanvas.width;
    const h = ui.gyroCanvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, w, h);

    const centerY = h / 2;
    const centerX = w / 2;
    const rollRad = roll * Math.PI / 180;
    const skyOffset = pitch * 2.5;

    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(-rollRad);
    ctx.fillStyle = '#0ea5e9';
    ctx.fillRect(-220, -240 + skyOffset, 440, 220);
    ctx.fillStyle = '#854d0e';
    ctx.fillRect(-220, -20 + skyOffset, 440, 220);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-220, skyOffset);
    ctx.lineTo(220, skyOffset);
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(centerX - 70, centerY);
    ctx.lineTo(centerX + 70, centerY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(centerX, centerY - 20);
    ctx.lineTo(centerX, centerY + 20);
    ctx.stroke();

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '16px Arial';
    ctx.fillText(`Roll: ${roll.toFixed(1)}°`, 18, 28);
    ctx.fillText(`Pitch: ${pitch.toFixed(1)}°`, 18, 52);
    ctx.fillText(`Yaw rate: ${yawRate.toFixed(1)} °/s`, 18, 76);
  }

  function drawLidar(points, maxDistance, sectors) {
    if (!ui.lidarCanvas) return;
    const ctx = ui.lidarCanvas.getContext('2d');
    const w = ui.lidarCanvas.width;
    const h = ui.lidarCanvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) * 0.43;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = '#243244';
    ctx.lineWidth = 1;
    for (let ring = 1; ring <= 4; ring += 1) {
      ctx.beginPath();
      ctx.arc(cx, cy, (r * ring) / 4, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx, cy + r);
    ctx.moveTo(cx - r, cy);
    ctx.lineTo(cx + r, cy);
    ctx.stroke();

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '13px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('Front', cx, 16);
    ctx.fillText('Rear', cx, h - 8);
    ctx.fillText('Left', 26, cy + 4);
    ctx.fillText('Right', w - 26, cy + 4);

    for (const p of points) {
      if (!Number.isFinite(p.a) || !Number.isFinite(p.d) || p.d <= 0) continue;
      const ratio = Math.min(1, p.d / maxDistance);
      const rr = ratio * r;
      const rad = (p.a - 90) * Math.PI / 180;
      const x = cx + Math.cos(rad) * rr;
      const y = cy + Math.sin(rad) * rr;

      const near = p.d < 600;
      const mid = p.d >= 600 && p.d < 1400;
      ctx.fillStyle = near ? '#ef4444' : (mid ? '#f59e0b' : '#38bdf8');
      ctx.fillRect(x, y, 2, 2);
    }

    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy - r);
    ctx.stroke();

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '14px Arial';
    ctx.textAlign = 'left';
    ctx.fillText(`F ${mmText(sectors.front)}`, 12, 22);
    ctx.fillText(`R ${mmText(sectors.right)}`, 12, 42);
    ctx.fillText(`L ${mmText(sectors.left)}`, 12, 62);
    ctx.fillText(`B ${mmText(sectors.rear)}`, 12, 82);
  }

  function bind(id, eventName, handler) {
    const el = $(id);
    if (el) el.addEventListener(eventName, handler);
  }

  if (ui.leftThruster) ui.leftThruster.addEventListener('input', () => { refreshDisplayedValues(); sendThrusters(); });
  if (ui.rightThruster) ui.rightThruster.addEventListener('input', () => { refreshDisplayedValues(); sendThrusters(); });
  if (ui.conveyor) ui.conveyor.addEventListener('input', () => { refreshDisplayedValues(); sendConveyor(); });

  [ui.expRange, ui.brightRange, ui.contrastRange].forEach((elem) => {
    if (!elem) return;
    elem.addEventListener('input', () => sendCameraSetting(elem.id, elem.value));
  });

  qs('[data-cam-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      sendIfManual({
        type: 'command',
        action: 'camera_step',
        axis: btn.dataset.axis,
        steps: Number(btn.dataset.steps)
      });
    });
  });

  bind('btnCamCenter', 'click', () => sendIfManual({ type: 'command', action: 'camera_center' }));
  bind('btnMissionStart', 'click', () => sendWs({ type: 'command', action: 'mission', cmd: 'start' }));
  bind('btnMissionStop', 'click', () => sendWs({ type: 'command', action: 'mission', cmd: 'stop' }));
  bind('btnStopAll', 'click', () => {
    if (ui.leftThruster) ui.leftThruster.value = 0;
    if (ui.rightThruster) ui.rightThruster.value = 0;
    if (ui.conveyor) ui.conveyor.value = 0;
    refreshDisplayedValues();
    keyboardDriveActive = false;
    activeKeys.clear();
    sendIfManual({ type: 'command', action: 'stop_all' });
  });

  bind('btnManualMode', 'click', () => sendWs({ type: 'command', action: 'mode_set', mode: 'manual' }));
  bind('btnAutoMode', 'click', () => sendWs({ type: 'command', action: 'mode_set', mode: 'auto' }));
  bind('btnOverlayOn', 'click', () => sendWs({ type: 'command', action: 'overlay_toggle', enabled: true }));
  bind('btnOverlayOff', 'click', () => sendWs({ type: 'command', action: 'overlay_toggle', enabled: false }));
  bind('btnCamSnapshot', 'click', () => sendWs({ type: 'command', action: 'camera_record', cmd: 'snapshot' }));
  bind('btnCamRecord', 'click', () => sendWs({ type: 'command', action: 'camera_record', cmd: 'start' }));
  bind('btnCamStopRecord', 'click', () => sendWs({ type: 'command', action: 'camera_record', cmd: 'stop' }));

  bind('btnForward', 'click', () => {
    if (!ui.leftThruster || !ui.rightThruster) return;
    setThrustersLocal(60, 60);
    sendThrusters();
  });

  bind('btnBackward', 'click', () => {
    if (!ui.leftThruster || !ui.rightThruster) return;
    setThrustersLocal(-45, -45);
    sendThrusters();
  });

  bind('btnRotateLeft', 'click', () => {
    if (!ui.leftThruster || !ui.rightThruster) return;
    setThrustersLocal(-35, 35);
    sendThrusters();
  });

  bind('btnRotateRight', 'click', () => {
    if (!ui.leftThruster || !ui.rightThruster) return;
    setThrustersLocal(35, -35);
    sendThrusters();
  });

  bind('btnSTOPprogramme', 'click', () => {
    const state = window.confirm('Êtes-vous sûr de vouloir arrêter le programme ?');
    if (state) {
      requestProgramStop();
    }
  });

  bind('btnCalib', 'click', () => {
    sendWs({ type: 'command', action: 'camera', cmd: 'calibration' });
  });

  bind('btnVisionCfgReload', 'click', loadVisionConfig);
  bind('btnVisionCfgApply', 'click', applyVisionConfig);
  bind('btnVisionCfgSave', 'click', saveVisionConfig);
  bind('btnVisionCfgMakeReset', 'click', makeVisionReset);
  bind('btnVisionCfgReset', 'click', resetVisionConfig);

  window.addEventListener('keydown', (ev) => {
    const tag = (ev.target && ev.target.tagName) ? ev.target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    const key = String(ev.key || '').toLowerCase();
    if (!['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd', ' '].includes(key)) return;

    if (key === ' ') {
      ev.preventDefault();
      if (!manualLocked) {
        stopKeyboardDrive();
      }
      return;
    }

    if (manualLocked) return;
    ev.preventDefault();
    keyboardDriveActive = true;
    activeKeys.add(key);
    applyKeyboardDrive();
  });

  window.addEventListener('keyup', (ev) => {
    const key = String(ev.key || '').toLowerCase();
    if (!['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd'].includes(key)) return;
    activeKeys.delete(key);
    if (!activeKeys.size) {
      keyboardDriveActive = false;
      if (!manualLocked) {
        setThrustersLocal(0, 0);
        sendIfManual({ type: 'command', action: 'stop_all' });
      }
      return;
    }
    applyKeyboardDrive();
  });

  window.addEventListener('blur', () => {
    if (keyboardDriveActive && !manualLocked) {
      stopKeyboardDrive();
    } else {
      activeKeys.clear();
      keyboardDriveActive = false;
    }
  });

  if (ui.videoFeed) {
    ui.videoFeed.addEventListener('error', () => {
      logLine('Le flux MJPEG ne répond pas encore.', 'logLineErr');
    });
    ui.videoFeed.addEventListener('load', () => {
      updateResolutionLabels();
    });
  }

  refreshDisplayedValues();
  updateManualLockUi();
  drawCompass(0);
  drawGyro(0, 0, 0);
  drawLidar([], 8000, { front: 0, right: 0, left: 0, rear: 0 });
  loadSystemProfile();
  loadInitialTelemetry();
  loadVisionConfig();
  connectWs();
})();
