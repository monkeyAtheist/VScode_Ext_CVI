function qs(sel) { return document.querySelector(sel); }
function esc(s) {
  return (s ?? '').toString().replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

const PIN_MAP = [
  { bcm: 2, phys: 3,  label: 'GPIO2 / BCM2 / Pin 3 (SDA)' },
  { bcm: 3, phys: 5,  label: 'GPIO3 / BCM3 / Pin 5 (SCL)' },
  { bcm: 4, phys: 7,  label: 'GPIO4 / BCM4 / Pin 7' },
  { bcm: 17, phys: 11, label: 'GPIO17 / BCM17 / Pin 11' },
  { bcm: 27, phys: 13, label: 'GPIO27 / BCM27 / Pin 13' },
  { bcm: 22, phys: 15, label: 'GPIO22 / BCM22 / Pin 15' },
  { bcm: 10, phys: 19, label: 'GPIO10 / BCM10 / Pin 19 (MOSI)' },
  { bcm: 9,  phys: 21, label: 'GPIO9 / BCM9 / Pin 21 (MISO)' },
  { bcm: 11, phys: 23, label: 'GPIO11 / BCM11 / Pin 23 (SCLK)' },
  { bcm: 0,  phys: 27, label: 'GPIO0 / BCM0 / Pin 27 (ID_SD)' },
  { bcm: 5,  phys: 29, label: 'GPIO5 / BCM5 / Pin 29' },
  { bcm: 6,  phys: 31, label: 'GPIO6 / BCM6 / Pin 31' },
  { bcm: 13, phys: 33, label: 'GPIO13 / BCM13 / Pin 33 (PWM1)' },
  { bcm: 19, phys: 35, label: 'GPIO19 / BCM19 / Pin 35' },
  { bcm: 26, phys: 37, label: 'GPIO26 / BCM26 / Pin 37' },
  { bcm: 14, phys: 8,  label: 'GPIO14 / BCM14 / Pin 8 (TXD)' },
  { bcm: 15, phys: 10, label: 'GPIO15 / BCM15 / Pin 10 (RXD)' },
  { bcm: 18, phys: 12, label: 'GPIO18 / BCM18 / Pin 12 (PWM0)' },
  { bcm: 23, phys: 16, label: 'GPIO23 / BCM23 / Pin 16' },
  { bcm: 24, phys: 18, label: 'GPIO24 / BCM24 / Pin 18' },
  { bcm: 25, phys: 22, label: 'GPIO25 / BCM25 / Pin 22' },
  { bcm: 8,  phys: 24, label: 'GPIO8 / BCM8 / Pin 24 (CE0)' },
  { bcm: 7,  phys: 26, label: 'GPIO7 / BCM7 / Pin 26 (CE1)' },
  { bcm: 1,  phys: 28, label: 'GPIO1 / BCM1 / Pin 28 (ID_SC)' },
  { bcm: 12, phys: 32, label: 'GPIO12 / BCM12 / Pin 32 (PWM0)' },
  { bcm: 16, phys: 36, label: 'GPIO16 / BCM16 / Pin 36' },
  { bcm: 20, phys: 38, label: 'GPIO20 / BCM20 / Pin 38 (PCM_DIN)' },
  { bcm: 21, phys: 40, label: 'GPIO21 / BCM21 / Pin 40 (PCM_DOUT)' },
];

const els = {
  wsBadge: qs('#wsBadge'), backendBadge: qs('#backendBadge'),
  pinSel: qs('#pinSel'), modeSel: qs('#modeSel'),
  btnApplyMode: qs('#btnApplyMode'), btnRead: qs('#btnRead'), btnRefresh: qs('#btnRefresh'),
  btnHigh: qs('#btnHigh'), btnLow: qs('#btnLow'),
  pwmFreq: qs('#pwmFreq'), pwmDuty: qs('#pwmDuty'),
  btnPwmStart: qs('#btnPwmStart'), btnPwmUpdate: qs('#btnPwmUpdate'), btnPwmStop: qs('#btnPwmStop'),
  sampleHz: qs('#sampleHz'), btnSampleStart: qs('#btnSampleStart'), btnSampleStop: qs('#btnSampleStop'),
  stPin: qs('#stPin'), stValue: qs('#stValue'), stMode: qs('#stMode'), stPwm: qs('#stPwm'), stSampling: qs('#stSampling'), stLast: qs('#stLast'), stError: qs('#stError'),
  logBox: qs('#logBox'), btnClear: qs('#btnClear'), btnScroll: qs('#btnScroll'),
  anaPins: qs('#anaPins'), btnAnaStart: qs('#btnAnaStart'), btnAnaStop: qs('#btnAnaStop'), btnAnaClear: qs('#btnAnaClear'), canvas: qs('#anaCanvas'),
};

let ws = null;
let autoScroll = true;
let statusCache = { pins: [], backend: '--' };
const traces = new Map(); // bcm -> [{t,v}]
const colors = ['#4ade80','#60a5fa','#f472b6','#f59e0b','#a78bfa','#34d399'];

function appendLog(kind, msg) {
  const line = document.createElement('div');
  line.className = 'logLine';
  if (kind === 'sample') line.classList.add('logLineRx');
  if (kind === 'info') line.classList.add('logLineTx');
  if (kind === 'err') line.classList.add('logLineErr');
  const t = new Date();
  const stamp = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`;
  line.innerHTML = `<strong>[${stamp}] ${esc(kind)}</strong><br><code>${esc(msg)}</code>`;
  els.logBox.appendChild(line);
  if (autoScroll) els.logBox.scrollTop = els.logBox.scrollHeight;
}

function setBadge(on, text) {
  els.wsBadge.textContent = text;
  els.wsBadge.classList.toggle('badge-on', !!on);
  els.wsBadge.classList.toggle('badge-off', !on);
}

async function apiGet(path) {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return await r.json();
}
async function apiPost(path, obj) {
  const form = new URLSearchParams();
  Object.entries(obj).forEach(([k,v]) => form.set(k, String(v ?? '')));
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  const txt = await r.text();
  let js = null; try { js = JSON.parse(txt); } catch {}
  if (!r.ok || (js && js.ok === false)) throw new Error(js?.error || txt || `HTTP ${r.status}`);
  return js || { ok:true };
}

function currentPin() { return parseInt(els.pinSel.value || '17', 10); }
function selectedAnalyzerPins(){ return [...els.anaPins.querySelectorAll('input[type="checkbox"]:checked')].map(cb => parseInt(cb.value,10)); }

function fillPins() {
  if (!els.pinSel.options.length) {
    PIN_MAP.forEach(p => {
      const o = document.createElement('option');
      o.value = String(p.bcm);
      o.textContent = p.label;
      els.pinSel.appendChild(o);
    });
    els.pinSel.value = '17';
  }
  if (!els.anaPins.childElementCount) {
    PIN_MAP.forEach((p, idx) => {
      const lbl = document.createElement('label');
      lbl.className = 'badge';
      lbl.style.borderLeft = `4px solid ${colors[idx % colors.length]}`;
      lbl.innerHTML = `<input type="checkbox" value="${p.bcm}"> BCM${p.bcm} / pin ${p.phys}`;
      els.anaPins.appendChild(lbl);
      traces.set(p.bcm, []);
    });
  }
}

function updateCards() {
  const pin = currentPin();
  const st = (statusCache.pins || []).find(p => Number(p.pin) === pin) || null;
  const meta = PIN_MAP.find(p => p.bcm === pin);
  els.stPin.textContent = meta ? meta.label : `BCM ${pin}`;
  els.stValue.textContent = st ? String(st.value) : '--';
  els.stMode.textContent = st ? (st.mode || '--') : '--';
  els.stPwm.textContent = st ? (st.pwm_running ? `${st.pwm_freq_hz} Hz / ${st.pwm_duty_pct}%` : 'OFF') : '--';
  els.stSampling.textContent = st ? (st.sample_running ? `${st.sample_hz} Hz` : 'OFF') : '--';
  els.stLast.textContent = st && st.last_sample_ts_ms ? new Date(st.last_sample_ts_ms).toLocaleTimeString() : '--';
  els.stError.textContent = `error: ${st && st.error ? st.error : '--'}`;
  els.backendBadge.textContent = `Backend ${statusCache.backend || '--'}`;
}

async function refreshStatus() {
  try {
    statusCache = await apiGet('/api/gpio_status');
    updateCards();
  } catch {}
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.addEventListener('open', () => setBadge(true, 'WS connected'));
  ws.addEventListener('close', () => { setBadge(false, 'WS disconnected'); setTimeout(connectWs, 1000); });
  ws.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'gpio_event' && msg.payload) {
        const p = msg.payload;
        appendLog(p.kind || 'info', `BCM${p.pin} ${p.message} ${p.value >= 0 ? ('value=' + p.value) : ''}`);
        if ((p.kind || '') === 'sample' && typeof p.pin === 'number') {
          const arr = traces.get(p.pin) || [];
          arr.push({ t: Date.now(), v: Number(p.value || 0) ? 1 : 0 });
          while (arr.length > 0 && (Date.now() - arr[0].t) > 10000) arr.shift();
          traces.set(p.pin, arr);
          drawAnalyzer();
        }
        refreshStatus();
      }
    } catch {}
  });
}

function drawAnalyzer(){
  const c = els.canvas; if(!c) return; const ctx = c.getContext('2d');
  const w = c.width, h = c.height; const now = Date.now();
  ctx.clearRect(0,0,w,h); ctx.fillStyle='#08101f'; ctx.fillRect(0,0,w,h);
  ctx.strokeStyle='rgba(255,255,255,.12)'; ctx.lineWidth=1;
  for(let i=0;i<=10;i++){ const x = 50 + (w-70)*(i/10); ctx.beginPath(); ctx.moveTo(x,20); ctx.lineTo(x,h-20); ctx.stroke(); }
  const selected = selectedAnalyzerPins();
  const lanes = Math.max(1, selected.length);
  ctx.fillStyle='#cbd5e1'; ctx.font='12px sans-serif';
  selected.forEach((pin, idx) => {
    const top = 25 + idx * ((h-40)/lanes);
    const laneH = (h-50)/lanes;
    const yLow = top + laneH*0.72, yHigh = top + laneH*0.28;
    ctx.strokeStyle='rgba(255,255,255,.18)'; ctx.beginPath(); ctx.moveTo(45, yLow); ctx.lineTo(w-15, yLow); ctx.stroke();
    ctx.fillStyle='#e2e8f0'; ctx.fillText(`BCM${pin}`, 8, top + 14);
    const color = colors[idx % colors.length];
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    const arr = traces.get(pin) || [];
    if(arr.length){
      let started=false;
      for(let i=0;i<arr.length;i++){
        const pt = arr[i];
        const x = 50 + (w-70) * (1 - Math.max(0, Math.min(10000, now - pt.t))/10000);
        const y = pt.v ? yHigh : yLow;
        if(!started){ ctx.moveTo(x,y); started=true; }
        else { ctx.lineTo(x,y); }
        if(i+1 < arr.length){
          const nxt = arr[i+1];
          const nx = 50 + (w-70) * (1 - Math.max(0, Math.min(10000, now - nxt.t))/10000);
          ctx.lineTo(nx,y);
        }
      }
      ctx.stroke();
    }
  });
  ctx.fillStyle='#94a3b8';
  for(let i=0;i<=10;i++){ const x = 50 + (w-70)*(i/10); const sec = 10-i; ctx.fillText(`${sec}s`, x-8, h-5); }
}
setInterval(drawAnalyzer, 200);

els.pinSel?.addEventListener('change', updateCards);
els.btnRefresh.addEventListener('click', refreshStatus);
els.btnApplyMode.addEventListener('click', async () => {
  try { await apiPost('/api/gpio_mode', { pin: currentPin(), mode: els.modeSel.value }); appendLog('info', `BCM${currentPin()} mode=${els.modeSel.value}`); await refreshStatus(); } catch (e) { appendLog('err', e.message); }
});
els.btnRead.addEventListener('click', async () => {
  try { const r = await apiPost('/api/gpio_read', { pin: currentPin() }); appendLog('sample', `BCM${currentPin()} read=${r.value}`); const arr = traces.get(currentPin()) || []; arr.push({t:Date.now(), v:Number(r.value||0)?1:0}); traces.set(currentPin(), arr); drawAnalyzer(); await refreshStatus(); } catch (e) { appendLog('err', e.message); }
});
els.btnHigh.addEventListener('click', async () => { try { await apiPost('/api/gpio_write', { pin: currentPin(), value: 1 }); appendLog('info', `BCM${currentPin()} -> HIGH`); await refreshStatus(); } catch (e) { appendLog('err', e.message); } });
els.btnLow.addEventListener('click', async () => { try { await apiPost('/api/gpio_write', { pin: currentPin(), value: 0 }); appendLog('info', `BCM${currentPin()} -> LOW`); await refreshStatus(); } catch (e) { appendLog('err', e.message); } });
els.btnPwmStart.addEventListener('click', async () => { try { await apiPost('/api/gpio_pwm_start', { pin: currentPin(), freq_hz: els.pwmFreq.value, duty_pct: els.pwmDuty.value }); appendLog('info', `PWM start BCM${currentPin()} @ ${els.pwmFreq.value} Hz / ${els.pwmDuty.value}%`); await refreshStatus(); } catch (e) { appendLog('err', e.message); } });
els.btnPwmUpdate.addEventListener('click', async () => { try { await apiPost('/api/gpio_pwm_update', { pin: currentPin(), freq_hz: els.pwmFreq.value, duty_pct: els.pwmDuty.value }); appendLog('info', `PWM update BCM${currentPin()} @ ${els.pwmFreq.value} Hz / ${els.pwmDuty.value}%`); await refreshStatus(); } catch (e) { appendLog('err', e.message); } });
els.btnPwmStop.addEventListener('click', async () => { try { await apiPost('/api/gpio_pwm_stop', { pin: currentPin() }); appendLog('info', `PWM stop BCM${currentPin()}`); await refreshStatus(); } catch (e) { appendLog('err', e.message); } });
els.btnSampleStart.addEventListener('click', async () => { try { await apiPost('/api/gpio_sample_start', { pin: currentPin(), hz: els.sampleHz.value }); appendLog('info', `sampling start BCM${currentPin()} @ ${els.sampleHz.value} Hz`); await refreshStatus(); } catch (e) { appendLog('err', e.message); } });
els.btnSampleStop.addEventListener('click', async () => { try { await apiPost('/api/gpio_sample_stop', { pin: currentPin() }); appendLog('info', `sampling stop BCM${currentPin()}`); await refreshStatus(); } catch (e) { appendLog('err', e.message); } });
els.btnAnaStart.addEventListener('click', async () => {
  const pins = selectedAnalyzerPins();
  for(const p of pins){ try { await apiPost('/api/gpio_sample_start', { pin:p, hz: els.sampleHz.value }); appendLog('info', `analyzer sampling start BCM${p} @ ${els.sampleHz.value} Hz`); } catch(e){ appendLog('err', `BCM${p}: ${e.message}`); } }
  await refreshStatus();
});
els.btnAnaStop.addEventListener('click', async () => {
  const pins = selectedAnalyzerPins();
  for(const p of pins){ try { await apiPost('/api/gpio_sample_stop', { pin:p }); appendLog('info', `analyzer sampling stop BCM${p}`); } catch(e){ appendLog('err', `BCM${p}: ${e.message}`); } }
  await refreshStatus();
});
els.btnAnaClear.addEventListener('click', () => { traces.forEach((_,k)=>traces.set(k,[])); drawAnalyzer(); });
els.btnClear.addEventListener('click', () => { els.logBox.innerHTML = ''; });
els.btnScroll.addEventListener('click', () => { autoScroll = !autoScroll; els.btnScroll.textContent = `Auto-scroll: ${autoScroll ? 'ON' : 'OFF'}`; });

(async () => {
  fillPins();
  connectWs();
  await refreshStatus();
  drawAnalyzer();
})();
