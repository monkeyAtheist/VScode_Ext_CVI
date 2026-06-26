function qs(sel) { return document.querySelector(sel); }
function esc(s) {
  return (s ?? "").toString()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const els = {
  wsBadge: qs('#wsBadge'),
  listenBadge: qs('#listenBadge'),

  transportSel: qs('#transportSel'),
  deviceSel: qs('#deviceSel'),
  deviceSpec: qs('#deviceSpec'),
  rxModeSel: qs('#rxModeSel'),
  pollMs: qs('#pollMs'),
  maxBytes: qs('#maxBytes'),
  pollIntervalMs: qs('#pollIntervalMs'),
  pollTxPayload: qs('#pollTxPayload'),
  pollTxEncoding: qs('#pollTxEncoding'),

  autoReply: qs('#autoReply'),
  echoReply: qs('#echoReply'),
  replyNewline: qs('#replyNewline'),
  replyEncoding: qs('#replyEncoding'),
  replyPayload: qs('#replyPayload'),

  btnStart: qs('#btnStart'),
  btnStop: qs('#btnStop'),
  btnScan: qs('#btnScan'),

  stRunning: qs('#stRunning'),
  stPeer: qs('#stPeer'),
  stCount: qs('#stCount'),
  stError: qs('#stError'),

  logBox: qs('#logBox'),
  btnClear: qs('#btnClear'),
  btnScroll: qs('#btnScroll'),
};

let scanCache = null;
let autoScroll = true;
let ws = null;

function setBadge(el, on, text) {
  el.textContent = text;
  el.classList.toggle('badge-on', !!on);
  el.classList.toggle('badge-off', !on);
}

function appendLog(ev) {
  const line = document.createElement('div');
  line.className = 'logLine';
  if (ev.dir === 'rx') line.classList.add('logLineRx');
  if (ev.dir === 'tx') line.classList.add('logLineTx');
  if (ev.dir === 'err') line.classList.add('logLineErr');

  const t = new Date();
  const stamp = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`;

  line.innerHTML = `<strong>[${stamp}] ${esc(ev.transport)} ${esc(ev.dir)}</strong><br>`
                 + `<small>${esc(ev.device)} • ${esc(ev.encoding)}</small><br>`
                 + `<code>${esc(ev.data)}</code>`;

  els.logBox.appendChild(line);
  if (autoScroll) {
    els.logBox.scrollTop = els.logBox.scrollHeight;
  }
}

async function apiGet(path) {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return await r.json();
}

async function apiPostForm(path, obj) {
  const form = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => form.set(k, String(v ?? '')));
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const txt = await r.text();
  let js = null;
  try { js = JSON.parse(txt); } catch { }
  if (!r.ok) {
    const msg = js?.error || txt || `${path} -> HTTP ${r.status}`;
    throw new Error(msg);
  }
  return js || { ok: true };
}

function currentTransportKey() {
  return els.transportSel.value;
}

function refreshDeviceDropdown() {
  const key = currentTransportKey();
  const list = (scanCache && scanCache[key] && scanCache[key].devices) ? scanCache[key].devices : [];

  els.deviceSel.innerHTML = '';
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = list.length ? '(select)' : '(no devices)';
  els.deviceSel.appendChild(opt0);

  list.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.spec;
    opt.textContent = d.name;
    els.deviceSel.appendChild(opt);
  });
}

function updateFieldVisibility() {
  const t = currentTransportKey();
  const masterPoll = (t === 'i2c' || t === 'spi');
  els.pollIntervalMs.closest('label').style.display = masterPoll ? '' : 'none';
  els.pollTxPayload.closest('label').style.display = masterPoll ? '' : 'none';
  els.pollTxEncoding.closest('label').style.display = masterPoll ? '' : 'none';
  els.autoReply.closest('.row').style.display = masterPoll ? 'none' : '';
  els.replyEncoding.closest('label').style.display = masterPoll ? 'none' : '';
  els.replyPayload.closest('label').style.display = masterPoll ? 'none' : '';
  if (masterPoll) {
    els.rxModeSel.value = 'bytes';
  }
}

async function doScan() {
  scanCache = await apiGet('/api/comms_listen_scan');
  refreshDeviceDropdown();
}

function buildStartPayload() {
  const device = (els.deviceSpec.value || els.deviceSel.value || '').trim();
  return {
    transport: els.transportSel.value,
    device,
    rx_mode: els.rxModeSel.value,
    poll_ms: els.pollMs.value,
    max_bytes: els.maxBytes.value,
    auto_reply: els.autoReply.checked ? 1 : 0,
    echo_reply: els.echoReply.checked ? 1 : 0,
    reply_payload: els.replyPayload.value,
    reply_encoding: els.replyEncoding.value,
    reply_append_nl: els.replyNewline.checked ? 1 : 0,
    poll_tx_payload: els.pollTxPayload.value,
    poll_tx_encoding: els.pollTxEncoding.value,
    poll_interval_ms: els.pollIntervalMs.value,
  };
}

async function startListen() {
  const p = buildStartPayload();
  if (!p.device) throw new Error('Device spec vide');
  await apiPostForm('/api/comms_listen_start', p);
}

async function stopListen() {
  await apiPostForm('/api/comms_listen_stop', { });
}

async function updateStatus() {
  try {
    const st = await apiGet('/api/comms_listen_status');
    setBadge(els.listenBadge, st.running, st.running ? 'LISTEN ON' : 'LISTEN OFF');

    els.stRunning.textContent = st.running ? 'ON' : 'OFF';
    els.stPeer.textContent = st.connected ? (st.peer || 'connected') : '--';
    els.stCount.textContent = `${st.rx_count ?? 0} / ${st.tx_count ?? 0}`;
    els.stError.textContent = `error: ${st.error || '--'}`;

  } catch (e) {
    // ignore
  }
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws`;
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    setBadge(els.wsBadge, true, 'WS connected');
  });

  ws.addEventListener('close', () => {
    setBadge(els.wsBadge, false, 'WS disconnected');
    setTimeout(connectWs, 1000);
  });

  ws.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'comms_event' && msg.payload) {
        appendLog(msg.payload);
      }
    } catch (_) {
      // ignore malformed frames
    }
  });
}

els.transportSel.addEventListener('change', () => {
  refreshDeviceDropdown();
  updateFieldVisibility();
});
els.deviceSel.addEventListener('change', () => {
  if (els.deviceSel.value) els.deviceSpec.value = els.deviceSel.value;
});
els.btnScan.addEventListener('click', async () => {
  try {
    await doScan();
    appendLog({ dir:'info', transport:'ui', device:'scan', encoding:'ascii', data:'scan done' });
  } catch (e) {
    appendLog({ dir:'err', transport:'ui', device:'scan', encoding:'ascii', data:e.message });
  }
});

els.btnStart.addEventListener('click', async () => {
  try {
    await startListen();
    appendLog({ dir:'info', transport:'ui', device:'start', encoding:'ascii', data:'listen started' });
  } catch (e) {
    appendLog({ dir:'err', transport:'ui', device:'start', encoding:'ascii', data:e.message });
  }
});

els.btnStop.addEventListener('click', async () => {
  try {
    await stopListen();
    appendLog({ dir:'info', transport:'ui', device:'stop', encoding:'ascii', data:'listen stopped' });
  } catch (e) {
    appendLog({ dir:'err', transport:'ui', device:'stop', encoding:'ascii', data:e.message });
  }
});

els.btnClear.addEventListener('click', () => {
  els.logBox.innerHTML = '';
});

els.btnScroll.addEventListener('click', () => {
  autoScroll = !autoScroll;
  els.btnScroll.textContent = `Auto-scroll: ${autoScroll ? 'ON' : 'OFF'}`;
});

(async () => {
  setBadge(els.wsBadge, false, 'WS disconnected');
  setBadge(els.listenBadge, false, 'LISTEN --');

  connectWs();
  try { await doScan(); } catch {}
  updateFieldVisibility();
  setInterval(updateStatus, 600);
  updateStatus();
})();
