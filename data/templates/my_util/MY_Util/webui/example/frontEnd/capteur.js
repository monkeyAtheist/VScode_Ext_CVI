(() => {
  const $ = (id) => document.getElementById(id);

  const wsBadge = $('wsBadge');
  const cfgBadge = $('cfgBadge');
  const logEl = $('log');

  const transportEl = $('transport');
  const deviceEl = $('device');
  const presetEl = $('preset');
  const payloadEl = $('payload');
  const encodingEl = $('encoding');
  const appendNlEl = $('appendNl');

  const expectReplyEl = $('expectReply');
  const replyModeEl = $('replyMode');
  const timeoutMsEl = $('timeoutMs');
  const maxBytesEl = $('maxBytes');
  const clearRxEl = $('clearRx');
  const replyBoxEl = $('replyBox');

  let cfg = null;
  let ws = null;

  function esc(s) {
    return (s ?? '').toString();
  }

  function logLine(msg, cls) {
    const div = document.createElement('div');
    if (cls) div.className = cls;
    div.textContent = msg;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function fmtTs(ms) {
    try {
      return new Date(ms).toLocaleTimeString();
    } catch {
      return '' + ms;
    }
  }

  function setReplyBox(rx) {
    if (!rx) {
      replyBoxEl.value = '';
      return;
    }
    const lines = [];
    if (rx.reply_ascii) lines.push('ASCII: ' + rx.reply_ascii);
    if (rx.reply_hex) lines.push('HEX:   ' + rx.reply_hex);
    replyBoxEl.value = lines.join('\n');
  }

  function populateDevicesAndPresets() {
    if (!cfg) return;

    const t = transportEl.value;
    const section = cfg[t] || { devices: [], presets: [] };

    // devices
    deviceEl.innerHTML = '';
    for (const d of section.devices || []) {
      const opt = document.createElement('option');
      opt.value = d.spec;
      opt.textContent = `${d.name}  (${d.source || 'ini'})`;
      deviceEl.appendChild(opt);
    }

    // presets
    presetEl.innerHTML = '';
    {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '-- none --';
      presetEl.appendChild(opt);
    }
    for (const p of section.presets || []) {
      const opt = document.createElement('option');
      opt.value = p.value;
      opt.textContent = p.name;
      presetEl.appendChild(opt);
    }

    cfgBadge.textContent = 'Config: OK';
  }

  async function loadConfig() {
    try {
      const r = await fetch('/api/comms_config');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      cfg = await r.json();
      populateDevicesAndPresets();
      logLine('[cfg] loaded', '');
    } catch (e) {
      cfgBadge.textContent = 'Config: ERROR';
      logLine('[cfg] ' + e.message, 'logLineErr');
    }
  }

  async function loadHistory() {
    try {
      const r = await fetch('/api/comms_history?limit=200');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      const items = data.items || [];
      logLine('--- history ---');
      for (const it of items) {
        const ts = fmtTs(it.ts_ms);
        const dir = (it.dir || '').toUpperCase();
        const base = `[${ts}] ${dir} ${it.transport || ''} ${it.device || ''} :: ${it.data || ''}`;
        logLine(base, dir === 'TX' ? 'logLineTx' : 'logLineRx');
      }
    } catch (e) {
      logLine('[history] ' + e.message, 'logLineErr');
    }
  }

  async function scanDevices() {
    try {
      $('scanBtn').disabled = true;
      const r = await fetch('/api/comms_scan', { method: 'POST' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      cfg = await r.json();
      populateDevicesAndPresets();
      logLine('[scan] ok');
    } catch (e) {
      logLine('[scan] ' + e.message, 'logLineErr');
    } finally {
      $('scanBtn').disabled = false;
    }
  }

  function connectWs() {
    const scheme = (location.protocol === 'https:') ? 'wss' : 'ws';
    ws = new WebSocket(`${scheme}://${location.host}/ws`);

    ws.onopen = () => {
      wsBadge.textContent = 'WS: connected';
      logLine('[ws] connected');
      // optional: ask for config broadcast
    };

    ws.onclose = () => {
      wsBadge.textContent = 'WS: disconnected';
      logLine('[ws] disconnected', 'logLineErr');
    };

    ws.onmessage = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); }
      catch { return; }

      if (data.type === 'comms_config' && data.payload) {
        cfg = data.payload;
        populateDevicesAndPresets();
        logLine('[ws] config updated');
        return;
      }

      if (data.type === 'comms_rx' && data.payload) {
        const rx = data.payload;
        setReplyBox(rx);
        const line = `[${fmtTs(Date.now())}] RX ${rx.transport || ''} ${rx.device || ''} :: ${rx.reply_hex || rx.reply_ascii || ''}`;
        logLine(line, 'logLineRx');
        return;
      }

      if (data.type === 'info') {
        logLine('[info] ' + (data.message || JSON.stringify(data.payload || '')));
        return;
      }
      if (data.type === 'error') {
        logLine('[error] ' + (data.message || JSON.stringify(data.payload || '')),
          'logLineErr');
        return;
      }
    };
  }

  function wsSend(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logLine('[ws] not connected', 'logLineErr');
      return;
    }
    ws.send(JSON.stringify(obj));
  }

  function sendCommand() {
    const transport = transportEl.value;
    const device = deviceEl.value;
    const payload = payloadEl.value;

    if (!device) {
      logLine('Select a device first', 'logLineErr');
      return;
    }

    // IMPORTANT: le backend websocket extrait les champs sous forme STRING.
    const msg = {
      action: 'comms_send',
      transport: esc(transport),
      device: esc(device),
      payload: esc(payload),
      encoding: esc(encodingEl.value),
      append_nl: appendNlEl.checked ? 'true' : 'false',
      expect_reply: expectReplyEl.checked ? 'true' : 'false',
      reply_mode: esc(replyModeEl.value),
      timeout_ms: esc(timeoutMsEl.value || '250'),
      max_bytes: esc(maxBytesEl.value || '512'),
      clear_rx: clearRxEl.checked ? 'true' : 'false',
    };

    const ts = fmtTs(Date.now());
    logLine(`[${ts}] TX ${transport} ${device} :: ${payload}`, 'logLineTx');
    wsSend(msg);
  }

  // UI
  transportEl.addEventListener('change', populateDevicesAndPresets);
  presetEl.addEventListener('change', () => {
    const v = presetEl.value;
    if (v) payloadEl.value = v;
  });

  $('sendBtn').addEventListener('click', sendCommand);
  $('scanBtn').addEventListener('click', scanDevices);
  $('reloadHistoryBtn').addEventListener('click', loadHistory);
  $('clearLogBtn').addEventListener('click', () => { logEl.textContent = ''; });

  // boot
  loadConfig().then(loadHistory);
  connectWs();
})();
