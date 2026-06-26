(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    cfgBadge: $('cfgBadge'), log: $('log'), replyBox: $('replyBox'),
    i2cBus: $('i2cBus'), i2cFound: $('i2cFound'), i2cSpec: $('i2cSpec'), i2cReg: $('i2cReg'), i2cReadSize: $('i2cReadSize'), i2cWritePayload: $('i2cWritePayload'), i2cEncoding: $('i2cEncoding'), i2cScanStart: $('i2cScanStart'), i2cScanEnd: $('i2cScanEnd'),
    spiDev: $('spiDev'), spiSpec: $('spiSpec'), spiReg: $('spiReg'), spiRegWidth: $('spiRegWidth'), spiReadSize: $('spiReadSize'), spiWritePayload: $('spiWritePayload'), spiEncoding: $('spiEncoding'),
    rawTransport: $('rawTransport'), rawSpec: $('rawSpec'), rawPayload: $('rawPayload'), rawEncoding: $('rawEncoding'), rawTimeout: $('rawTimeout'), rawMaxBytes: $('rawMaxBytes')
  };
  let cfg = null;

  function esc(s){ return (s ?? '').toString().replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }
  function logLine(kind,msg){ const d=document.createElement('div'); d.className='logLine'; if(kind==='rx') d.classList.add('logLineRx'); if(kind==='tx') d.classList.add('logLineTx'); if(kind==='err') d.classList.add('logLineErr'); const t=new Date(); const h=`${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`; d.innerHTML=`<strong>[${h}] ${esc(kind.toUpperCase())}</strong><br><code>${esc(msg)}</code>`; els.log.appendChild(d); els.log.scrollTop=els.log.scrollHeight; }
  function formPost(path, obj){ const fd = new URLSearchParams(); Object.entries(obj).forEach(([k,v]) => fd.set(k, String(v ?? ''))); return fetch(path,{method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:fd.toString()}); }
  async function getJson(url){ const r=await fetch(url,{cache:'no-store'}); const txt=await r.text(); let js={}; try{ js=JSON.parse(txt);}catch{ throw new Error(txt || ('HTTP '+r.status)); } if(!r.ok || js.ok===false) throw new Error(js.error || ('HTTP '+r.status)); return js; }
  async function postJson(url,obj){ const r=await formPost(url,obj); const txt=await r.text(); let js={}; try{ js=JSON.parse(txt);}catch{ throw new Error(txt || ('HTTP '+r.status)); } if(!r.ok || js.ok===false) throw new Error(js.error || ('HTTP '+r.status)); return js; }

  function uniqBy(arr, keyFn){ const m=new Map(); for(const it of arr||[]){ const k=keyFn(it); if(!m.has(k)) m.set(k,it);} return [...m.values()]; }
  function extractI2cBus(spec){ const i=String(spec||'').indexOf('@'); return i>=0 ? String(spec).slice(0,i) : String(spec||''); }
  function populate(){
    if(!cfg) return;
    const i2c = uniqBy((cfg.i2c?.devices)||[], d => extractI2cBus(d.spec));
    els.i2cBus.innerHTML='';
    for(const d of i2c){ const o=document.createElement('option'); o.value=extractI2cBus(d.spec); o.textContent=`${d.name} (${d.spec})`; els.i2cBus.appendChild(o); }
    if(!els.i2cBus.value) { const o=document.createElement('option'); o.value='/dev/i2c-1'; o.textContent='/dev/i2c-1'; els.i2cBus.appendChild(o); els.i2cBus.value='/dev/i2c-1'; }
    els.i2cSpec.value = `${els.i2cBus.value}@0x42`;

    const spi = (cfg.spi?.devices)||[];
    els.spiDev.innerHTML='';
    for(const d of spi){ const o=document.createElement('option'); o.value=d.spec; o.textContent=`${d.name} (${d.spec})`; els.spiDev.appendChild(o); }
    if(!els.spiDev.value){ const o=document.createElement('option'); o.value='/dev/spidev0.0@1000000#0+8'; o.textContent='/dev/spidev0.0@1000000#0+8'; els.spiDev.appendChild(o); els.spiDev.value=o.value; }
    els.spiSpec.value = els.spiDev.value;
    els.rawSpec.value = els.i2cSpec.value;
    els.cfgBadge.textContent='Config: OK';
  }

  async function loadCfg(){ try { cfg = await getJson('/api/comms_config'); populate(); } catch(e){ els.cfgBadge.textContent='Config: ERROR'; logLine('err', e.message); } }
  async function loadHistory(){ try{ const j = await getJson('/api/comms_history?limit=120'); logLine('info','--- history reload ---'); for(const it of (j.items||[])){ if(it.transport !== 'i2c' && it.transport !== 'spi') continue; logLine(it.dir||'info', `${it.transport} ${it.device} :: ${it.data||''}`); } }catch(e){ logLine('err', e.message); } }

  $('clearLogBtn').onclick = ()=> els.log.innerHTML='';
  $('reloadHistoryBtn').onclick = loadHistory;
  $('btnI2cScan').onclick = async ()=> {
    try{
      const dev=els.i2cBus.value||'/dev/i2c-1';
      const j=await getJson(`/api/bus_i2c_scan?device=${encodeURIComponent(dev)}&start=${encodeURIComponent(els.i2cScanStart.value)}&end=${encodeURIComponent(els.i2cScanEnd.value)}`);
      els.i2cFound.innerHTML='';
      for(const a of (j.addresses||[])){ const o=document.createElement('option'); o.value=a.hex; o.textContent=`${a.hex} (${a.addr})`; els.i2cFound.appendChild(o); }
      logLine('info', `I2C scan ${dev}: ${(j.addresses||[]).map(x=>x.hex).join(', ') || 'none'}`);
    } catch(e){ logLine('err', e.message); }
  };
  $('btnI2cUseFound').onclick = ()=> { const addr=els.i2cFound.value || '0x42'; els.i2cSpec.value = `${els.i2cBus.value || '/dev/i2c-1'}@${addr}`; };
  $('btnI2cRead').onclick = async ()=> {
    try{ const j = await postJson('/api/bus_i2c_reg_read',{device_spec:els.i2cSpec.value, reg:els.i2cReg.value, size:els.i2cReadSize.value}); els.replyBox.value = `HEX: ${j.hex}\nASCII: ${j.ascii||''}`; logLine('rx', `I2C READ ${els.i2cSpec.value} reg=${els.i2cReg.value} -> ${j.hex}`);}catch(e){ logLine('err', e.message);} };
  $('btnI2cWrite').onclick = async ()=> {
    try{ await postJson('/api/bus_i2c_reg_write',{device_spec:els.i2cSpec.value, reg:els.i2cReg.value, payload:els.i2cWritePayload.value, encoding:els.i2cEncoding.value}); logLine('tx', `I2C WRITE ${els.i2cSpec.value} reg=${els.i2cReg.value} payload=${els.i2cWritePayload.value}`);}catch(e){ logLine('err', e.message);} };

  els.i2cBus.onchange = ()=> { const currentAddr = (els.i2cSpec.value.split('@')[1] || '0x42'); els.i2cSpec.value = `${els.i2cBus.value}@${currentAddr}`; if(els.rawTransport.value==='i2c') els.rawSpec.value=els.i2cSpec.value; };
  els.spiDev.onchange = ()=> { els.spiSpec.value = els.spiDev.value; if(els.rawTransport.value==='spi') els.rawSpec.value=els.spiSpec.value; };

  $('btnSpiRead').onclick = async ()=> {
    try{ const j = await postJson('/api/bus_spi_reg_read',{device_spec:els.spiSpec.value, reg:els.spiReg.value, reg_width:els.spiRegWidth.value, size:els.spiReadSize.value}); els.replyBox.value = `HEX: ${j.hex}\nASCII: ${j.ascii||''}`; logLine('rx', `SPI READ ${els.spiSpec.value} reg=${els.spiReg.value} -> ${j.hex}`);}catch(e){ logLine('err', e.message);} };
  $('btnSpiWrite').onclick = async ()=> {
    try{ await postJson('/api/bus_spi_reg_write',{device_spec:els.spiSpec.value, reg:els.spiReg.value, reg_width:els.spiRegWidth.value, payload:els.spiWritePayload.value, encoding:els.spiEncoding.value}); logLine('tx', `SPI WRITE ${els.spiSpec.value} reg=${els.spiReg.value} payload=${els.spiWritePayload.value}`);}catch(e){ logLine('err', e.message);} };

  els.rawTransport.onchange = ()=> { els.rawSpec.value = els.rawTransport.value==='spi' ? els.spiSpec.value : els.i2cSpec.value; };
  $('btnRawTransfer').onclick = async ()=> {
    try{ const j = await postJson('/api/bus_raw_transfer',{transport:els.rawTransport.value, device_spec:els.rawSpec.value, payload:els.rawPayload.value, encoding:els.rawEncoding.value, timeout_ms:els.rawTimeout.value, max_bytes:els.rawMaxBytes.value}); els.replyBox.value = `HEX: ${j.reply_hex||''}\nASCII: ${j.reply_ascii||''}`; logLine('tx', `${els.rawTransport.value.toUpperCase()} RAW ${els.rawSpec.value} :: ${els.rawPayload.value}`); if(j.reply_hex||j.reply_ascii) logLine('rx', `${els.rawTransport.value.toUpperCase()} RAW reply :: ${j.reply_hex||j.reply_ascii}`); } catch(e){ logLine('err', e.message); }
  };

  loadCfg().then(loadHistory);
})();
