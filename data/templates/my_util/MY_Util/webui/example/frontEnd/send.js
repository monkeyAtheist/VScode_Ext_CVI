(() => {
  const $ = (id) => document.getElementById(id);

  const ui = {
    wsBadge: $('wsBadge'),
    cfgBadge: $('cfgBadge'),
    log: $('log'),

    transport: $('transport'),
    device: $('device'),
    preset: $('preset'),
    payload: $('payload'),
    encoding: $('encoding'),
    appendNl: $('appendNl'),

    expectReply: $('expectReply'),
    replyMode: $('replyMode'),
    timeoutMs: $('timeoutMs'),
    maxBytes: $('maxBytes'),
    clearRx: $('clearRx'),
    replyBox: $('replyBox'),

    activeTransportVal: $('activeTransportVal'),
    activeDeviceVal: $('activeDeviceVal'),
    presetCountVal: $('presetCountVal'),
    activeEncodingVal: $('activeEncodingVal'),

    deviceSpecVal: $('deviceSpecVal'),
    deviceSourceVal: $('deviceSourceVal'),
    presetPreviewVal: $('presetPreviewVal'),
    presetHintVal: $('presetHintVal'),
    presetLibraryBadge: $('presetLibraryBadge'),
    presetSearch: $('presetSearch'),
    presetQuickGrid: $('presetQuickGrid')
  };

  let cfg = null;
  let ws = null;
  let reconnectTimer = null;
  let currentSection = { devices: [], presets: [] };

  function esc(s) {
    return (s ?? '').toString();
  }

  function setText(el, value) {
    if (el) el.textContent = value;
  }

  function logLine(msg, cls = 'logLine') {
    if (!ui.log) return;
    const div = document.createElement('div');
    div.className = cls;
    div.textContent = msg;
    ui.log.appendChild(div);
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function fmtTs(ms) {
    try {
      return new Date(ms).toLocaleTimeString();
    } catch {
      return String(ms);
    }
  }

  function setReplyBox(rx) {
    if (!ui.replyBox) return;
    if (!rx) {
      ui.replyBox.value = '';
      return;
    }
    const lines = [];
    if (rx.reply_ascii) lines.push('ASCII: ' + rx.reply_ascii);
    if (rx.reply_hex) lines.push('HEX:   ' + rx.reply_hex);
    if (!lines.length && rx.data) lines.push(String(rx.data));
    ui.replyBox.value = lines.join('\n');
  }

  function normalizeTransportLabel(value) {
    const map = {
      uart: 'UART',
      usb: 'USB serial',
      bluetooth: 'Bluetooth',
      wifi: 'WiFi',
      ethernet: 'RJ45',
      i2c: 'I²C',
      spi: 'SPI'
    };
    return map[value] || value || '--';
  }

  function groupPreset(name) {
    const key = (name || '').toLowerCase();
    if (key.includes('mode')) return 'Modes';
    if (key.includes('move')) return 'Déplacement';
    if (key.includes('turn')) return 'Rotation';
    if (key.includes('speed')) return 'Vitesse';
    if (key.includes('catch')) return 'Collecte';
    if (key.includes('objectif')) return 'Objectif';
    if (key.includes('ping') || key.includes('ack')) return 'Diagnostic';
    return 'Autres';
  }

  function getSelectedDeviceMeta() {
    const selectedSpec = ui.device?.value || '';
    return (currentSection.devices || []).find((d) => d.spec === selectedSpec) || null;
  }

  function updateSummary() {
    setText(ui.activeTransportVal, normalizeTransportLabel(ui.transport?.value));
    setText(ui.activeEncodingVal, (ui.encoding?.value || 'ascii').toUpperCase());

    const deviceMeta = getSelectedDeviceMeta();
    setText(ui.activeDeviceVal, deviceMeta ? deviceMeta.name : '--');
    setText(ui.deviceSpecVal, deviceMeta ? deviceMeta.spec : '--');
    setText(ui.deviceSourceVal, deviceMeta ? `source: ${deviceMeta.source || 'ini'}` : 'source: --');

    const presetValue = ui.preset?.value || '';
    setText(ui.presetPreviewVal, presetValue || '--');
    setText(ui.presetCountVal, String((currentSection.presets || []).length));
    setText(ui.presetLibraryBadge, `${(currentSection.presets || []).length} preset${(currentSection.presets || []).length > 1 ? 's' : ''}`);
  }

  function renderQuickPresets() {
    if (!ui.presetQuickGrid) return;

    const allPresets = Array.isArray(currentSection.presets) ? currentSection.presets : [];
    const q = (ui.presetSearch?.value || '').trim().toLowerCase();
    const presets = q
      ? allPresets.filter((p) => `${p.name} ${p.value}`.toLowerCase().includes(q))
      : allPresets;

    ui.presetQuickGrid.innerHTML = '';

    if (!presets.length) {
      const empty = document.createElement('div');
      empty.className = 'presetEmptyState';
      empty.textContent = 'Aucun preset ne correspond à la recherche pour ce transport.';
      ui.presetQuickGrid.appendChild(empty);
      return;
    }

    const grouped = {};
    presets.forEach((p) => {
      const g = groupPreset(p.name);
      if (!grouped[g]) grouped[g] = [];
      grouped[g].push(p);
    });

    Object.entries(grouped).forEach(([groupName, items]) => {
      const section = document.createElement('div');
      section.className = 'presetGroup';

      const title = document.createElement('div');
      title.className = 'presetGroupTitle';
      title.textContent = groupName;
      section.appendChild(title);

      const grid = document.createElement('div');
      grid.className = 'presetGroupGrid';

      items.forEach((preset) => {
        const card = document.createElement('div');
        card.className = 'presetCard';
        card.innerHTML = `
          <div class="presetCardHead">
            <strong>${preset.name}</strong>
            <span class="badge">${normalizeTransportLabel(ui.transport?.value)}</span>
          </div>
          <code>${preset.value}</code>
          <div class="presetCardActions">
            <button type="button" class="secondary" data-role="load">Charger</button>
            <button type="button" data-role="send">Envoyer</button>
          </div>
        `;

        card.querySelector('[data-role="load"]').addEventListener('click', () => {
          if (ui.preset) ui.preset.value = preset.value;
          if (ui.payload) ui.payload.value = preset.value;
          setText(ui.presetPreviewVal, preset.value);
          setText(ui.presetHintVal, `Preset chargé: ${preset.name}`);
          updateSummary();
        });

        card.querySelector('[data-role="send"]').addEventListener('click', () => {
          if (ui.preset) ui.preset.value = preset.value;
          if (ui.payload) ui.payload.value = preset.value;
          setText(ui.presetPreviewVal, preset.value);
          setText(ui.presetHintVal, `Envoi direct du preset: ${preset.name}`);
          updateSummary();
          sendCommand();
        });

        grid.appendChild(card);
      });

      section.appendChild(grid);
      ui.presetQuickGrid.appendChild(section);
    });
  }

  function populateDevicesAndPresets() {
    if (!cfg || !ui.transport) return;

    const selectedTransport = ui.transport.value;
    const prevDevice = ui.device?.value || '';
    const prevPreset = ui.preset?.value || '';
    currentSection = cfg[selectedTransport] || { devices: [], presets: [] };

    if (ui.device) {
      ui.device.innerHTML = '';
      (currentSection.devices || []).forEach((d) => {
        const opt = document.createElement('option');
        opt.value = d.spec;
        opt.textContent = `${d.name} (${d.source || 'ini'})`;
        ui.device.appendChild(opt);
      });

      if (prevDevice && (currentSection.devices || []).some((d) => d.spec === prevDevice)) {
        ui.device.value = prevDevice;
      } else if (selectedTransport === 'uart') {
        // Pour le robot, on privilégie l'UART GPIO de la Raspberry validé avec le test Python.
        const preferred = (currentSection.devices || []).find((d) =>
          /motherboard|pi uart|serial0/i.test(`${d.name} ${d.spec}`)
        );
        if (preferred) {
          ui.device.value = preferred.spec;
        } else if (ui.device.options.length > 0) {
          ui.device.selectedIndex = 0;
        }
      } else if (ui.device.options.length > 0) {
        ui.device.selectedIndex = 0;
      }
    }

    if (ui.preset) {
      ui.preset.innerHTML = '';
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '-- choisir un preset --';
      ui.preset.appendChild(empty);

      (currentSection.presets || []).forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.value;
        opt.textContent = p.name;
        ui.preset.appendChild(opt);
      });

      if (prevPreset && (currentSection.presets || []).some((p) => p.value === prevPreset)) {
        ui.preset.value = prevPreset;
      }
    }

    if (ui.cfgBadge) ui.cfgBadge.textContent = 'Config: OK';
    updateSummary();
    renderQuickPresets();
  }

  async function loadConfig() {
    try {
      const r = await fetch('/api/comms_config', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      cfg = await r.json();
      populateDevicesAndPresets();
      logLine('[cfg] loaded');
    } catch (e) {
      if (ui.cfgBadge) ui.cfgBadge.textContent = 'Config: ERROR';
      logLine('[cfg] ' + e.message, 'logLineErr');
    }
  }

  async function loadHistory() {
    try {
      const r = await fetch('/api/comms_history?limit=200', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      const items = data.items || [];
      if (ui.log) ui.log.textContent = '';
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
    const btn = $('scanBtn');
    try {
      if (btn) btn.disabled = true;
      const r = await fetch('/api/comms_scan', { method: 'POST' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      cfg = await r.json();
      populateDevicesAndPresets();
      logLine('[scan] ok');
    } catch (e) {
      logLine('[scan] ' + e.message, 'logLineErr');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function connectWs() {
    const scheme = (location.protocol === 'https:') ? 'wss' : 'ws';
    ws = new WebSocket(`${scheme}://${location.host}/ws`);

    ws.onopen = () => {
      if (ui.wsBadge) {
        ui.wsBadge.textContent = 'WS connected';
        ui.wsBadge.classList.remove('badge-off');
        ui.wsBadge.classList.add('badge-on');
      }
      logLine('[ws] connected');
    };

    ws.onclose = () => {
      if (ui.wsBadge) {
        ui.wsBadge.textContent = 'WS disconnected';
        ui.wsBadge.classList.remove('badge-on');
        ui.wsBadge.classList.add('badge-off');
      }
      logLine('[ws] disconnected', 'logLineErr');
      if (!reconnectTimer) {
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          connectWs();
        }, 1200);
      }
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
        logLine('[error] ' + (data.message || JSON.stringify(data.payload || '')), 'logLineErr');
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
    const transport = ui.transport?.value || '';
    const device = ui.device?.value || '';
    const payload = ui.payload?.value || '';

    if (!device) {
      logLine('Sélectionne un device avant l\'envoi.', 'logLineErr');
      return;
    }

    if (!payload.trim()) {
      logLine('Le payload est vide.', 'logLineErr');
      return;
    }

    const appendNl = ui.appendNl?.checked ? 'true' : 'false';
    if ((transport || '').toLowerCase() === 'uart' && appendNl !== 'true') {
      logLine('[warn] UART Arduino: append \n est désactivé, la Mega attendra probablement la fin de ligne.', 'logLineErr');
    }

    const msg = {
      action: 'comms_send',
      transport: esc(transport),
      device: esc(device),
      payload: esc(payload),
      encoding: esc(ui.encoding?.value || 'ascii'),
      append_nl: appendNl,
      expect_reply: ui.expectReply?.checked ? 'true' : 'false',
      reply_mode: esc(ui.replyMode?.value || 'line'),
      timeout_ms: esc(ui.timeoutMs?.value || '250'),
      max_bytes: esc(ui.maxBytes?.value || '512'),
      clear_rx: ui.clearRx?.checked ? 'true' : 'false'
    };

    const ts = fmtTs(Date.now());
    logLine(`[${ts}] TX ${transport} ${device} :: ${payload}`, 'logLineTx');
    wsSend(msg);
  }

  ui.transport?.addEventListener('change', () => {
    populateDevicesAndPresets();
    setText(ui.presetHintVal, 'Transport changé, presets rechargés.');
  });

  ui.device?.addEventListener('change', updateSummary);

  ui.encoding?.addEventListener('change', updateSummary);

  ui.preset?.addEventListener('change', () => {
    const selectedValue = ui.preset.value || '';
    if (selectedValue && ui.payload) ui.payload.value = selectedValue;
    setText(ui.presetPreviewVal, selectedValue || '--');
    setText(ui.presetHintVal, selectedValue ? 'Preset chargé depuis la liste.' : 'Sélectionne un preset ou clique dans la bibliothèque de commandes.');
    updateSummary();
  });

  ui.presetSearch?.addEventListener('input', renderQuickPresets);

  $('sendBtn')?.addEventListener('click', sendCommand);
  $('sendBtnBottom')?.addEventListener('click', sendCommand);
  $('scanBtn')?.addEventListener('click', scanDevices);
  $('reloadHistoryBtn')?.addEventListener('click', loadHistory);
  $('clearLogBtn')?.addEventListener('click', () => { if (ui.log) ui.log.textContent = ''; });
  $('clearReplyBtn')?.addEventListener('click', () => setReplyBox(null));
  $('clearPayloadBtn')?.addEventListener('click', () => {
    if (ui.payload) ui.payload.value = '';
    setText(ui.presetHintVal, 'Payload vidé manuellement.');
  });

  ui.payload?.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey && ev.key === 'Enter') {
      ev.preventDefault();
      sendCommand();
    }
  });

  loadConfig().then(loadHistory);
  connectWs();
})();
