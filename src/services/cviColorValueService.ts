import * as vscode from 'vscode';

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

type ColorFormat =
  | 'hex-css'
  | 'hex-0x'
  | 'decimal-rgb-int'
  | 'rgb-function'
  | 'rgba-function'
  | 'c-rgb-list'
  | 'c-rgba-list'
  | 'c-rgb-brace'
  | 'c-rgba-brace'
  | 'cvi-make-color'
  | 'vba-rgb';

interface ColorFormatDefinition {
  value: ColorFormat;
  label: string;
  description: string;
}

export class CviColorValueService {
  async openColorValuePicker(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('Open a C/CVI editor before inserting a color value.');
      return;
    }

    const selectedText = editor.document.getText(editor.selection).trim();
    const initialHex = /^#?[0-9A-Fa-f]{6}$/.test(selectedText) || /^0x[0-9A-Fa-f]{6}$/.test(selectedText)
      ? normalizeColorHexInput(selectedText)
      : '#000000';

    const initialFormat = inferInitialFormat(selectedText);
    const panel = vscode.window.createWebviewPanel(
      'cviColorValuePicker',
      'CVI: Insert color value',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    panel.webview.html = buildColorValuePickerHtml(initialHex, initialFormat, 255);
    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== 'object') {
        return;
      }
      const payload = message as { type?: unknown; text?: unknown };
      if (payload.type === 'cancel') {
        panel.dispose();
        return;
      }
      if (payload.type === 'copyColor' && typeof payload.text === 'string') {
        await vscode.env.clipboard.writeText(payload.text);
        vscode.window.showInformationMessage('Copied color value to clipboard.');
        return;
      }
      if (payload.type === 'insertColor' && typeof payload.text === 'string') {
        const activeEditor = vscode.window.activeTextEditor || editor;
        await insertTextAtEditorSelections(activeEditor, payload.text);
        panel.dispose();
      }
    });
  }
}

async function insertTextAtEditorSelections(editor: vscode.TextEditor, text: string): Promise<void> {
  const selections = editor.selections.length > 0 ? editor.selections : [editor.selection];
  await editor.edit((edit) => {
    for (const selection of selections) {
      if (selection.isEmpty) {
        edit.insert(selection.active, text);
      } else {
        edit.replace(selection, text);
      }
    }
  });
}

function inferInitialFormat(selectedText: string): ColorFormat {
  const value = selectedText.trim();
  if (/^0x[0-9A-Fa-f]{6}$/.test(value)) {
    return 'hex-0x';
  }
  if (/^rgba\s*\(/i.test(value)) {
    return 'rgba-function';
  }
  if (/^rgb\s*\(/i.test(value)) {
    return 'rgb-function';
  }
  if (/^MakeColor\s*\(/i.test(value)) {
    return 'cvi-make-color';
  }
  if (/^RGB\s*\(/.test(value)) {
    return 'vba-rgb';
  }
  return 'hex-css';
}

function clampColorByte(value: unknown): number {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(255, numeric));
}

function normalizeColorHexInput(value: unknown): string {
  const trimmed = String(value ?? '').trim();
  const cleaned = trimmed.replace(/^#/, '').replace(/^0x/i, '');
  if (/^[0-9A-Fa-f]{6}$/.test(cleaned)) {
    return `#${cleaned.toUpperCase()}`;
  }
  return '#000000';
}

function rgbFromHex(hex: string): RgbColor {
  const normalized = normalizeColorHexInput(hex).slice(1);
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16)
  };
}

function buildColorValuePickerHtml(initialHex: string, initialFormat: ColorFormat, initialAlpha: number): string {
  const safeInitialHex = normalizeColorHexInput(initialHex);
  const safeInitialFormat = String(initialFormat || 'hex-css');
  const safeInitialAlpha = clampColorByte(initialAlpha);
  const formats: ColorFormatDefinition[] = [
    { value: 'hex-css', label: '#RRGGBB', description: 'CSS / HTML / generic hexadecimal value' },
    { value: 'hex-0x', label: '0xRRGGBB', description: 'C/CVI hexadecimal integer notation' },
    { value: 'decimal-rgb-int', label: 'Decimal RGB integer', description: '24-bit RGB decimal value: R*65536 + G*256 + B' },
    { value: 'rgb-function', label: 'rgb(r, g, b)', description: 'CSS-style RGB function' },
    { value: 'rgba-function', label: 'rgba(r, g, b, a)', description: 'CSS-style RGBA function with alpha normalized to 0..1' },
    { value: 'c-rgb-list', label: 'r, g, b', description: 'Decimal channel list for C/CVI function arguments' },
    { value: 'c-rgba-list', label: 'r, g, b, a', description: 'Decimal channel list with alpha' },
    { value: 'c-rgb-brace', label: '{ r, g, b }', description: 'C initializer-style RGB list' },
    { value: 'c-rgba-brace', label: '{ r, g, b, a }', description: 'C initializer-style RGBA list' },
    { value: 'cvi-make-color', label: 'MakeColor(r, g, b)', description: 'LabWindows/CVI MakeColor helper-style value' },
    { value: 'vba-rgb', label: 'RGB(r, g, b)', description: 'RGB macro/helper style value, useful for Win32/VBA-like APIs' }
  ];  const optionHtml = formats.map((entry) => `<option value="${escapeHtml(entry.value)}" title="${escapeHtml(entry.description)}"${entry.value === safeInitialFormat ? ' selected' : ''}>${escapeHtml(entry.label)}</option>`).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root { color-scheme: light dark; }
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 18px; }
    .shell { max-width: 980px; margin: 0 auto; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 16px; margin-bottom: 14px; background: var(--vscode-sideBar-background, transparent); }
    h1, h2 { margin-top: 0; }
    .muted { opacity: 0.76; }
    .picker-layout { display: grid; grid-template-columns: minmax(220px, 360px) 68px 1fr; gap: 16px; align-items: stretch; }
    .native-color { height: 74px; padding: 2px; cursor: pointer; border-radius: 8px; }
    .alpha-preview { position: relative; height: 64px; border-radius: 8px; border: 1px solid var(--vscode-panel-border); overflow: hidden; background-color: #fff; background-image: linear-gradient(45deg, #b8b8b8 25%, transparent 25%), linear-gradient(-45deg, #b8b8b8 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #b8b8b8 75%), linear-gradient(-45deg, transparent 75%, #b8b8b8 75%); background-size: 18px 18px; background-position: 0 0, 0 9px, 9px -9px, -9px 0px; }
    .alpha-overlay { position: absolute; inset: 0; }
    .brightness-panel { display: grid; grid-template-rows: auto 1fr auto; gap: 8px; justify-items: center; min-height: 236px; }
    .brightness-label { font-weight: 600; font-size: 12px; text-align: center; }
    .brightness-track { position: relative; width: 44px; min-height: 172px; border-radius: 999px; border: 1px solid var(--vscode-panel-border); background: linear-gradient(to top, #000000, var(--cvi-current-color, #FFFFFF)); display: flex; align-items: center; justify-content: center; padding: 8px 0; }
    #brightness { width: 172px; height: 34px; transform: rotate(-90deg); accent-color: var(--vscode-button-background); }
    #brightnessValue { width: 56px; text-align: center; font-family: var(--vscode-editor-font-family); }
    input, select, textarea { box-sizing: border-box; width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 6px; padding: 7px 9px; font-family: var(--vscode-editor-font-family); }
    input[type="number"] { text-align: right; }
    textarea { min-height: 72px; resize: vertical; font-size: 14px; }
    label { display: block; font-weight: 600; margin-bottom: 6px; }
    .row { display: grid; grid-template-columns: 1fr 90px; gap: 10px; align-items: center; margin-bottom: 10px; }
    .channels { display: grid; grid-template-columns: repeat(4, minmax(70px, 1fr)); gap: 10px; }
    .alpha-row { display: grid; grid-template-columns: 90px 1fr; gap: 10px; align-items: end; margin: 10px 0; }
    input[type="range"] { padding: 0; }
    .btn-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; justify-content: flex-end; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 6px; padding: 8px 14px; cursor: pointer; }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .swatches { display: flex; flex-wrap: wrap; gap: 8px; }
    .swatch { width: 28px; height: 28px; border-radius: 50%; border: 1px solid var(--vscode-panel-border); cursor: pointer; }
    @media (max-width: 840px) { .picker-layout { grid-template-columns: 1fr; } .brightness-panel { grid-template-columns: 1fr; min-height: auto; } .brightness-track { width: 100%; min-height: auto; height: 40px; background: linear-gradient(to right, #000000, var(--cvi-current-color, #FFFFFF)); } #brightness { width: 100%; height: auto; transform: none; } .channels { grid-template-columns: 1fr 1fr; } }
  </style>
</head>
<body>
  <div class="shell">
    <div class="card">
      <h1>Insert color value</h1>
      <p class="muted">Choose a color and insert it at the active cursor or replace the current selection. The brightness slider adjusts the selected hue/saturation, and the alpha preview shows transparency over a checkerboard background.</p>
    </div>
    <div class="card picker-layout">
      <div>
        <label for="color">Color picker</label>
        <input id="color" class="native-color" type="color" value="${escapeHtml(safeInitialHex)}" />
      </div>
      <div class="brightness-panel">
        <div class="brightness-label">Brightness</div>
        <div id="brightnessTrack" class="brightness-track"><input id="brightness" type="range" min="0" max="100" value="100" /></div>
        <input id="brightnessValue" type="number" min="0" max="100" value="100" title="Brightness / value, 0 to 100%" />
      </div>
      <div>
        <div class="row"><div><label for="hex">Hex value</label><input id="hex" value="${escapeHtml(safeInitialHex)}" spellcheck="false" /></div><div><label for="alpha">Alpha</label><input id="alpha" type="number" min="0" max="255" value="${safeInitialAlpha}" /></div></div>
        <div class="alpha-row"><div><label for="alphaRange">Alpha</label><input id="alphaRange" type="range" min="0" max="255" value="${safeInitialAlpha}" /></div><div><label>Alpha preview</label><div id="alphaPreview" class="alpha-preview"><div id="alphaOverlay" class="alpha-overlay"></div></div></div></div>
        <div class="channels">
          <div><label for="red">R</label><input id="red" type="number" min="0" max="255" /></div>
          <div><label for="green">G</label><input id="green" type="number" min="0" max="255" /></div>
          <div><label for="blue">B</label><input id="blue" type="number" min="0" max="255" /></div>
          <div><label for="format">Format</label><select id="format">${optionHtml}</select></div>
        </div>
        <label for="output" style="margin-top: 14px;">Value to insert</label>
        <textarea id="output" spellcheck="false"></textarea>
        <div class="btn-row">
          <button id="copyBtn" class="secondary">Copy</button>
          <button id="cancelBtn" class="secondary">Cancel</button>
          <button id="insertBtn">Insert</button>
        </div>
      </div>
    </div>
    <div class="card">
      <h2>Presets</h2>
      <div class="swatches" id="swatches"></div>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const color = document.getElementById('color');
    const hex = document.getElementById('hex');
    const red = document.getElementById('red');
    const green = document.getElementById('green');
    const blue = document.getElementById('blue');
    const alpha = document.getElementById('alpha');
    const alphaRange = document.getElementById('alphaRange');
    const brightness = document.getElementById('brightness');
    const brightnessValue = document.getElementById('brightnessValue');
    const format = document.getElementById('format');
    const output = document.getElementById('output');
    const alphaOverlay = document.getElementById('alphaOverlay');
    const brightnessTrack = document.getElementById('brightnessTrack');
    const swatches = document.getElementById('swatches');
    const presets = ['#000000','#FFFFFF','#FF0000','#00FF00','#0000FF','#FFFF00','#FF00FF','#00FFFF','#808080','#C0C0C0','#800000','#008000','#000080','#FFA500','#663399','#2E8B57','#1E90FF','#DC143C'];
    let hsvState = { h: 0, s: 0, v: 0 };
    function clampByte(value) { const n = Number.parseInt(String(value || '0'), 10); return Number.isFinite(n) ? Math.max(0, Math.min(255, n)) : 0; }
    function clampPercent(value) { const n = Number.parseFloat(String(value || '0')); return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0; }
    function hexByte(value) { return clampByte(value).toString(16).toUpperCase().padStart(2, '0'); }
    function normalizeHex(value) {
      const raw = String(value || '').trim().replace(/^#/, '').replace(/^0x/i, '');
      return /^[0-9A-Fa-f]{6}$/.test(raw) ? ('#' + raw.toUpperCase()) : color.value.toUpperCase();
    }
    function rgbFromHexValue(hx) {
      const clean = normalizeHex(hx).slice(1);
      return { r: Number.parseInt(clean.slice(0,2), 16), g: Number.parseInt(clean.slice(2,4), 16), b: Number.parseInt(clean.slice(4,6), 16) };
    }
    function rgbToHsv(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r, g, b); const min = Math.min(r, g, b); const delta = max - min;
      let h = hsvState.h || 0;
      if (delta !== 0) {
        if (max === r) h = ((g - b) / delta) % 6;
        else if (max === g) h = (b - r) / delta + 2;
        else h = (r - g) / delta + 4;
        h *= 60;
        if (h < 0) h += 360;
      }
      const s = max === 0 ? 0 : delta / max;
      return { h, s, v: max };
    }
    function hsvToRgb(h, s, v) {
      const c = v * s;
      const x = c * (1 - Math.abs((h / 60) % 2 - 1));
      const m = v - c;
      let r1 = 0, g1 = 0, b1 = 0;
      if (h < 60) { r1 = c; g1 = x; }
      else if (h < 120) { r1 = x; g1 = c; }
      else if (h < 180) { g1 = c; b1 = x; }
      else if (h < 240) { g1 = x; b1 = c; }
      else if (h < 300) { r1 = x; b1 = c; }
      else { r1 = c; b1 = x; }
      return { r: Math.round((r1 + m) * 255), g: Math.round((g1 + m) * 255), b: Math.round((b1 + m) * 255) };
    }
    function hexFromRgb(r, g, b) { return '#' + hexByte(r) + hexByte(g) + hexByte(b); }
    function hexFromChannels() { return hexFromRgb(red.value, green.value, blue.value); }
    function fullBrightnessHex() {
      const rgb = hsvToRgb(hsvState.h || 0, hsvState.s || 0, 1);
      return hexFromRgb(rgb.r, rgb.g, rgb.b);
    }
    function formatValue(fmt, hx, a) {
      const rgb = rgbFromHexValue(hx); const r = rgb.r; const g = rgb.g; const b = rgb.b; const av = clampByte(a);
      const bare = normalizeHex(hx).slice(1); const decimal = (r << 16) + (g << 8) + b;
      const alphaNormalized = (av / 255).toFixed(3).replace(/0+$/,'').replace(/\.$/,'');
      if (fmt === 'hex-0x') return '0x' + bare;
      if (fmt === 'decimal-rgb-int') return String(decimal);
      if (fmt === 'rgb-function') return 'rgb(' + r + ', ' + g + ', ' + b + ')';
      if (fmt === 'rgba-function') return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alphaNormalized + ')';
      if (fmt === 'c-rgb-list') return r + ', ' + g + ', ' + b;
      if (fmt === 'c-rgba-list') return r + ', ' + g + ', ' + b + ', ' + av;
      if (fmt === 'c-rgb-brace') return '{ ' + r + ', ' + g + ', ' + b + ' }';
      if (fmt === 'c-rgba-brace') return '{ ' + r + ', ' + g + ', ' + b + ', ' + av + ' }';
      if (fmt === 'cvi-make-color') return 'MakeColor(' + r + ', ' + g + ', ' + b + ')';
      if (fmt === 'vba-rgb') return 'RGB(' + r + ', ' + g + ', ' + b + ')';
      return normalizeHex(hx);
    }
    function renderAll() {
      const hx = normalizeHex(color.value);
      const rgb = rgbFromHexValue(hx);
      const a = clampByte(alpha.value);
      hex.value = hx;
      color.value = hx;
      red.value = String(rgb.r);
      green.value = String(rgb.g);
      blue.value = String(rgb.b);
      alpha.value = String(a);
      alphaRange.value = String(a);
      brightness.value = String(Math.round((hsvState.v || 0) * 100));
      brightnessValue.value = brightness.value;
      const rgba = 'rgba(' + rgb.r + ', ' + rgb.g + ', ' + rgb.b + ', ' + (a / 255) + ')';
      alphaOverlay.style.background = rgba;
      brightnessTrack.style.setProperty('--cvi-current-color', fullBrightnessHex());
      output.value = formatValue(format.value, hx, a);
    }
    function setColorFromHex(value, updateHsv) {
      const hx = normalizeHex(value);
      color.value = hx;
      if (updateHsv) {
        const rgb = rgbFromHexValue(hx);
        hsvState = rgbToHsv(rgb.r, rgb.g, rgb.b);
      }
      renderAll();
    }
    function setColorFromBrightness(value) {
      hsvState.v = clampPercent(value) / 100;
      const rgb = hsvToRgb(hsvState.h || 0, hsvState.s || 0, hsvState.v || 0);
      setColorFromHex(hexFromRgb(rgb.r, rgb.g, rgb.b), false);
    }
    color.addEventListener('input', () => setColorFromHex(color.value, true));
    hex.addEventListener('input', () => setColorFromHex(hex.value, true));
    red.addEventListener('input', () => setColorFromHex(hexFromChannels(), true));
    green.addEventListener('input', () => setColorFromHex(hexFromChannels(), true));
    blue.addEventListener('input', () => setColorFromHex(hexFromChannels(), true));
    alpha.addEventListener('input', renderAll);
    alphaRange.addEventListener('input', () => { alpha.value = alphaRange.value; renderAll(); });
    brightness.addEventListener('input', () => setColorFromBrightness(brightness.value));
    brightnessValue.addEventListener('input', () => setColorFromBrightness(brightnessValue.value));
    format.addEventListener('change', renderAll);
    document.getElementById('insertBtn').addEventListener('click', () => vscode.postMessage({ type: 'insertColor', text: output.value }));
    document.getElementById('copyBtn').addEventListener('click', async () => { try { await navigator.clipboard.writeText(output.value); } catch {} vscode.postMessage({ type: 'copyColor', text: output.value }); });
    document.getElementById('cancelBtn').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
    swatches.innerHTML = presets.map((preset) => '<button type="button" class="swatch" title="' + preset + '" data-color="' + preset + '" style="background:' + preset + '"></button>').join('');
    swatches.querySelectorAll('.swatch').forEach((button) => button.addEventListener('click', () => setColorFromHex(button.getAttribute('data-color'), true)));
    setColorFromHex('${escapeJavaScriptString(safeInitialHex)}', true);
  </script>
</body>
</html>`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeJavaScriptString(value: unknown): string {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/</g, '\\x3C');
}

export function formatColorValueForTest(format: ColorFormat, hex: string, alphaValue = 255): string {
  const normalized = normalizeColorHexInput(hex);
  const { r, g, b } = rgbFromHex(normalized);
  const a = clampColorByte(alphaValue);
  const bareHex = normalized.slice(1);
  const decimal = (r << 16) + (g << 8) + b;
  switch (format) {
    case 'hex-0x': return `0x${bareHex}`;
    case 'decimal-rgb-int': return String(decimal);
    case 'rgb-function': return `rgb(${r}, ${g}, ${b})`;
    case 'rgba-function': return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3).replace(/0+$/,'').replace(/\.$/,'')})`;
    case 'c-rgb-list': return `${r}, ${g}, ${b}`;
    case 'c-rgba-list': return `${r}, ${g}, ${b}, ${a}`;
    case 'c-rgb-brace': return `{ ${r}, ${g}, ${b} }`;
    case 'c-rgba-brace': return `{ ${r}, ${g}, ${b}, ${a} }`;
    case 'cvi-make-color': return `MakeColor(${r}, ${g}, ${b})`;
    case 'vba-rgb': return `RGB(${r}, ${g}, ${b})`;
    case 'hex-css':
    default: return normalized;
  }
}
