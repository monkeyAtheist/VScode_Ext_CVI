import * as vscode from 'vscode';

async function insertTextAtEditorSelections(editor: vscode.TextEditor, text: string): Promise<void> {
  await editor.edit((editBuilder) => {
    for (const selection of editor.selections) {
      editBuilder.replace(selection, text);
    }
  });
}

function escapeHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

type CharacterValueMode = 'codepoint' | 'utf8' | 'utf16';

function codePointLabel(value: number): string {
    if (value === 0x20) return 'SPACE';
    if (value === 0x09) return 'TAB';
    if (value === 0x0A) return 'LF';
    if (value === 0x0D) return 'CR';
    if (value < 0x20 || value === 0x7F) return `CTRL ${value}`;
    try { return String.fromCodePoint(value); } catch { return '?'; }
}

function stringToNumericValues(value: string, mode: CharacterValueMode): number[] {
    const text = String(value ?? '');
    if (mode === 'utf8') return Array.from(Buffer.from(text, 'utf8'));
    if (mode === 'utf16') {
        const values: number[] = [];
        for (let index = 0; index < text.length; index += 1) values.push(text.charCodeAt(index));
        return values;
    }
    return Array.from(text).map((character) => character.codePointAt(0) ?? 0);
}

function normalizeNumericToken(token: string, preferredBase: 'auto' | 'decimal' | 'hexadecimal' | 'binary' = 'auto'): number | undefined {
    const clean = String(token || '').trim().replace(/[,;]+$/g, '').replace(/_/g, '');
    if (!clean) return undefined;
    const signed = clean.match(/^([+-]?)(.*)$/);
    const sign = signed?.[1] === '-' ? -1 : 1;
    const body = signed?.[2] ?? clean;
    let parsed: number;
    if (preferredBase === 'hexadecimal' || /^0x[0-9a-f]+$/i.test(body) || /^[0-9a-f]+h$/i.test(body)) {
        const hex = body.replace(/^0x/i, '').replace(/h$/i, '');
        if (!/^[0-9a-f]+$/i.test(hex)) return undefined;
        parsed = Number.parseInt(hex, 16);
    } else if (preferredBase === 'binary' || /^0b[01]+$/i.test(body) || /^[01]+b$/i.test(body)) {
        const bin = body.replace(/^0b/i, '').replace(/b$/i, '');
        if (!/^[01]+$/.test(bin)) return undefined;
        parsed = Number.parseInt(bin, 2);
    } else {
        if (!/^[0-9]+$/.test(body)) return undefined;
        parsed = Number.parseInt(body, 10);
    }
    if (!Number.isFinite(parsed)) return undefined;
    return sign * parsed;
}

function numericValuesToString(values: number[], mode: CharacterValueMode): string | undefined {
    if (mode === 'utf8') {
        if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 0xFF)) return undefined;
        return Buffer.from(values).toString('utf8');
    }
    if (mode === 'utf16') {
        if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 0xFFFF)) return undefined;
        return String.fromCharCode(...values);
    }
    if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 0x10FFFF)) return undefined;
    try { return String.fromCodePoint(...values); } catch { return undefined; }
}

function parseNumericValues(text: string, preferredBase: 'auto' | 'decimal' | 'hexadecimal' | 'binary' = 'auto'): number[] | undefined {
    const tokens = String(text || '').trim().split(/[\\s,;|]+/).filter(Boolean);
    if (!tokens.length) return undefined;
    const values: number[] = [];
    for (const token of tokens) {
        const value = normalizeNumericToken(token, preferredBase);
        if (value === undefined) return undefined;
        values.push(value);
    }
    return values;
}

async function convertSelectedTextToDecimalValues(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selections.length === 0 || editor.selections.every((selection) => selection.isEmpty)) {
        void vscode.window.showInformationMessage('Select a character or string before converting it to decimal values.');
        return;
    }
    const encoding = await vscode.window.showQuickPick([
        { label: 'Unicode code points', description: 'A → 65, é → 233, 😀 → 128512', value: 'codepoint' as CharacterValueMode },
        { label: 'UTF-8 bytes', description: 'é → 195 169', value: 'utf8' as CharacterValueMode },
        { label: 'UTF-16 code units', description: '😀 → 55357 56832', value: 'utf16' as CharacterValueMode }
    ], { title: 'Convert selected text to decimal values', ignoreFocusOut: true });
    if (!encoding) return;
    await editor.edit((builder) => {
        for (const selection of editor.selections) {
            if (selection.isEmpty) continue;
            const selected = editor.document.getText(selection);
            const values = stringToNumericValues(selected, encoding.value).map((value) => String(value)).join(' ');
            builder.replace(selection, values);
        }
    });
}

async function convertSelectedNumbersToText(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selections.length === 0 || editor.selections.every((selection) => selection.isEmpty)) {
        void vscode.window.showInformationMessage('Select decimal values before converting them to text.');
        return;
    }
    const mode = await vscode.window.showQuickPick([
        { label: 'Unicode code points', description: '65 66 67 → ABC', value: 'codepoint' as CharacterValueMode },
        { label: 'UTF-8 bytes', description: '195 169 → é', value: 'utf8' as CharacterValueMode },
        { label: 'UTF-16 code units', description: '55357 56832 → 😀', value: 'utf16' as CharacterValueMode }
    ], { title: 'Convert decimal values to text', ignoreFocusOut: true });
    if (!mode) return;
    const replacements = editor.selections.map((selection) => {
        if (selection.isEmpty) return undefined;
        const selectedText = editor.document.getText(selection);
        const leadingWhitespace = selectedText.match(/^\s*/)?.[0] ?? '';
        const trailingWhitespace = selectedText.match(/\s*$/)?.[0] ?? '';
        const values = parseNumericValues(selectedText.trim(), 'auto');
        const converted = values ? numericValuesToString(values, mode.value) : undefined;
        return converted === undefined ? undefined : { selection, text: `${leadingWhitespace}${converted}${trailingWhitespace}` };
    });
    if (replacements.some((entry) => !entry)) {
        void vscode.window.showErrorMessage('The selected text must contain supported decimal, hexadecimal or binary numeric values separated by spaces, commas or semicolons.');
        return;
    }
    await editor.edit((builder) => {
        for (const replacement of replacements) if (replacement) builder.replace(replacement.selection, replacement.text);
    });
}

function buildCharacterTableHtml(initialText: string): string {
    const safeInitialText = String(initialText || 'A');
    const safeInitialJson = JSON.stringify(safeInitialText).replace(/<\/script/gi, '<\\/script');
    const toHexLocal = (value: number, width = 2): string => '0x' + Number(value).toString(16).toUpperCase().padStart(width, '0');
    const toBinLocal = (value: number, width = 8): string => '0b' + Number(value).toString(2).padStart(width, '0');
    const controlNames = ['NUL','SOH','STX','ETX','EOT','ENQ','ACK','BEL','BS','TAB','LF','VT','FF','CR','SO','SI','DLE','DC1','DC2','DC3','DC4','NAK','SYN','ETB','CAN','EM','SUB','ESC','FS','GS','RS','US'];
    const describeCodeLocal = (value: number): string => {
        if (value < 32) return controlNames[value] || 'CTRL';
        if (value === 32) return 'SPACE';
        if (value === 127) return 'DEL';
        if (value === 160) return 'NO-BREAK SPACE';
        return '';
    };
    const printableCharLocal = (value: number): string => {
        if (value === 32) return '␠';
        if (value < 32 || value === 127) return '␀';
        try { return String.fromCodePoint(value); } catch { return '?'; }
    };
    const cEscapeLocal = (value: number): string => {
        if (value === 9) return '\\t';
        if (value === 10) return '\\n';
        if (value === 13) return '\\r';
        if (value === 0) return '\\0';
        if (value === 34) return '\\"';
        if (value === 39) return "\\'";
        if (value === 92) return '\\\\';
        if (value < 32 || value === 127) return '\\x' + value.toString(16).toUpperCase().padStart(2, '0');
        try { return String.fromCodePoint(value); } catch { return '?'; }
    };
    const utf8BytesForCodePointLocal = (codePoint: number): number[] => Array.from(Buffer.from(String.fromCodePoint(codePoint), 'utf8'));
    const tableData = Array.from({ length: 256 }, (_unused, value) => {
        const char = printableCharLocal(value);
        const name = describeCodeLocal(value);
        const hex = toHexLocal(value, 2);
        const binary = toBinLocal(value, 8);
        const cEscape = cEscapeLocal(value);
        const utf8 = utf8BytesForCodePointLocal(value).map((byte) => toHexLocal(byte, 2)).join(' ');
        const utf16 = toHexLocal(value, 4);
        return { char, name, dec: String(value), hex, binary, cEscape, utf8, utf16 };
    });
    const renderFallbackRow = (row: any): string => '<tr><td>' + escapeHtml(row.char) + '</td><td>' + escapeHtml(row.name) + '</td><td>' + escapeHtml(row.dec) + '</td><td>' + escapeHtml(row.hex) + '</td><td>' + escapeHtml(row.binary) + '</td><td>' + escapeHtml(row.cEscape) + '</td><td>' + escapeHtml(row.utf8) + '</td><td>' + escapeHtml(row.utf16) + '</td></tr>';
    const initialValues = stringToNumericValues(safeInitialText, 'codepoint').map((value) => String(value)).join(' ');
    const fallbackRows = tableData.slice(0, 128).map(renderFallbackRow).join('');
    const tableDataJson = JSON.stringify(tableData).replace(/<\/script/gi, '<\\/script');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root { color-scheme: light dark; }
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 18px; }
    .shell { max-width: 1120px; margin: 0 auto; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 16px; margin-bottom: 14px; background: var(--vscode-sideBar-background, transparent); }
    h1, h2 { margin-top: 0; }
    .muted { opacity: 0.76; }
    .converter-header { display: flex; gap: 8px; align-items: center; justify-content: space-between; flex-wrap: wrap; margin-bottom: 12px; }
    .mode-tabs { display: inline-flex; gap: 6px; padding: 4px; border: 1px solid var(--vscode-panel-border); border-radius: 9px; background: var(--vscode-editor-background); }
    .mode-tab { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border-radius: 7px; padding: 7px 12px; }
    .mode-tab.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .mode-panel[hidden] { display: none !important; }
    .row { display: grid; grid-template-columns: repeat(3, minmax(120px, 1fr)); gap: 10px; align-items: end; }
    input, select, textarea { box-sizing: border-box; width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 6px; padding: 7px 9px; font-family: var(--vscode-editor-font-family); }
    textarea { min-height: 92px; resize: vertical; font-size: 14px; }
    label { display: block; font-weight: 600; margin-bottom: 6px; }
    .btn-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; justify-content: flex-end; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 6px; padding: 8px 14px; cursor: pointer; }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .ascii-toolbar { display: grid; grid-template-columns: minmax(150px, 220px) 1fr 110px; gap: 10px; align-items: end; margin-bottom: 12px; }
    .table-wrap { max-height: 420px; overflow: auto; border: 1px solid var(--vscode-panel-border); border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; font-family: var(--vscode-editor-font-family); }
    th, td { padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); text-align: left; vertical-align: top; white-space: nowrap; }
    th { position: sticky; top: 0; background: var(--vscode-editor-background); z-index: 1; }
    tr:hover { background: var(--vscode-list-hoverBackground); }
    .mono { font-family: var(--vscode-editor-font-family); }
    .help { display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; margin-left:6px; border-radius:50%; border:1px solid var(--vscode-panel-border); color:var(--vscode-textLink-foreground); font-size:12px; font-weight:700; cursor:help; vertical-align:middle; }
    .help:hover { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
    .metric-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:8px; margin-top:8px; }
    .metric { border:1px solid var(--vscode-panel-border); border-radius:8px; padding:8px; background:var(--vscode-textCodeBlock-background); }
    .metric strong { display:block; margin-bottom:4px; }
    .legend-dot { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:5px; vertical-align:middle; }
    .svg-caption { font-size:12px; opacity:.84; margin-top:6px; }
    .help-line { margin-top:8px; padding:8px; border-left:3px solid var(--vscode-textLink-foreground); background:var(--vscode-textCodeBlock-background); border-radius:6px; line-height:1.45; }
    .count { opacity: 0.72; font-family: var(--vscode-editor-font-family); padding-bottom: 7px; }
    .warning { color: var(--vscode-inputValidation-warningForeground); }
    @media (max-width: 840px) { .row, .ascii-toolbar { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="shell">
    <div class="card">
      <h1>Character table / converter</h1>
      <p class="muted">Convert text to decimal, hexadecimal or binary values, convert numeric values back to text, and inspect ASCII/Latin-1 reference values.</p>
    </div>

    <div class="card">
      <div class="converter-header">
        <h2 style="margin-bottom: 0;">Converter</h2>
        <div class="mode-tabs" role="tablist" aria-label="Conversion direction">
          <button type="button" class="mode-tab active" data-mode="textToValues">Text → values</button>
          <button type="button" class="mode-tab" data-mode="valuesToText">Values → text</button>
        </div>
      </div>

      <section id="textToValuesPanel" class="mode-panel">
        <label for="textInput">Text</label>
        <textarea id="textInput" spellcheck="false">${escapeHtml(safeInitialText)}</textarea>
        <div class="row">
          <div><label for="textEncoding">Encoding</label><select id="textEncoding"><option value="codepoint">Unicode code points</option><option value="utf8">UTF-8 bytes</option><option value="utf16">UTF-16 code units</option></select></div>
          <div><label for="valueFormat">Output format</label><select id="valueFormat"><option value="decimal">Decimal</option><option value="hexadecimal">Hexadecimal</option><option value="binary">Binary</option></select></div>
          <div><label for="separator">Separator</label><select id="separator"><option value="space">Space</option><option value="comma">Comma</option><option value="semicolon">Semicolon</option><option value="newline">New line</option></select></div>
        </div>
        <label for="valuesOutput">Values</label>
        <textarea id="valuesOutput" spellcheck="false">${escapeHtml(initialValues)}</textarea>
        <div class="btn-row"><button class="secondary" id="copyValues">Copy</button><button id="insertValues">Insert values</button></div>
      </section>

      <section id="valuesToTextPanel" class="mode-panel" hidden>
        <label for="numericInput">Numeric values</label>
        <textarea id="numericInput" spellcheck="false" placeholder="65 66 67 or 0x41 0x42 0x43">${escapeHtml(initialValues)}</textarea>
        <div class="row">
          <div><label for="numericBase">Input base</label><select id="numericBase"><option value="auto">Auto</option><option value="decimal">Decimal</option><option value="hexadecimal">Hexadecimal</option><option value="binary">Binary</option></select></div>
          <div><label for="numericEncoding">Interpret as</label><select id="numericEncoding"><option value="codepoint">Unicode code points</option><option value="utf8">UTF-8 bytes</option><option value="utf16">UTF-16 code units</option></select></div>
          <div><label>Preview</label><input id="decodedCount" readonly value="1 value" /></div>
        </div>
        <label for="decodedOutput">Text</label>
        <textarea id="decodedOutput" spellcheck="false">${escapeHtml(safeInitialText)}</textarea>
        <div class="btn-row"><button class="secondary" id="copyDecoded">Copy</button><button id="insertDecoded">Insert text</button></div>
      </section>
    </div>

    <div class="card">
      <h2>ASCII / Latin-1 reference</h2>
      <div class="ascii-toolbar">
        <div><label for="tableRange">Table</label><select id="tableRange"><option value="ascii">ASCII 0-127</option><option value="latin1">Latin-1 0-255</option></select></div>
        <div><label for="tableFilter">Filter</label><input id="tableFilter" placeholder="A, 65, 0x41, newline..." /></div>
        <div class="count" id="referenceCount">128 rows</div>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Char</th><th>Name</th><th>Dec</th><th>Hex</th><th>Binary</th><th>C escape</th><th>UTF-8 bytes</th><th>UTF-16 unit</th></tr></thead><tbody id="asciiRows">${fallbackRows}</tbody></table></div>
    </div>
  </div>
  <script>
    (function () {
      'use strict';
      const vscode = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : { postMessage: function () {} };
      const initialText = ${safeInitialJson};
      const tableData = ${tableDataJson};
      function byId(id) { return document.getElementById(id); }
      const textInput = byId('textInput');
      const textEncoding = byId('textEncoding');
      const valueFormat = byId('valueFormat');
      const separator = byId('separator');
      const valuesOutput = byId('valuesOutput');
      const numericInput = byId('numericInput');
      const numericBase = byId('numericBase');
      const numericEncoding = byId('numericEncoding');
      const decodedOutput = byId('decodedOutput');
      const decodedCount = byId('decodedCount');
      const tableRange = byId('tableRange');
      const tableFilter = byId('tableFilter');
      const asciiRows = byId('asciiRows');
      const referenceCount = byId('referenceCount');
      const textPanel = byId('textToValuesPanel');
      const valuesPanel = byId('valuesToTextPanel');
      function clampByte(value) { return Math.max(0, Math.min(255, Number(value) || 0)); }
      function toHex(value, width) { return '0x' + Number(value).toString(16).toUpperCase().padStart(width || 2, '0'); }
      function toBin(value, width) { return '0b' + Number(value).toString(2).padStart(width || 8, '0'); }
      function htmlEsc(value) { return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
      function utf8EncodeCodePoint(codePoint) {
        if (codePoint <= 0x7F) return [codePoint];
        if (codePoint <= 0x7FF) return [0xC0 | (codePoint >> 6), 0x80 | (codePoint & 0x3F)];
        if (codePoint <= 0xFFFF) return [0xE0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3F), 0x80 | (codePoint & 0x3F)];
        return [0xF0 | (codePoint >> 18), 0x80 | ((codePoint >> 12) & 0x3F), 0x80 | ((codePoint >> 6) & 0x3F), 0x80 | (codePoint & 0x3F)];
      }
      function utf8BytesForString(text) {
        const bytes = [];
        for (const ch of Array.from(String(text || ''))) bytes.push.apply(bytes, utf8EncodeCodePoint(ch.codePointAt(0) || 0));
        return bytes;
      }
      function stringFromUtf8Bytes(values) {
        const bytes = values.map(clampByte);
        const codePoints = [];
        for (let i = 0; i < bytes.length; ) {
          const b0 = bytes[i++];
          if (b0 < 0x80) { codePoints.push(b0); continue; }
          if ((b0 & 0xE0) === 0xC0 && i < bytes.length) { const b1 = bytes[i++]; codePoints.push(((b0 & 0x1F) << 6) | (b1 & 0x3F)); continue; }
          if ((b0 & 0xF0) === 0xE0 && i + 1 < bytes.length) { const b1 = bytes[i++], b2 = bytes[i++]; codePoints.push(((b0 & 0x0F) << 12) | ((b1 & 0x3F) << 6) | (b2 & 0x3F)); continue; }
          if ((b0 & 0xF8) === 0xF0 && i + 2 < bytes.length) { const b1 = bytes[i++], b2 = bytes[i++], b3 = bytes[i++]; codePoints.push(((b0 & 0x07) << 18) | ((b1 & 0x3F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F)); continue; }
          codePoints.push(0xFFFD);
        }
        try { return String.fromCodePoint.apply(String, codePoints); } catch (error) { return ''; }
      }
      function valuesFromText(text, mode) {
        const value = String(text == null ? '' : text);
        if (mode === 'utf8') return utf8BytesForString(value);
        if (mode === 'utf16') { const out = []; for (let i = 0; i < value.length; i += 1) out.push(value.charCodeAt(i)); return out; }
        return Array.from(value).map(function (ch) { return ch.codePointAt(0) || 0; });
      }
      function separatorValue() {
        const value = separator ? separator.value : 'space';
        if (value === 'comma') return ', ';
        if (value === 'semicolon') return '; ';
        if (value === 'newline') return '\\n';
        return ' ';
      }
      function formatValue(value, format) {
        if (format === 'hexadecimal') return toHex(value, value > 0xFFFF ? 6 : value > 0xFF ? 4 : 2);
        if (format === 'binary') return toBin(value, value > 0xFF ? 16 : 8);
        return String(value);
      }
      function normalizeNumericToken(token, base) {
        const clean = String(token || '').trim().replace(/[,;]+$/g, '').replace(/_/g, '');
        if (!clean) return undefined;
        const m = clean.match(/^([+-]?)(.*)$/);
        const sign = m && m[1] === '-' ? -1 : 1;
        const body = m ? m[2] : clean;
        let n;
        if (base === 'hexadecimal' || /^0x[0-9a-f]+$/i.test(body) || /^[0-9a-f]+h$/i.test(body)) { const hex = body.replace(/^0x/i, '').replace(/h$/i, ''); if (!/^[0-9a-f]+$/i.test(hex)) return undefined; n = parseInt(hex, 16); }
        else if (base === 'binary' || /^0b[01]+$/i.test(body) || /^[01]+b$/i.test(body)) { const bin = body.replace(/^0b/i, '').replace(/b$/i, ''); if (!/^[01]+$/.test(bin)) return undefined; n = parseInt(bin, 2); }
        else { if (!/^[0-9]+$/.test(body)) return undefined; n = parseInt(body, 10); }
        return Number.isFinite(n) ? sign * n : undefined;
      }
      function parseValues(text, base) {
        const tokens = String(text || '').trim().split(/[\\s,;|]+/).filter(Boolean);
        const out = [];
        for (const token of tokens) { const value = normalizeNumericToken(token, base); if (value === undefined) return undefined; out.push(value); }
        return out;
      }
      function textFromValues(values, mode) {
        try { if (mode === 'utf8') return stringFromUtf8Bytes(values); if (mode === 'utf16') return String.fromCharCode.apply(String, values); return String.fromCodePoint.apply(String, values); } catch (error) { return ''; }
      }
      function updateTextToValues() {
        if (!textInput || !valuesOutput) return;
        try { const values = valuesFromText(textInput.value, textEncoding ? textEncoding.value : 'codepoint'); valuesOutput.value = values.map(function (v) { return formatValue(v, valueFormat ? valueFormat.value : 'decimal'); }).join(separatorValue()); }
        catch (error) { valuesOutput.value = 'Conversion error: ' + String(error && error.message ? error.message : error); }
      }
      function updateValuesToText() {
        if (!numericInput || !decodedOutput || !decodedCount) return;
        const values = parseValues(numericInput.value, numericBase ? numericBase.value : 'auto');
        if (!values || !values.length) { decodedOutput.value = ''; decodedCount.value = '0 value'; return; }
        decodedOutput.value = textFromValues(values, numericEncoding ? numericEncoding.value : 'codepoint');
        decodedCount.value = String(values.length) + (values.length === 1 ? ' value' : ' values');
      }
      function rowHtml(row) { return '<tr><td>' + htmlEsc(row.char) + '</td><td>' + htmlEsc(row.name) + '</td><td>' + htmlEsc(row.dec) + '</td><td>' + htmlEsc(row.hex) + '</td><td>' + htmlEsc(row.binary) + '</td><td>' + htmlEsc(row.cEscape) + '</td><td>' + htmlEsc(row.utf8) + '</td><td>' + htmlEsc(row.utf16) + '</td></tr>'; }
      function updateAsciiTable() {
        if (!asciiRows) return;
        const limit = tableRange && tableRange.value === 'latin1' ? 256 : 128;
        const filter = tableFilter ? tableFilter.value.trim().toLowerCase() : '';
        const rows = [];
        for (let i = 0; i < limit; i += 1) {
          const row = tableData[i];
          const hay = [row.char, row.name, row.dec, row.hex, row.binary, row.cEscape, row.utf8, row.utf16].join(' ').toLowerCase();
          if (filter && hay.indexOf(filter) < 0) continue;
          rows.push(row);
        }
        asciiRows.innerHTML = rows.length ? rows.map(rowHtml).join('') : '<tr><td colspan="8" class="warning">No matching character.</td></tr>';
        if (referenceCount) referenceCount.textContent = String(rows.length) + (rows.length === 1 ? ' row' : ' rows');
      }
      function copyText(value) {
        try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(value || ''); } catch (error) {}
        vscode.postMessage({ type: 'copyCharacterValue', text: value || '' });
      }
      function bindLiveUpdate(element, callback) {
        if (!element) return;
        ['input', 'change', 'keyup', 'compositionend'].forEach(function (eventName) { element.addEventListener(eventName, callback); });
        element.addEventListener('paste', function () { setTimeout(callback, 0); });
      }
      function setMode(mode) {
        const isTextMode = mode !== 'valuesToText';
        if (textPanel) textPanel.hidden = !isTextMode;
        if (valuesPanel) valuesPanel.hidden = isTextMode;
        document.querySelectorAll('.mode-tab').forEach(function (button) { button.classList.toggle('active', button.getAttribute('data-mode') === (isTextMode ? 'textToValues' : 'valuesToText')); });
        if (isTextMode) updateTextToValues(); else updateValuesToText();
      }
      function refreshAllConverters() { updateTextToValues(); updateValuesToText(); updateAsciiTable(); }
      if (textInput && !textInput.value) textInput.value = initialText;
      if (numericInput && !numericInput.value) numericInput.value = valuesFromText(initialText, 'codepoint').join(' ');
      [textInput, textEncoding, valueFormat, separator].forEach(function (el) { bindLiveUpdate(el, updateTextToValues); });
      [numericInput, numericBase, numericEncoding].forEach(function (el) { bindLiveUpdate(el, updateValuesToText); });
      [tableRange, tableFilter].forEach(function (el) { bindLiveUpdate(el, updateAsciiTable); });
      document.querySelectorAll('.mode-tab').forEach(function (button) { button.addEventListener('click', function () { setMode(button.getAttribute('data-mode') || 'textToValues'); }); });
      const copyValues = byId('copyValues'); if (copyValues) copyValues.addEventListener('click', function () { copyText(valuesOutput ? valuesOutput.value : ''); });
      const copyDecoded = byId('copyDecoded'); if (copyDecoded) copyDecoded.addEventListener('click', function () { copyText(decodedOutput ? decodedOutput.value : ''); });
      const insertValues = byId('insertValues'); if (insertValues) insertValues.addEventListener('click', function () { vscode.postMessage({ type: 'insertCharacterValue', text: valuesOutput ? valuesOutput.value : '' }); });
      const insertDecoded = byId('insertDecoded'); if (insertDecoded) insertDecoded.addEventListener('click', function () { vscode.postMessage({ type: 'insertCharacterValue', text: decodedOutput ? decodedOutput.value : '' }); });
      refreshAllConverters();
      setTimeout(refreshAllConverters, 0);
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(refreshAllConverters);
    }());
  </script>
</body>
</html>`;
}

async function openCharacterTable(context: vscode.ExtensionContext): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const initialText = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : 'A';
    const panel = vscode.window.createWebviewPanel('cviCharacterTable', 'CVI: Character table / converter', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
    panel.webview.html = buildCharacterTableHtml(initialText);
    panel.webview.onDidReceiveMessage(async (message) => {
        if (!message || typeof message !== 'object') return;
        if (message.type === 'copyCharacterValue' && typeof message.text === 'string') {
            await vscode.env.clipboard.writeText(message.text);
            void vscode.window.showInformationMessage('Copied character conversion value to clipboard.');
            return;
        }
        if (message.type === 'insertCharacterValue' && typeof message.text === 'string') {
            const activeEditor = vscode.window.activeTextEditor || editor;
            if (!activeEditor) {
                void vscode.window.showErrorMessage('Open a text editor before inserting a character conversion value.');
                return;
            }
            await insertTextAtEditorSelections(activeEditor, message.text);
            panel.dispose();
        }
    });
}


function buildNumberBitConverterHtml(initialText: string): string {
  const initial = escapeHtml(initialText && initialText.trim() ? initialText.trim() : '0x2A');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root { color-scheme: light dark; }
    body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); padding: 18px; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 16px; margin-bottom: 16px; background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-editor-foreground) 8%); }
    h1, h2, h3 { margin-top: 0; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
    .grid.wide { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
    label { display: block; font-weight: 700; margin: 10px 0 6px; }
    input, select, textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 6px; padding: 8px 10px; font-family: var(--vscode-editor-font-family); }
    textarea { min-height: 78px; resize: vertical; }
    input:focus, select:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
    .tabs { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
    .tab { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-button-border, transparent); border-radius: 999px; padding: 7px 12px; cursor: pointer; }
    .tab.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 6px; padding: 8px 12px; cursor: pointer; }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .btn-row { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; margin-top: 12px; }
    .result { font-family: var(--vscode-editor-font-family); white-space: pre-wrap; overflow-wrap: anywhere; background: var(--vscode-textCodeBlock-background); border-radius: 8px; padding: 12px; min-height: 44px; border: 1px solid var(--vscode-panel-border); }
    .summary { opacity: .84; margin-top: 8px; }
    .warning { color: var(--vscode-errorForeground); }
    table { width: 100%; border-collapse: collapse; font-family: var(--vscode-editor-font-family); font-size: 12px; }
    th, td { text-align: left; border-bottom: 1px solid var(--vscode-panel-border); padding: 6px 8px; white-space: nowrap; }
    .table-wrap { overflow: auto; max-height: 320px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; }
    .bit-string { letter-spacing: 0.05em; }
    .split { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:12px; }
    @media (max-width: 820px) { .split { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <h1>Number / bit converter</h1>
  <div class="card">
    <div class="tabs">
      <button class="tab active" type="button" data-mode="convert">Base conversion</button>
      <button class="tab" type="button" data-mode="ops">Bit operations</button>
      <button class="tab" type="button" data-mode="array">Byte array / bit order</button>
    </div>

    <section id="panelConvert">
      <h2>Base conversion</h2>
      <div class="grid wide">
        <div>
          <label for="numberInput">Value</label>
          <textarea id="numberInput" spellcheck="false">${initial}</textarea>
        </div>
        <div class="grid">
          <div>
            <label for="inputBase">Input base</label>
            <select id="inputBase">
              <option value="auto">Auto detect</option>
              <option value="dec">Decimal</option>
              <option value="hex">Hexadecimal</option>
              <option value="bin">Binary</option>
              <option value="gray">Gray code</option>
              <option value="oct">Octal</option>
            </select>
          </div>
          <div>
            <label for="bitWidth">Bit width</label>
            <select id="bitWidth">
              <option value="8">8 bits</option>
              <option value="16">16 bits</option>
              <option value="32" selected>32 bits</option>
              <option value="64">64 bits</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          <div>
            <label for="customWidth">Custom width</label>
            <input id="customWidth" value="32" spellcheck="false" />
          </div>
          <div>
            <label for="signedMode">Interpretation</label>
            <select id="signedMode">
              <option value="unsigned" selected>Unsigned</option>
              <option value="signed">Signed two's complement</option>
            </select>
          </div>
        </div>
      </div>
      <div class="grid">
        <div><label>Decimal</label><div id="outDec" class="result"></div></div>
        <div><label>Hexadecimal</label><div id="outHex" class="result"></div></div>
        <div><label>Binary MSB first</label><div id="outBinMsb" class="result bit-string"></div></div>
        <div><label>Binary LSB first</label><div id="outBinLsb" class="result bit-string"></div></div>
        <div><label>Gray code</label><div id="outGray" class="result bit-string"></div></div>
        <div><label>Octal</label><div id="outOct" class="result"></div></div>
        <div><label>Bytes</label><div id="outBytes" class="result"></div></div>
      </div>
      <div class="btn-row">
        <button class="secondary" id="copyConversion" type="button">Copy summary</button>
        <button id="insertConversion" type="button">Insert selected output</button>
      </div>
      <div>
        <label for="insertFormat">Output to insert</label>
        <select id="insertFormat">
          <option value="dec">Decimal</option>
          <option value="hex">Hexadecimal</option>
          <option value="binmsb">Binary MSB first</option>
          <option value="binlsb">Binary LSB first</option>
          <option value="gray">Gray code</option>
          <option value="oct">Octal</option>
          <option value="byteshex">Hex byte array</option>
        </select>
      </div>
    </section>

    <section id="panelOps" hidden>
      <h2>Bit operations</h2>
      <div class="grid wide">
        <div>
          <label for="opA">A</label>
          <input id="opA" value="0xF0" spellcheck="false" />
        </div>
        <div>
          <label for="opB">B / shift count</label>
          <input id="opB" value="0x0F" spellcheck="false" />
        </div>
        <div>
          <label for="bitOperation">Operation</label>
          <select id="bitOperation">
            <option value="and">A &amp; B</option>
            <option value="or">A | B</option>
            <option value="xor">A ^ B</option>
            <option value="not">~A</option>
            <option value="shl">A &lt;&lt; B</option>
            <option value="shr">A &gt;&gt; B</option>
            <option value="rol">rotate left A by B</option>
            <option value="ror">rotate right A by B</option>
            <option value="mask">A &amp; ((1 &lt;&lt; B) - 1)</option>
          </select>
        </div>
        <div>
          <label for="opWidth">Operation width</label>
          <select id="opWidth"><option>8</option><option>16</option><option selected>32</option><option>64</option></select>
        </div>
      </div>
      <div class="grid">
        <div><label>Result decimal</label><div id="opDec" class="result"></div></div>
        <div><label>Result hexadecimal</label><div id="opHex" class="result"></div></div>
        <div><label>Result binary</label><div id="opBin" class="result bit-string"></div></div>
      </div>
      <div class="btn-row"><button class="secondary" id="copyOp" type="button">Copy result</button><button id="insertOp" type="button">Insert result</button></div>
    </section>

    <section id="panelArray" hidden>
      <h2>Byte array / bit order</h2>
      <div class="split">
        <div>
          <label for="arrayInput">Byte values or text</label>
          <textarea id="arrayInput" spellcheck="false">0x12 0x34 0x7E</textarea>
        </div>
        <div class="grid">
          <div><label for="arrayInputMode">Input mode</label><select id="arrayInputMode"><option value="auto">Numeric tokens auto</option><option value="text">Text / string characters</option><option value="binaryString">Binary string</option></select></div>
          <div><label for="arrayDirection">Array order</label><select id="arrayDirection"><option value="normal">First element first</option><option value="reverse">Start from end of array/string</option></select></div>
          <div><label for="bitOrder">Bit order inside each element</label><select id="bitOrder"><option value="msb">MSB first</option><option value="lsb">LSB first</option></select></div>
          <div><label for="aggregateEndian">Aggregate integer endian</label><select id="aggregateEndian"><option value="big">Big endian</option><option value="little">Little endian</option></select></div>
        </div>
      </div>
      <div class="grid">
        <div><label>Byte list</label><div id="arrayBytes" class="result"></div></div>
        <div><label>Bit stream</label><div id="arrayBits" class="result bit-string"></div></div>
        <div><label>Aggregate decimal</label><div id="arrayDec" class="result"></div></div>
        <div><label>Aggregate hexadecimal</label><div id="arrayHex" class="result"></div></div>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Index</th><th>Source index</th><th>Dec</th><th>Hex</th><th>Binary MSB</th><th>Binary selected order</th></tr></thead><tbody id="arrayRows"></tbody></table></div>
      <div class="btn-row"><button class="secondary" id="copyArray" type="button">Copy array summary</button><button id="insertArray" type="button">Insert bit stream</button></div>
    </section>
  </div>

  <script>
    (function () {
      const vscode = acquireVsCodeApi();
      const $ = function(id) { return document.getElementById(id); };
      function htmlEsc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]; }); }
      function cleanToken(text) { return String(text || '').trim().replace(/_/g, ''); }
      function widthValue() { const selected = $('bitWidth') && $('bitWidth').value === 'custom' ? $('customWidth').value : ($('bitWidth') ? $('bitWidth').value : '32'); const n = Number.parseInt(selected, 10); return Number.isFinite(n) && n > 0 ? Math.min(256, n) : 32; }
      function maskFor(width) { return width <= 0 ? 0n : ((1n << BigInt(width)) - 1n); }
      function parseBigIntLiteral(text, baseMode) {
        let s = cleanToken(text);
        if (!s) return undefined;
        let sign = 1n;
        if (s[0] === '-') { sign = -1n; s = s.slice(1); }
        else if (s[0] === '+') s = s.slice(1);
        s = s.replace(/[uUlL]+$/g, '');
        let base = baseMode || 'auto';
        if (base === 'auto') {
          if (/^0x[0-9a-f]+$/i.test(s)) base = 'hex';
          else if (/^0b[01]+$/i.test(s)) base = 'bin';
          else if (/^0o[0-7]+$/i.test(s)) base = 'oct';
          else if (/^[01]+b$/i.test(s)) { base = 'bin'; s = s.slice(0, -1); }
          else base = 'dec';
        }
        if (base === 'hex') s = s.replace(/^0x/i, '');
        if (base === 'bin') s = s.replace(/^0b/i, '').replace(/b$/i, '');
        if (base === 'oct') s = s.replace(/^0o/i, '');
        if (base === 'dec' && !/^\\d+$/.test(s)) return undefined;
        if (base === 'hex' && !/^[0-9a-f]+$/i.test(s)) return undefined;
        if (base === 'bin' && !/^[01]+$/.test(s)) return undefined;
        if (base === 'oct' && !/^[0-7]+$/.test(s)) return undefined;
        try {
          const prefix = base === 'hex' ? '0x' : base === 'bin' ? '0b' : base === 'oct' ? '0o' : '';
          return sign * BigInt(prefix + s);
        } catch (error) { return undefined; }
      }
      function twosComplementValue(value, width) { const m = maskFor(width); return value & m; }
      function signedFromUnsigned(value, width) { const signBit = 1n << BigInt(width - 1); return (value & signBit) ? value - (1n << BigInt(width)) : value; }
      function padBits(bits, width) { return bits.length >= width ? bits.slice(-width) : '0'.repeat(width - bits.length) + bits; }
      function binMsb(value, width) { return padBits((value & maskFor(width)).toString(2), width); }
      function groupBits(bits) { return String(bits).replace(/(.{4})/g, '$1 ').trim(); }
      function binaryToGrayValue(value) { return value ^ (value >> 1n); }
      function grayToBinaryValue(gray) { let value = gray; for (let shift = 1n; shift < 512n; shift <<= 1n) value ^= (value >> shift); return value; }
      function hexValue(value, width) { const digits = Math.max(1, Math.ceil(width / 4)); return '0x' + (value & maskFor(width)).toString(16).toUpperCase().padStart(digits, '0'); }
      function octValue(value) { return '0o' + value.toString(8); }
      function bytesOf(value, width) { const count = Math.max(1, Math.ceil(width / 8)); const out = []; let v = value & maskFor(width); for (let i=0; i<count; i += 1) { out.unshift(Number(v & 0xFFn)); v >>= 8n; } return out; }
      function byteHex(byte) { return '0x' + Number(byte & 255).toString(16).toUpperCase().padStart(2, '0'); }
      function conversionOutputs() {
        const width = widthValue();
        const base = $('inputBase') ? $('inputBase').value : 'auto';
        let parsed = parseBigIntLiteral($('numberInput') ? $('numberInput').value : '', base === 'gray' ? 'bin' : base);
        if (parsed === undefined) return { error: 'Unsupported number format.' };
        if (base === 'gray') parsed = grayToBinaryValue(parsed);
        const unsigned = twosComplementValue(parsed, width);
        const signedMode = $('signedMode') && $('signedMode').value === 'signed';
        const display = signedMode ? signedFromUnsigned(unsigned, width) : unsigned;
        const bits = binMsb(unsigned, width);
        const grayBits = binMsb(binaryToGrayValue(unsigned), width);
        return { width, parsed, unsigned, display, dec: display.toString(10), hex: hexValue(unsigned, width), binmsb: '0b' + groupBits(bits), binlsb: '0b' + groupBits(bits.split('').reverse().join('')), gray: '0b' + groupBits(grayBits), oct: octValue(unsigned), byteshex: bytesOf(unsigned, width).map(byteHex).join(', ') };
      }
      function updateConversion() {
        const out = conversionOutputs();
        if (out.error) { ['outDec','outHex','outBinMsb','outBinLsb','outGray','outOct','outBytes'].forEach(function(id){ const el=$(id); if(el) el.textContent = out.error; }); return; }
        $('outDec').textContent = out.dec;
        $('outHex').textContent = out.hex;
        $('outBinMsb').textContent = out.binmsb;
        $('outBinLsb').textContent = out.binlsb;
        $('outGray').textContent = out.gray;
        $('outOct').textContent = out.oct;
        $('outBytes').textContent = out.byteshex;
      }
      function selectedConversionValue() { const out = conversionOutputs(); if (out.error) return ''; const key = $('insertFormat') ? $('insertFormat').value : 'dec'; return out[key] || out.dec || ''; }
      function opResult() {
        const width = Number.parseInt($('opWidth') ? $('opWidth').value : '32', 10) || 32;
        const m = maskFor(width);
        const a = parseBigIntLiteral($('opA') ? $('opA').value : '', 'auto');
        const bRaw = parseBigIntLiteral($('opB') ? $('opB').value : '', 'auto');
        if (a === undefined || bRaw === undefined) return { error: 'Unsupported A or B value.' };
        const A = a & m; const B = bRaw & m; const shift = Number(bRaw % BigInt(width || 1));
        let r = 0n; const op = $('bitOperation') ? $('bitOperation').value : 'and';
        if (op === 'and') r = A & B;
        else if (op === 'or') r = A | B;
        else if (op === 'xor') r = A ^ B;
        else if (op === 'not') r = ~A;
        else if (op === 'shl') r = A << BigInt(shift);
        else if (op === 'shr') r = A >> BigInt(shift);
        else if (op === 'rol') r = ((A << BigInt(shift)) | (A >> BigInt(width - shift))) & m;
        else if (op === 'ror') r = ((A >> BigInt(shift)) | (A << BigInt(width - shift))) & m;
        else if (op === 'mask') r = A & ((1n << BigInt(Math.max(0, shift))) - 1n);
        r &= m;
        return { width, value: r, dec: r.toString(10), hex: hexValue(r, width), bin: '0b' + groupBits(binMsb(r, width)) };
      }
      function updateOps() { const out = opResult(); if (out.error) { $('opDec').textContent = out.error; $('opHex').textContent = out.error; $('opBin').textContent = out.error; return; } $('opDec').textContent = out.dec; $('opHex').textContent = out.hex; $('opBin').textContent = out.bin; }
      function parseByteTokens(text) {
        const raw = String(text || '').trim();
        if (!raw) return [];
        const normalized = raw.replace(/[{},;|\\[\\]\\(\\)]/g, ' ');
        const tokens = normalized.split(/\\s+/).filter(Boolean);
        const out = [];
        for (const token of tokens) { const v = parseBigIntLiteral(token, 'auto'); if (v === undefined) return undefined; out.push(Number(v & 0xFFn)); }
        return out;
      }
      function bytesFromArrayInput() {
        const raw = $('arrayInput') ? $('arrayInput').value : '';
        const mode = $('arrayInputMode') ? $('arrayInputMode').value : 'auto';
        if (mode === 'text') return Array.from(raw).map(function(ch){ return ch.codePointAt(0) & 0xFF; });
        if (mode === 'binaryString') { const clean = raw.replace(/[^01]/g, ''); const out=[]; for(let i=0;i<clean.length;i+=8){ const chunk=clean.slice(i,i+8); if(chunk) out.push(Number.parseInt(chunk.padEnd(8,'0'),2)); } return out; }
        return parseByteTokens(raw);
      }
      function byteBits(byte) { return Number(byte & 255).toString(2).padStart(8, '0'); }
      function aggregateBytes(bytes, endian) { let v=0n; const seq = endian === 'little' ? bytes.slice().reverse() : bytes; for (const byte of seq) { v = (v << 8n) | BigInt(byte & 255); } return v; }
      function updateArray() {
        let bytes = bytesFromArrayInput();
        if (!bytes) { ['arrayBytes','arrayBits','arrayDec','arrayHex'].forEach(function(id){ $(id).textContent='Unsupported byte array.'; }); $('arrayRows').innerHTML=''; return; }
        const source = bytes.map(function(v,i){ return { byte:v, sourceIndex:i }; });
        if ($('arrayDirection') && $('arrayDirection').value === 'reverse') source.reverse();
        const bitOrder = $('bitOrder') ? $('bitOrder').value : 'msb';
        const orderedBits = source.map(function(entry){ const bits=byteBits(entry.byte); return bitOrder === 'lsb' ? bits.split('').reverse().join('') : bits; });
        const aggregate = aggregateBytes(source.map(function(e){return e.byte;}), $('aggregateEndian') ? $('aggregateEndian').value : 'big');
        $('arrayBytes').textContent = source.map(function(e){return byteHex(e.byte);}).join(', ');
        $('arrayBits').textContent = orderedBits.join(' ');
        $('arrayDec').textContent = aggregate.toString(10);
        $('arrayHex').textContent = '0x' + aggregate.toString(16).toUpperCase();
        $('arrayRows').innerHTML = source.map(function(e,i){ const bits=byteBits(e.byte); const selected = bitOrder === 'lsb' ? bits.split('').reverse().join('') : bits; return '<tr><td>'+i+'</td><td>'+e.sourceIndex+'</td><td>'+e.byte+'</td><td>'+byteHex(e.byte)+'</td><td>'+bits+'</td><td>'+selected+'</td></tr>'; }).join('');
      }
      function refreshAll() { updateConversion(); updateOps(); updateArray(); }
      function bind(id, cb) { const el=$(id); if(!el) return; ['input','change','keyup','compositionend'].forEach(function(evt){ el.addEventListener(evt, cb); }); el.addEventListener('paste', function(){ setTimeout(cb, 0); }); }
      ['numberInput','inputBase','bitWidth','customWidth','signedMode','insertFormat'].forEach(function(id){ bind(id, updateConversion); });
      ['opA','opB','bitOperation','opWidth'].forEach(function(id){ bind(id, updateOps); });
      ['arrayInput','arrayInputMode','arrayDirection','bitOrder','aggregateEndian'].forEach(function(id){ bind(id, updateArray); });
      document.querySelectorAll('.tab').forEach(function(button){ button.addEventListener('click', function(){ const mode=button.getAttribute('data-mode') || 'convert'; document.querySelectorAll('.tab').forEach(function(b){ b.classList.toggle('active', b === button); }); $('panelConvert').hidden = mode !== 'convert'; $('panelOps').hidden = mode !== 'ops'; $('panelArray').hidden = mode !== 'array'; refreshAll(); }); });
      function copyText(text) { try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text || ''); } catch (e) {} vscode.postMessage({ type:'copyNumberValue', text:text || '' }); }
      $('copyConversion').addEventListener('click', function(){ const out=conversionOutputs(); if(out.error) return; copyText('dec: '+out.dec+'\\nhex: '+out.hex+'\\nbin MSB: '+out.binmsb+'\\nbin LSB: '+out.binlsb+'\\ngray: '+out.gray+'\\nbytes: '+out.byteshex); });
      $('insertConversion').addEventListener('click', function(){ vscode.postMessage({ type:'insertNumberValue', text:selectedConversionValue() }); });
      $('copyOp').addEventListener('click', function(){ const out=opResult(); if(!out.error) copyText(out.hex); });
      $('insertOp').addEventListener('click', function(){ const out=opResult(); if(!out.error) vscode.postMessage({ type:'insertNumberValue', text:out.hex }); });
      $('copyArray').addEventListener('click', function(){ copyText('bytes: '+$('arrayBytes').textContent+'\\nbits: '+$('arrayBits').textContent+'\\ndec: '+$('arrayDec').textContent+'\\nhex: '+$('arrayHex').textContent); });
      $('insertArray').addEventListener('click', function(){ vscode.postMessage({ type:'insertNumberValue', text:$('arrayBits').textContent || '' }); });
      refreshAll(); setTimeout(refreshAll, 0); if (typeof requestAnimationFrame === 'function') requestAnimationFrame(refreshAll);
    }());
  </script>
</body>
</html>`;
}

async function openNumberConverter(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const initialText = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : '0x2A';
  const panel = vscode.window.createWebviewPanel('cviNumberBitConverter', 'CVI: Number / bit converter', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
  panel.webview.html = buildNumberBitConverterHtml(initialText);
  panel.webview.onDidReceiveMessage(async (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'copyNumberValue' && typeof message.text === 'string') {
      await vscode.env.clipboard.writeText(message.text);
      void vscode.window.showInformationMessage('Copied number conversion value to clipboard.');
      return;
    }
    if (message.type === 'insertNumberValue' && typeof message.text === 'string') {
      const activeEditor = vscode.window.activeTextEditor || editor;
      if (!activeEditor) {
        void vscode.window.showErrorMessage('Open a text editor before inserting a number conversion value.');
        return;
      }
      await insertTextAtEditorSelections(activeEditor, message.text);
      panel.dispose();
    }
  });
}


function buildLogicStateDesignerHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root { color-scheme: light dark; }
    body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); padding: 18px; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 16px; margin-bottom: 16px; background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-editor-foreground) 8%); }
    h1, h2, h3 { margin-top: 0; }
    .tabs { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px; }
    .tab { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-button-border, transparent); border-radius: 999px; padding: 7px 12px; cursor: pointer; }
    .tab.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap:12px; }
    .split { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:12px; }
    @media (max-width: 900px) { .split { grid-template-columns:1fr; } }
    label { display:block; font-weight:700; margin:10px 0 6px; }
    input, select, textarea { width:100%; box-sizing:border-box; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, transparent); border-radius:6px; padding:8px 10px; font-family:var(--vscode-editor-font-family); }
    textarea { min-height:82px; resize:vertical; }
    input:focus, select:focus, textarea:focus { outline:1px solid var(--vscode-focusBorder); }
    table { width:100%; border-collapse:collapse; font-family:var(--vscode-editor-font-family); font-size:12px; }
    th, td { text-align:left; border-bottom:1px solid var(--vscode-panel-border); padding:6px 8px; white-space:nowrap; }
    .table-wrap { overflow:auto; max-height:360px; border:1px solid var(--vscode-panel-border); border-radius:8px; }
    .result { font-family:var(--vscode-editor-font-family); white-space:pre-wrap; overflow-wrap:anywhere; background:var(--vscode-textCodeBlock-background); border-radius:8px; padding:12px; min-height:52px; border:1px solid var(--vscode-panel-border); }
    .btn-row { display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end; margin-top:12px; }
    button { background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; border-radius:6px; padding:8px 12px; cursor:pointer; }
    button.secondary { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
    .mini { padding:4px 8px; font-size:12px; }
    .hint { opacity:.82; margin-top:8px; }
    .pill { display:inline-block; padding:2px 7px; border-radius:999px; background:var(--vscode-badge-background); color:var(--vscode-badge-foreground); margin:1px 3px 1px 0; }
    .row-output { min-width:72px; }
  </style>
</head>
<body>
  <h1>Truth table / FSM designer</h1>
  <div class="card">
    <div class="tabs">
      <button class="tab active" type="button" data-mode="truth">Truth table</button>
      <button class="tab" type="button" data-mode="mealy">Mealy machine</button>
      <button class="tab" type="button" data-mode="moore">Moore machine</button>
    </div>

    <section id="panelTruth">
      <h2>Truth table</h2>
      <div class="grid">
        <div>
          <label for="truthInputs">Input flags</label>
          <textarea id="truthInputs" spellcheck="false">enable\nfault\nmanual</textarea>
          <div class="hint">One flag per line, or separated with commas/spaces. Up to 10 flags are rendered as a full table.</div>
        </div>
        <div>
          <label for="truthOutputName">Output name</label>
          <input id="truthOutputName" value="allowStart" spellcheck="false" />
          <label for="truthInsertFormat">Generated output</label>
          <select id="truthInsertFormat">
            <option value="cExpr">C expression</option>
            <option value="pythonExpr">Python expression</option>
            <option value="markdown">Markdown truth table</option>
            <option value="csv">CSV table</option>
            <option value="lookupC">C lookup table</option>
          </select>
        </div>
      </div>
      <div class="btn-row" style="justify-content:flex-start">
        <button class="secondary mini" id="truthAllZero" type="button">All outputs = 0</button>
        <button class="secondary mini" id="truthAllOne" type="button">All outputs = 1</button>
        <button class="secondary mini" id="truthOneWhenOnlyFirst" type="button">Example: first flag only</button>
        <button class="secondary mini" id="truthDefaultExample" type="button">Safety example</button>
      </div>
      <label>Rows</label>
      <div class="table-wrap"><table><thead id="truthHead"></thead><tbody id="truthBody"></tbody></table></div>
      <div class="split">
        <div><label>Minimized practical expression</label><div id="truthExpr" class="result"></div></div>
        <div><label>Generated artifact</label><textarea id="truthGenerated" class="result" spellcheck="false"></textarea></div>
      </div>
      <div class="hint">Uses canonical DNF/CNF generation. X means don't-care and is ignored by the default generated condition.</div>
      <div class="btn-row"><button class="secondary" id="copyTruth" type="button">Copy</button><button id="insertTruth" type="button">Insert</button></div>
    </section>

    <section id="panelMealy" hidden>
      <h2>Mealy machine</h2>
      <div class="grid">
        <div><label for="mealyStates">States</label><textarea id="mealyStates" spellcheck="false">IDLE\nRUN\nERROR</textarea></div>
        <div><label for="mealyInputs">Inputs / events</label><textarea id="mealyInputs" spellcheck="false">start\nstop\nfault</textarea></div>
        <div><label for="mealyOutputDefault">Default output</label><input id="mealyOutputDefault" value="0" spellcheck="false" /></div>
      </div>
      <div class="btn-row" style="justify-content:flex-start"><button class="secondary mini" id="mealyBuild" type="button">Rebuild transition table</button><button class="secondary mini" id="mealyFaultExample" type="button">Fault example</button></div>
      <div class="table-wrap"><table><thead id="mealyHead"></thead><tbody id="mealyBody"></tbody></table></div>
      <label>Generated C skeleton</label><textarea id="mealyGenerated" class="result" spellcheck="false"></textarea>
      <div class="btn-row"><button class="secondary" id="copyMealy" type="button">Copy</button><button id="insertMealy" type="button">Insert</button></div>
    </section>

    <section id="panelMoore" hidden>
      <h2>Moore machine</h2>
      <div class="grid">
        <div><label for="mooreStates">States</label><textarea id="mooreStates" spellcheck="false">IDLE\nRUN\nERROR</textarea></div>
        <div><label for="mooreInputs">Inputs / events</label><textarea id="mooreInputs" spellcheck="false">start\nstop\nfault</textarea></div>
        <div><label for="mooreOutputs">State outputs</label><textarea id="mooreOutputs" spellcheck="false">IDLE: 0\nRUN: 1\nERROR: 0</textarea><div class="hint">Format: STATE: output.</div></div>
      </div>
      <div class="btn-row" style="justify-content:flex-start"><button class="secondary mini" id="mooreBuild" type="button">Rebuild transition table</button><button class="secondary mini" id="mooreFaultExample" type="button">Fault example</button></div>
      <div class="table-wrap"><table><thead id="mooreHead"></thead><tbody id="mooreBody"></tbody></table></div>
      <label>Generated C skeleton</label><textarea id="mooreGenerated" class="result" spellcheck="false"></textarea>
      <div class="btn-row"><button class="secondary" id="copyMoore" type="button">Copy</button><button id="insertMoore" type="button">Insert</button></div>
    </section>
  </div>

  <script>
    (function(){
      const vscode = acquireVsCodeApi();
      const $ = function(id){ return document.getElementById(id); };
      function help(text){ return '<span class="help" title="'+String(text).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')+'">?</span>'; }
      function splitNames(text) { return String(text || '').split(/[\\s,;]+/).map(function(v){ return v.trim(); }).filter(Boolean).map(function(v){ return v.replace(/[^A-Za-z0-9_]/g, '_'); }).filter(Boolean); }
      function unique(values) { const seen = new Set(); return values.filter(function(v){ if (seen.has(v)) return false; seen.add(v); return true; }); }
      function cIdent(v) { v = String(v || '').replace(/[^A-Za-z0-9_]/g, '_'); return /^[A-Za-z_]/.test(v) ? v : ('_' + v); }
      function comboRows(n) { const rows = []; const total = Math.pow(2, Math.max(0, n)); for (let i = 0; i < total; i++) { const bits=[]; for (let b=n-1;b>=0;b--) bits.push((i >> b) & 1); rows.push(bits); } return rows; }
      const truthOutputs = new Map();
      function truthKey(bits) { return bits.join(''); }
      function getTruthFlags() { return unique(splitNames($('truthInputs').value)).slice(0, 10); }
      function renderTruthRows() {
        const flags = getTruthFlags();
        const rows = comboRows(flags.length);
        $('truthHead').innerHTML = '<tr>' + flags.map(function(f){ return '<th>' + f + '</th>'; }).join('') + '<th>' + cIdent($('truthOutputName').value || 'out') + '</th></tr>';
        $('truthBody').innerHTML = rows.map(function(bits){ const key=truthKey(bits); if(!truthOutputs.has(key)) truthOutputs.set(key, '0'); return '<tr>' + bits.map(function(bit){ return '<td>' + bit + '</td>'; }).join('') + '<td><select class="row-output" data-key="' + key + '"><option value="0">0</option><option value="1">1</option><option value="X">X</option></select></td></tr>'; }).join('');
        document.querySelectorAll('.row-output').forEach(function(sel){ sel.value = truthOutputs.get(sel.getAttribute('data-key')) || '0'; sel.addEventListener('change', function(){ truthOutputs.set(sel.getAttribute('data-key'), sel.value); updateTruthGenerated(); }); });
        updateTruthGenerated();
      }
      function termFor(flags, bits, lang) { if (lang === 'python') return flags.map(function(f,i){ return bits[i] ? f : ('not ' + f); }).join(' and '); return flags.map(function(f,i){ return bits[i] ? f : ('!' + f); }).join(' && '); }
      function maxTermFor(flags, bits) { return flags.map(function(f,i){ return bits[i] ? ('!' + f) : f; }).join(' || '); }
      function truthRowsWithValues() { const flags = getTruthFlags(); return comboRows(flags.length).map(function(bits){ return { bits: bits, out: truthOutputs.get(truthKey(bits)) || '0' }; }); }
      function dnfExpr(lang) { const flags=getTruthFlags(); const ones=truthRowsWithValues().filter(function(r){ return r.out === '1'; }); if (!flags.length) return '0'; if (!ones.length) return lang === 'python' ? 'False' : '0'; return ones.map(function(r){ return '(' + termFor(flags,r.bits,lang) + ')'; }).join(lang === 'python' ? ' or ' : ' || '); }
      function cnfExpr() { const flags=getTruthFlags(); const zeros=truthRowsWithValues().filter(function(r){ return r.out === '0'; }); if (!flags.length) return '1'; if (!zeros.length) return '1'; return zeros.map(function(r){ return '(' + maxTermFor(flags,r.bits) + ')'; }).join(' && '); }
      function markdownTruth() { const flags=getTruthFlags(); const out=cIdent($('truthOutputName').value || 'out'); const header='| ' + flags.concat([out]).join(' | ') + ' |'; const sep='| ' + flags.concat([out]).map(function(){ return '---'; }).join(' | ') + ' |'; const rows=truthRowsWithValues().map(function(r){ return '| ' + r.bits.concat([r.out]).join(' | ') + ' |'; }); return [header, sep].concat(rows).join('\\n'); }
      function csvTruth() { const flags=getTruthFlags(); const out=cIdent($('truthOutputName').value || 'out'); return [flags.concat([out]).join(',')].concat(truthRowsWithValues().map(function(r){ return r.bits.concat([r.out]).join(','); })).join('\\n'); }
      function cLookup() { const flags=getTruthFlags(); const out=cIdent($('truthOutputName').value || 'out'); const rows=truthRowsWithValues(); const values=rows.map(function(r){ return r.out === 'X' ? '0' : r.out; }).join(', '); const maskLines=flags.map(function(f,i){ const shift=flags.length - 1 - i; return '    key |= (' + cIdent(f) + ' ? 1u : 0u) << ' + shift + ';'; }); return 'static const uint8_t ' + out + '_table[' + rows.length + '] = { ' + values + ' };\\n\\nuint8_t compute_' + out + '(' + flags.map(function(f){ return 'uint8_t ' + cIdent(f); }).join(', ') + ')\\n{\\n    uint8_t key = 0u;\\n' + maskLines.join('\\n') + '\\n    return ' + out + '_table[key];\\n}'; }
      function selectedTruthText() { const fmt=$('truthInsertFormat').value; if(fmt==='pythonExpr') return dnfExpr('python'); if(fmt==='markdown') return markdownTruth(); if(fmt==='csv') return csvTruth(); if(fmt==='lookupC') return cLookup(); return dnfExpr('c'); }
      function updateTruthGenerated() { $('truthExpr').textContent = 'DNF: ' + dnfExpr('c') + '\\nCNF: ' + cnfExpr(); $('truthGenerated').value = selectedTruthText(); }
      function setAllTruth(value) { truthRowsWithValues().forEach(function(r){ truthOutputs.set(truthKey(r.bits), value); }); renderTruthRows(); }
      function setTruthSafetyExample() { const flags=getTruthFlags(); truthRowsWithValues().forEach(function(r){ const vals = {}; flags.forEach(function(f,i){ vals[f]=r.bits[i]; }); const allowed = vals.enable === 1 && vals.fault === 0; truthOutputs.set(truthKey(r.bits), allowed ? '1' : '0'); }); renderTruthRows(); }
      function setTruthFirstOnly() { truthRowsWithValues().forEach(function(r){ truthOutputs.set(truthKey(r.bits), r.bits[0] === 1 ? '1' : '0'); }); renderTruthRows(); }
      function copyText(text) { try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text || ''); } catch (e) {} vscode.postMessage({ type:'copyLogicValue', text:text || '' }); }
      function insertText(text) { vscode.postMessage({ type:'insertLogicValue', text:text || '' }); }

      const mealyTransitions = new Map();
      const mooreTransitions = new Map();
      function transitionKey(state,input) { return state + '|' + input; }
      function selectHtml(className, value, states, key) { return '<select class="' + className + '" data-key="' + key + '">' + states.map(function(s){ return '<option value="' + s + '">' + s + '</option>'; }).join('') + '</select>'; }
      function outputInputHtml(className, value, key) { return '<input class="' + className + '" data-key="' + key + '" value="' + String(value || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;') + '" />'; }
      function getMealyStates(){ return unique(splitNames($('mealyStates').value)).slice(0, 20); }
      function getMealyInputs(){ return unique(splitNames($('mealyInputs').value)).slice(0, 20); }
      function renderMealy() { const states=getMealyStates(); const inputs=getMealyInputs(); $('mealyHead').innerHTML='<tr><th>Current state</th><th>Input</th><th>Next state</th><th>Output</th></tr>'; $('mealyBody').innerHTML=states.flatMap(function(st){ return inputs.map(function(inp){ const key=transitionKey(st,inp); const rec=mealyTransitions.get(key) || { next: st, output: $('mealyOutputDefault').value || '0' }; mealyTransitions.set(key, rec); return '<tr><td>'+st+'</td><td>'+inp+'</td><td>'+selectHtml('mealy-next', rec.next, states, key)+'</td><td>'+outputInputHtml('mealy-output', rec.output, key)+'</td></tr>'; }); }).join(''); document.querySelectorAll('.mealy-next').forEach(function(el){ el.value=(mealyTransitions.get(el.getAttribute('data-key'))||{}).next || states[0] || ''; el.addEventListener('change', function(){ const rec=mealyTransitions.get(el.getAttribute('data-key')) || {}; rec.next=el.value; mealyTransitions.set(el.getAttribute('data-key'), rec); updateMealyGenerated(); }); }); document.querySelectorAll('.mealy-output').forEach(function(el){ el.addEventListener('input', function(){ const rec=mealyTransitions.get(el.getAttribute('data-key')) || {}; rec.output=el.value; mealyTransitions.set(el.getAttribute('data-key'), rec); updateMealyGenerated(); }); }); updateMealyGenerated(); }
      function enumName(name){ return 'STATE_' + cIdent(name).toUpperCase(); }
      function eventName(name){ return 'EV_' + cIdent(name).toUpperCase(); }
      function cString(s){ return String(s || ''); }
      function updateMealyGenerated(){ const states=getMealyStates(); const inputs=getMealyInputs(); const lines=[]; lines.push('typedef enum'); lines.push('{'); states.forEach(function(s,i){ lines.push('    ' + enumName(s) + (i+1<states.length?',':'')); }); lines.push('} state_t;\\n'); lines.push('typedef enum'); lines.push('{'); inputs.forEach(function(s,i){ lines.push('    ' + eventName(s) + (i+1<inputs.length?',':'')); }); lines.push('} event_t;\\n'); lines.push('state_t mealy_step(state_t state, event_t event, int *output)'); lines.push('{'); lines.push('    if (output) *output = 0;'); lines.push('    switch (state)'); lines.push('    {'); states.forEach(function(st){ lines.push('    case ' + enumName(st) + ':'); lines.push('        switch (event)'); lines.push('        {'); inputs.forEach(function(inp){ const rec=mealyTransitions.get(transitionKey(st,inp)) || { next: st, output:'0' }; lines.push('        case ' + eventName(inp) + ': if (output) *output = ' + (rec.output || '0') + '; return ' + enumName(rec.next || st) + ';'); }); lines.push('        default: return state;'); lines.push('        }'); }); lines.push('    default: return state;'); lines.push('    }'); lines.push('}'); $('mealyGenerated').value = lines.join('\\n'); }
      function mealyFaultExample(){ const states=getMealyStates(); const inputs=getMealyInputs(); states.forEach(function(st){ inputs.forEach(function(inp){ const key=transitionKey(st,inp); const rec=mealyTransitions.get(key) || { next: st, output:'0' }; if(inp.toLowerCase().includes('fault')) { rec.next = states.find(function(s){ return s.toLowerCase().includes('error'); }) || st; rec.output='0'; } else if(st.toLowerCase().includes('idle') && inp.toLowerCase().includes('start')) { rec.next = states.find(function(s){ return s.toLowerCase().includes('run'); }) || st; rec.output='1'; } else if(st.toLowerCase().includes('run') && inp.toLowerCase().includes('stop')) { rec.next = states.find(function(s){ return s.toLowerCase().includes('idle'); }) || st; rec.output='0'; } mealyTransitions.set(key,rec); }); }); renderMealy(); }
      function getMooreStates(){ return unique(splitNames($('mooreStates').value)).slice(0, 20); }
      function getMooreInputs(){ return unique(splitNames($('mooreInputs').value)).slice(0, 20); }
      function mooreOutputMap(){ const map={}; String($('mooreOutputs').value || '').split(String.fromCharCode(10)).forEach(function(line){ const idx=String(line||'').indexOf(':'); if(idx>=0){ const name=cIdent(String(line).slice(0,idx).trim()); const value=String(line).slice(idx+1).trim() || '0'; if(name) map[name]=value; } }); return map; }
      function renderMoore(){ const states=getMooreStates(); const inputs=getMooreInputs(); $('mooreHead').innerHTML='<tr><th>Current state</th><th>Input</th><th>Next state</th></tr>'; $('mooreBody').innerHTML=states.flatMap(function(st){ return inputs.map(function(inp){ const key=transitionKey(st,inp); const next=mooreTransitions.get(key) || st; mooreTransitions.set(key,next); return '<tr><td>'+st+'</td><td>'+inp+'</td><td>'+selectHtml('moore-next', next, states, key)+'</td></tr>'; }); }).join(''); document.querySelectorAll('.moore-next').forEach(function(el){ el.value=mooreTransitions.get(el.getAttribute('data-key')) || states[0] || ''; el.addEventListener('change', function(){ mooreTransitions.set(el.getAttribute('data-key'), el.value); updateMooreGenerated(); }); }); updateMooreGenerated(); }
      function updateMooreGenerated(){ const states=getMooreStates(); const inputs=getMooreInputs(); const outs=mooreOutputMap(); const lines=[]; lines.push('typedef enum'); lines.push('{'); states.forEach(function(s,i){ lines.push('    ' + enumName(s) + (i+1<states.length?',':'')); }); lines.push('} state_t;\\n'); lines.push('typedef enum'); lines.push('{'); inputs.forEach(function(s,i){ lines.push('    ' + eventName(s) + (i+1<inputs.length?',':'')); }); lines.push('} event_t;\\n'); lines.push('int moore_output(state_t state)'); lines.push('{'); lines.push('    switch (state)'); lines.push('    {'); states.forEach(function(st){ lines.push('    case ' + enumName(st) + ': return ' + (outs[cIdent(st)] || '0') + ';'); }); lines.push('    default: return 0;'); lines.push('    }'); lines.push('}\\n'); lines.push('state_t moore_step(state_t state, event_t event)'); lines.push('{'); lines.push('    switch (state)'); lines.push('    {'); states.forEach(function(st){ lines.push('    case ' + enumName(st) + ':'); lines.push('        switch (event)'); lines.push('        {'); inputs.forEach(function(inp){ const next=mooreTransitions.get(transitionKey(st,inp)) || st; lines.push('        case ' + eventName(inp) + ': return ' + enumName(next) + ';'); }); lines.push('        default: return state;'); lines.push('        }'); }); lines.push('    default: return state;'); lines.push('    }'); lines.push('}'); $('mooreGenerated').value = lines.join('\\n'); }
      function mooreFaultExample(){ const states=getMooreStates(); const inputs=getMooreInputs(); states.forEach(function(st){ inputs.forEach(function(inp){ let next=st; if(inp.toLowerCase().includes('fault')) next = states.find(function(s){ return s.toLowerCase().includes('error'); }) || st; else if(st.toLowerCase().includes('idle') && inp.toLowerCase().includes('start')) next = states.find(function(s){ return s.toLowerCase().includes('run'); }) || st; else if(st.toLowerCase().includes('run') && inp.toLowerCase().includes('stop')) next = states.find(function(s){ return s.toLowerCase().includes('idle'); }) || st; mooreTransitions.set(transitionKey(st,inp), next); }); }); renderMoore(); }

      document.querySelectorAll('.tab').forEach(function(button){ button.addEventListener('click', function(){ const mode=button.getAttribute('data-mode') || 'truth'; document.querySelectorAll('.tab').forEach(function(b){ b.classList.toggle('active', b === button); }); $('panelTruth').hidden = mode !== 'truth'; $('panelMealy').hidden = mode !== 'mealy'; $('panelMoore').hidden = mode !== 'moore'; if(mode==='truth') renderTruthRows(); if(mode==='mealy') renderMealy(); if(mode==='moore') renderMoore(); }); });
      ['truthInputs','truthOutputName','truthInsertFormat'].forEach(function(id){ $(id).addEventListener('input', renderTruthRows); $(id).addEventListener('change', renderTruthRows); });
      $('truthAllZero').addEventListener('click', function(){ setAllTruth('0'); });
      $('truthAllOne').addEventListener('click', function(){ setAllTruth('1'); });
      $('truthOneWhenOnlyFirst').addEventListener('click', setTruthFirstOnly);
      $('truthDefaultExample').addEventListener('click', setTruthSafetyExample);
      $('copyTruth').addEventListener('click', function(){ copyText($('truthGenerated').value); });
      $('insertTruth').addEventListener('click', function(){ insertText($('truthGenerated').value); });
      ['mealyStates','mealyInputs','mealyOutputDefault'].forEach(function(id){ $(id).addEventListener('change', renderMealy); $(id).addEventListener('input', function(){ updateMealyGenerated(); }); });
      $('mealyBuild').addEventListener('click', renderMealy); $('mealyFaultExample').addEventListener('click', mealyFaultExample); $('copyMealy').addEventListener('click', function(){ copyText($('mealyGenerated').value); }); $('insertMealy').addEventListener('click', function(){ insertText($('mealyGenerated').value); });
      ['mooreStates','mooreInputs','mooreOutputs'].forEach(function(id){ $(id).addEventListener('change', renderMoore); $(id).addEventListener('input', function(){ updateMooreGenerated(); }); });
      $('mooreBuild').addEventListener('click', renderMoore); $('mooreFaultExample').addEventListener('click', mooreFaultExample); $('copyMoore').addEventListener('click', function(){ copyText($('mooreGenerated').value); }); $('insertMoore').addEventListener('click', function(){ insertText($('mooreGenerated').value); });
      renderTruthRows(); renderMealy(); renderMoore();
    }());
  </script>
</body>
</html>`;
}

async function openTruthTableDesigner(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const panel = vscode.window.createWebviewPanel('cviTruthTableDesigner', 'CVI: Truth table / FSM designer', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
  panel.webview.html = buildLogicStateDesignerHtml();
  panel.webview.onDidReceiveMessage(async (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'copyLogicValue' && typeof message.text === 'string') {
      await vscode.env.clipboard.writeText(message.text);
      void vscode.window.showInformationMessage('Copied logic/FSM artifact to clipboard.');
      return;
    }
    if (message.type === 'insertLogicValue' && typeof message.text === 'string') {
      const activeEditor = vscode.window.activeTextEditor || editor;
      if (!activeEditor) {
        void vscode.window.showErrorMessage('Open a text editor before inserting a logic/FSM artifact.');
        return;
      }
      await insertTextAtEditorSelections(activeEditor, message.text);
      panel.dispose();
    }
  });
}

function buildDigitalFilterDesignerHtml(initialText: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root { color-scheme: light dark; }
    body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); padding: 18px; }
    h1, h2, h3 { margin-top: 0; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 16px; margin-bottom: 16px; background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-editor-foreground) 8%); }
    .tabs { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px; }
    .tab { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-button-border, transparent); border-radius: 999px; padding: 7px 12px; cursor: pointer; }
    .tab.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:12px; }
    .split { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:12px; }
    .three { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; }
    @media (max-width: 980px) { .split, .three { grid-template-columns:1fr; } }
    label { display:block; font-weight:700; margin:10px 0 6px; }
    input, select, textarea { width:100%; box-sizing:border-box; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, transparent); border-radius:6px; padding:8px 10px; font-family:var(--vscode-editor-font-family); }
    textarea { min-height:90px; resize:vertical; }
    input:focus, select:focus, textarea:focus { outline:1px solid var(--vscode-focusBorder); }
    .result { font-family:var(--vscode-editor-font-family); white-space:pre-wrap; overflow-wrap:anywhere; background:var(--vscode-textCodeBlock-background); border-radius:8px; padding:12px; min-height:52px; border:1px solid var(--vscode-panel-border); }
    .btn-row { display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end; margin-top:12px; }
    button { background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; border-radius:6px; padding:8px 12px; cursor:pointer; }
    button.secondary { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
    button.ghost { background:transparent; color:var(--vscode-textLink-foreground); border:1px solid var(--vscode-panel-border); }
    .hint { opacity:.82; margin-top:8px; line-height:1.45; }
    .warning { color: var(--vscode-editorWarning-foreground, #ffcc00); }
    .ok { color: var(--vscode-testing-iconPassed, #73c991); }
    .bad { color: var(--vscode-testing-iconFailed, #f48771); }
    .svg-box { background:var(--vscode-textCodeBlock-background); border:1px solid var(--vscode-panel-border); border-radius:8px; padding:8px; overflow:auto; }
    svg { width:100%; min-height:260px; display:block; }
    table { width:100%; border-collapse:collapse; font-family:var(--vscode-editor-font-family); font-size:12px; }
    th, td { text-align:left; border-bottom:1px solid var(--vscode-panel-border); padding:6px 8px; vertical-align:top; }
    .table-wrap { overflow:auto; max-height:420px; border:1px solid var(--vscode-panel-border); border-radius:8px; }
    .pill { display:inline-block; padding:2px 7px; border-radius:999px; background:var(--vscode-badge-background); color:var(--vscode-badge-foreground); margin:1px 3px 1px 0; }
    .small { font-size:12px; opacity:.86; }
    .mono { font-family: var(--vscode-editor-font-family); }
    .help { display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; margin-left:6px; border-radius:50%; border:1px solid var(--vscode-panel-border); color:var(--vscode-textLink-foreground); font-size:12px; font-weight:700; cursor:help; vertical-align:middle; }
    .help:hover { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
    .metric-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:8px; margin-top:8px; }
    .metric { border:1px solid var(--vscode-panel-border); border-radius:8px; padding:8px; background:var(--vscode-textCodeBlock-background); }
    .metric strong { display:block; margin-bottom:4px; }
    .legend-dot { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:5px; vertical-align:middle; }
    .svg-caption { font-size:12px; opacity:.84; margin-top:6px; }
    .help-line { margin-top:8px; padding:8px; border-left:3px solid var(--vscode-textLink-foreground); background:var(--vscode-textCodeBlock-background); border-radius:6px; line-height:1.45; }
  </style>
</head>
<body>
  <h1>Digital filter designer</h1>
  <div class="card">
    <div class="tabs">
      <button class="tab active" type="button" data-mode="design">Design / coefficients</button>
      <button class="tab" type="button" data-mode="response">Bode / phase</button>
      <button class="tab" type="button" data-mode="stability">Unit circle / stability</button>
      <button class="tab" type="button" data-mode="structures">Canonical forms</button>
      <button class="tab" type="button" data-mode="families">Filter families</button>
      <button class="tab" type="button" data-mode="ztransform">Z transform</button>
    </div>

    <section id="panelDesign">
      <h2>Design / coefficients</h2>
      <div class="grid">
        <div>
          <label for="designKind">Design method <span class="help" title="IIR biquad creates a second-order recursive section. FIR windowed-sinc creates a finite impulse response. Manual lets you paste b/a coefficients directly.">?</span></label>
          <select id="designKind">
            <option value="biquad">IIR biquad, RBJ cookbook</option>
            <option value="fir">FIR windowed sinc</option>
            <option value="manual">Manual coefficients</option>
          </select>
        </div>
        <div>
          <label for="filterType">Filter type <span class="help" title="Low/high-pass select frequency bands. Band-pass/notch use a center frequency and Q. Peaking and shelves use the gain field.">?</span></label>
          <select id="filterType">
            <option value="lowpass">Low-pass</option>
            <option value="highpass">High-pass</option>
            <option value="bandpass">Band-pass</option>
            <option value="notch">Notch / band-stop</option>
            <option value="allpass">All-pass</option>
            <option value="peaking">Peaking EQ</option>
            <option value="lowshelf">Low shelf</option>
            <option value="highshelf">High shelf</option>
          </select>
        </div>
        <div>
          <label for="sampleRate">Sample rate, Hz <span class="help" title="Sampling frequency Fs. Cutoff frequencies must stay below Fs/2, the Nyquist frequency.">?</span></label>
          <input id="sampleRate" value="48000" spellcheck="false" />
        </div>
        <div>
          <label for="f0">Cutoff / center frequency, Hz <span class="help" title="For low/high-pass this is the cutoff. For band-pass, notch and EQ this is the center frequency.">?</span></label>
          <input id="f0" value="1000" spellcheck="false" />
        </div>
        <div>
          <label for="f1">Band edge 2, Hz, FIR band filters <span class="help" title="Second band edge used by FIR band-pass and notch designs. The tool sorts f0/f1 if needed.">?</span></label>
          <input id="f1" value="3000" spellcheck="false" />
        </div>
        <div>
          <label for="qValue">Q factor <span class="help" title="Controls resonance or bandwidth. Q≈0.707 is the classic 2nd-order Butterworth value.">?</span></label>
          <input id="qValue" value="0.7071" spellcheck="false" />
        </div>
        <div>
          <label for="gainDb">Gain, dB, EQ/shelf <span class="help" title="Used by peaking EQ and shelf filters. Positive boosts, negative attenuates.">?</span></label>
          <input id="gainDb" value="0" spellcheck="false" />
        </div>
        <div>
          <label for="firTaps">FIR taps <span class="help" title="Number of FIR coefficients. More taps sharpen the transition but increase delay and CPU cost. Odd count is forced.">?</span></label>
          <input id="firTaps" value="51" spellcheck="false" />
        </div>
        <div>
          <label for="firWindow">FIR window <span class="help" title="Window function controls stopband attenuation and transition width. Hamming is a good default.">?</span></label>
          <select id="firWindow">
            <option value="hamming">Hamming</option>
            <option value="hann">Hann</option>
            <option value="blackman">Blackman</option>
            <option value="rectangular">Rectangular</option>
          </select>
        </div>
      </div>
      <div class="split">
        <div>
          <label for="bCoeffs">Numerator b coefficients <span class="help" title="Feed-forward coefficients b0, b1, ... used in H(z). For FIR, these are the taps.">?</span></label>
          <textarea id="bCoeffs" spellcheck="false"></textarea>
        </div>
        <div>
          <label for="aCoeffs">Denominator a coefficients, a0 first <span class="help" title="Recursive coefficients a0, a1, ... . The tool normalizes a0 to 1. Poles are derived from a.">?</span></label>
          <textarea id="aCoeffs" spellcheck="false">1</textarea>
        </div>
      </div>
      <div class="btn-row">
        <button id="applyDesign" type="button">Generate coefficients</button>
        <button id="normalizeCoeffs" class="secondary" type="button">Normalize a0</button>
        <button id="copyCoeffs" class="secondary" type="button">Copy coefficients</button>
        <button id="insertCoeffs" type="button">Insert coefficients</button>
      </div>
      <div id="designSummary" class="result"></div>
    </section>

    <section id="panelResponse" hidden>
      <h2>Bode magnitude and phase</h2>
      <div class="three">
        <div>
          <label for="responsePoints">Frequency points <span class="help" title="Number of samples used to evaluate H(e^jw). More points give a smoother curve.">?</span></label>
          <select id="responsePoints"><option>128</option><option selected>256</option><option>512</option><option>1024</option></select>
        </div>
        <div>
          <label for="dbFloor">dB floor <span class="help" title="Lowest magnitude displayed on the Bode plot. Values below this are clamped so deep stopbands remain readable.">?</span></label>
          <input id="dbFloor" value="-80" spellcheck="false" />
        </div>
        <div>
          <label for="phaseMode">Phase <span class="help" title="Wrapped phase stays in ±180°. Unwrapped phase removes 360° jumps to show continuous phase slope.">?</span></label>
          <select id="phaseMode"><option value="wrapped">Wrapped</option><option value="unwrapped" selected>Unwrapped</option></select>
        </div>
        <div>
          <label for="responseXAxis">Frequency axis <span class="help" title="Linear shows the full 0 → Fs/2 interval. Logarithmic expands low frequencies, which makes low cutoff filters much easier to read.">?</span></label>
          <select id="responseXAxis"><option value="linear">Linear, 0 → Nyquist</option><option value="log" selected>Logarithmic, low frequencies expanded</option></select>
        </div>
      </div>
      <div class="split">
        <div class="svg-box"><div class="small">Magnitude, dB</div><div id="magPlot"></div></div>
        <div class="svg-box"><div class="small">Phase, degrees</div><div id="phasePlot"></div></div>
      </div>
      <div id="responseSummary" class="result"></div>
      <div id="responseTrace" class="help-line">The response is evaluated from the current b/a coefficient textareas. Design changes regenerate b/a first; manual coefficient edits are used directly.</div>
    </section>

    <section id="panelStability" hidden>
      <h2>Unit circle / stability</h2>
      <div class="help-line">This tab uses the same normalized b/a coefficients as the design and Bode tabs. For a causal IIR filter, stability is decided by the poles from the denominator a(z), not by the zeros from the numerator b(z).</div>
      <div class="split">
        <div class="svg-box"><div id="poleZeroPlot"></div></div>
        <div>
          <div id="stabilitySummary" class="result"></div>
          <h3>Second-order Jury stability triangle</h3>
          <div class="svg-box"><div id="juryTrianglePlot"></div></div>
          <div id="jurySummary" class="result"></div>
          <h3>Poles / zeros</h3>
          <div class="table-wrap"><table><thead><tr><th>Type</th><th>Index</th><th>Real</th><th>Imag</th><th>|z|</th></tr></thead><tbody id="rootRows"></tbody></table></div>
        </div>
      </div>
    </section>

    <section id="panelStructures" hidden>
      <h2>Canonical forms</h2>
      <div class="grid">
        <div class="card">
          <h3>Difference equation</h3>
          <div id="differenceEquation" class="result"></div>
        </div>
        <div class="card">
          <h3>Transfer function H(z)</h3>
          <div id="transferFunction" class="result"></div>
        </div>
      </div>
      <h3>C implementation skeleton</h3>
      <textarea id="cImplementation" spellcheck="false" style="min-height:260px"></textarea>
      <div class="btn-row"><button id="copyImplementation" class="secondary" type="button">Copy implementation</button><button id="insertImplementation" type="button">Insert implementation</button></div>
      <div class="hint">The generated C uses a direct-form II transposed state layout for IIR filters, and a delay-line convolution for FIR filters. It is intentionally explicit so that coefficient signs and normalization remain visible.</div>
    </section>

    <section id="panelFamilies" hidden>
      <h2>Filter family comparison</h2>
      <div class="split">
        <div class="svg-box"><div id="familyPlot"></div></div>
        <div>
          <h3>FIR vs IIR</h3>
          <div class="table-wrap"><table>
            <thead><tr><th>Type</th><th>Principle</th><th>Strengths</th><th>Limits / warnings</th></tr></thead>
            <tbody>
              <tr><td><strong>FIR</strong><br/><span class="small">Finite Impulse Response</span></td><td>No feedback: a(z)=1. Output depends only on the current and past input samples.</td><td>Always BIBO stable with finite coefficients. Can be exactly linear phase. Simple to reason about.</td><td>Often needs many taps for a sharp transition. Adds group delay of about (N-1)/2 samples for a symmetric FIR.</td></tr>
              <tr><td><strong>IIR</strong><br/><span class="small">Infinite Impulse Response</span></td><td>Recursive feedback: denominator a(z) contains delayed outputs. Output depends on input history and output history.</td><td>Very selective filters with few coefficients. Biquads are compact and efficient for embedded C.</td><td>Can be unstable if poles leave the unit circle. Phase is usually nonlinear. Coefficient quantization matters.</td></tr>
            </tbody>
          </table></div>
          <h3>Main analog/digital design families</h3>
          <div class="table-wrap"><table>
            <thead><tr><th>Family</th><th>Strength</th><th>Trade-off</th><th>Typical use</th></tr></thead>
            <tbody>
              <tr><td>Butterworth</td><td>Maximally flat magnitude in passband.</td><td>Moderate transition; phase not linear.</td><td>General low/high-pass filtering when ripple is unwanted.</td></tr>
              <tr><td>Chebyshev I</td><td>Sharper transition than Butterworth for the same order.</td><td>Ripple in the passband.</td><td>When selectivity matters and passband ripple is acceptable.</td></tr>
              <tr><td>Chebyshev II</td><td>Flat passband with sharper transition than Butterworth.</td><td>Ripple in the stopband.</td><td>When passband flatness is important but stopband ripple is acceptable.</td></tr>
              <tr><td>Bessel</td><td>Best transient behavior / smoother group delay.</td><td>Slow transition.</td><td>Waveform preservation and measurement chains.</td></tr>
              <tr><td>Elliptic / Cauer</td><td>Sharpest transition for a given order.</td><td>Ripple in passband and stopband; more sensitive.</td><td>Tight specs with accepted ripple and careful implementation.</td></tr>
              <tr><td>FIR linear phase</td><td>Can be exactly linear phase and stable by construction.</td><td>Often needs many taps and adds delay.</td><td>Audio, data acquisition, offline DSP, predictable delay.</td></tr>
            </tbody>
          </table></div>
          <div class="hint warning">The plotted curves in this comparison tab are qualitative guide curves. Use Design / coefficients and Bode / phase for the actual filter currently designed.</div>
        </div>
      </div>
    </section>

    <section id="panelZtransform" hidden>
      <h2>Z transform reference</h2>
      <div class="split">
        <div>
          <h3>Current filter</h3>
          <div id="zCurrent" class="result"></div>
          <h3>Useful rules</h3>
          <div class="result">Linearity: a x[n] + b y[n] → a X(z) + b Y(z)\nDelay: x[n-k] → z^-k X(z)\nDifference equation: y[n] + a1 y[n-1] + … = b0 x[n] + b1 x[n-1] + …\nStability, causal IIR: every pole must be strictly inside the unit circle.</div>
        </div>
        <div>
          <h3>Common pairs</h3>
          <div class="table-wrap"><table>
            <thead><tr><th>Sequence</th><th>Z transform</th><th>ROC / note</th></tr></thead>
            <tbody>
              <tr><td>δ[n]</td><td>1</td><td>All z</td></tr>
              <tr><td>δ[n-k]</td><td>z^-k</td><td>Delay by k samples</td></tr>
              <tr><td>u[n]</td><td>1 / (1 - z^-1)</td><td>|z| &gt; 1</td></tr>
              <tr><td>a^n u[n]</td><td>1 / (1 - a z^-1)</td><td>|z| &gt; |a|</td></tr>
              <tr><td>n a^n u[n]</td><td>a z^-1 / (1 - a z^-1)^2</td><td>Repeated pole</td></tr>
              <tr><td>cos(ω0 n)u[n]</td><td>(1 - cosω0 z^-1) / (1 - 2cosω0 z^-1 + z^-2)</td><td>Complex-conjugate poles</td></tr>
              <tr><td>sin(ω0 n)u[n]</td><td>sinω0 z^-1 / (1 - 2cosω0 z^-1 + z^-2)</td><td>Complex-conjugate poles</td></tr>
            </tbody>
          </table></div>
        </div>
      </div>
    </section>
  </div>

  <script>
    (function(){
      'use strict';
      const vscode = acquireVsCodeApi();
      const seedText = ${JSON.stringify(initialText || '')};
      const $ = function(id){ return document.getElementById(id); };
      function help(text){ return '<span class="help" title="'+String(text).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')+'">?</span>'; }
      const EPS = 1e-12;
      function clamp(x,a,b){ x=Number(x); return Math.max(a, Math.min(b, Number.isFinite(x)?x:a)); }
      function fmt(x, digits){ if(!Number.isFinite(x)) return 'NaN'; const d = digits === undefined ? 8 : digits; let s = Number(x).toPrecision(d); s = s.replace(/\\.0+(e|$)/, '$1').replace(/(\\.\\d*?)0+(e|$)/, '$1$2'); return s; }
      function parseNumber(x, fallback){ const n = Number(String(x || '').trim().replace(',', '.')); return Number.isFinite(n) ? n : fallback; }
      function parseCoeffs(text){ const matches = String(text || '').match(/[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?/g); const out = (matches || []).map(Number).filter(Number.isFinite); return out.length ? out : [0]; }
      function coeffText(values){ return values.map(function(v){ return fmt(v, 12); }).join(', '); }
      function sinc(x){ if(Math.abs(x) < 1e-12) return 1; return Math.sin(Math.PI*x)/(Math.PI*x); }
      function windowValue(kind, n, N){ if(N <= 1) return 1; const a = 2*Math.PI*n/(N-1); if(kind === 'hann') return 0.5 - 0.5*Math.cos(a); if(kind === 'blackman') return 0.42 - 0.5*Math.cos(a) + 0.08*Math.cos(2*a); if(kind === 'rectangular') return 1; return 0.54 - 0.46*Math.cos(a); }
      function normalizeBA(b,a){ a = a && a.length ? a.slice() : [1]; b = b && b.length ? b.slice() : [0]; const a0 = Math.abs(a[0]) < EPS ? 1 : a[0]; return { b: b.map(function(x){ return x/a0; }), a: a.map(function(x){ return x/a0; }) }; }
      function designBiquad(type, fs, f0, Q, gainDb){
        fs = Math.max(1, fs); f0 = clamp(f0, 0.0001, fs/2 - 0.0001); Q = Math.max(0.0001, Q);
        const A = Math.pow(10, gainDb/40); const w0 = 2*Math.PI*f0/fs; const cosw = Math.cos(w0); const sinw = Math.sin(w0); let alpha = sinw/(2*Q);
        let b0=1,b1=0,b2=0,a0=1,a1=0,a2=0;
        if(type === 'lowpass'){ b0=(1-cosw)/2; b1=1-cosw; b2=(1-cosw)/2; a0=1+alpha; a1=-2*cosw; a2=1-alpha; }
        else if(type === 'highpass'){ b0=(1+cosw)/2; b1=-(1+cosw); b2=(1+cosw)/2; a0=1+alpha; a1=-2*cosw; a2=1-alpha; }
        else if(type === 'bandpass'){ b0=alpha; b1=0; b2=-alpha; a0=1+alpha; a1=-2*cosw; a2=1-alpha; }
        else if(type === 'notch'){ b0=1; b1=-2*cosw; b2=1; a0=1+alpha; a1=-2*cosw; a2=1-alpha; }
        else if(type === 'allpass'){ b0=1-alpha; b1=-2*cosw; b2=1+alpha; a0=1+alpha; a1=-2*cosw; a2=1-alpha; }
        else if(type === 'peaking'){ b0=1+alpha*A; b1=-2*cosw; b2=1-alpha*A; a0=1+alpha/A; a1=-2*cosw; a2=1-alpha/A; }
        else {
          const sqrtA = Math.sqrt(A); alpha = sinw/2 * Math.sqrt((A + 1/A)*(1/Q - 1) + 2);
          if(type === 'lowshelf'){
            b0=A*((A+1)-(A-1)*cosw+2*sqrtA*alpha); b1=2*A*((A-1)-(A+1)*cosw); b2=A*((A+1)-(A-1)*cosw-2*sqrtA*alpha);
            a0=(A+1)+(A-1)*cosw+2*sqrtA*alpha; a1=-2*((A-1)+(A+1)*cosw); a2=(A+1)+(A-1)*cosw-2*sqrtA*alpha;
          } else {
            b0=A*((A+1)+(A-1)*cosw+2*sqrtA*alpha); b1=-2*A*((A-1)+(A+1)*cosw); b2=A*((A+1)+(A-1)*cosw-2*sqrtA*alpha);
            a0=(A+1)-(A-1)*cosw+2*sqrtA*alpha; a1=2*((A-1)-(A+1)*cosw); a2=(A+1)-(A-1)*cosw-2*sqrtA*alpha;
          }
        }
        return normalizeBA([b0,b1,b2],[a0,a1,a2]);
      }
      function lowpassFir(fc, fs, taps, win){ const N=taps|0, M=(N-1)/2, out=[]; const norm=clamp(fc/fs, 0.000001, 0.499999); for(let n=0;n<N;n++){ const k=n-M; out.push(2*norm*sinc(2*norm*k)*windowValue(win,n,N)); } return out; }
      function normalizeFirDc(b){ const s=b.reduce(function(a,x){return a+x;},0); if(Math.abs(s)>EPS) return b.map(function(x){return x/s;}); return b; }
      function designFir(type, fs, f0, f1, taps, win){ taps = Math.max(3, Math.min(501, Math.round(taps))); if(taps % 2 === 0) taps += 1; fs = Math.max(1, fs); f0=clamp(f0,1e-6,fs/2-1e-6); f1=clamp(f1,1e-6,fs/2-1e-6); if(f1 < f0){ const t=f0; f0=f1; f1=t; }
        let b=[]; const lp0 = lowpassFir(f0,fs,taps,win), lp1=lowpassFir(f1,fs,taps,win), mid=(taps-1)/2;
        if(type === 'highpass'){ b = lp0.map(function(v,i){ return (i===mid?1:0)-v; }); }
        else if(type === 'bandpass'){ b = lp1.map(function(v,i){ return v-lp0[i]; }); }
        else if(type === 'notch'){ b = lp1.map(function(v,i){ return (i===mid?1:0)-(v-lp0[i]); }); }
        else { b = normalizeFirDc(lp0); }
        return { b:b, a:[1] };
      }
      function currentDesigned(){
        const kind = $('designKind').value; if(kind === 'manual') return normalizeBA(parseCoeffs($('bCoeffs').value), parseCoeffs($('aCoeffs').value));
        const fs=parseNumber($('sampleRate').value,48000), f0=parseNumber($('f0').value,1000), f1=parseNumber($('f1').value,3000), Q=parseNumber($('qValue').value,0.7071), g=parseNumber($('gainDb').value,0), taps=parseNumber($('firTaps').value,51);
        if(kind === 'fir') return designFir($('filterType').value, fs, f0, f1, taps, $('firWindow').value);
        return designBiquad($('filterType').value, fs, f0, Q, g);
      }
      function applyDesignToText(){ const d=currentDesigned(); $('bCoeffs').value=coeffText(d.b); $('aCoeffs').value=coeffText(d.a); updateAll(); }
      function c(re,im){ return {re:re, im:im}; } function cadd(a,b){return c(a.re+b.re,a.im+b.im);} function csub(a,b){return c(a.re-b.re,a.im-b.im);} function cmul(a,b){return c(a.re*b.re-a.im*b.im,a.re*b.im+a.im*b.re);} function cdiv(a,b){const d=b.re*b.re+b.im*b.im || EPS; return c((a.re*b.re+a.im*b.im)/d,(a.im*b.re-a.re*b.im)/d);} function cabs(a){return Math.hypot(a.re,a.im);} function cpowReal(theta){return c(Math.cos(theta), Math.sin(theta));}
      function evalPoly(coeffs,z){ let y=c(0,0); for(let i=0;i<coeffs.length;i++){ y=cmul(y,z); y=cadd(y,c(coeffs[i],0)); } return y; }
      function roots(coeffs){
        coeffs=(coeffs||[]).slice().filter(Number.isFinite);
        while(coeffs.length>1 && Math.abs(coeffs[0])<EPS) coeffs.shift();
        const n=coeffs.length-1;
        if(n<=0) return [];
        if(n===1) return [c(-coeffs[1]/coeffs[0],0)];
        if(n===2){
          const A=coeffs[0], B=coeffs[1], C=coeffs[2];
          if(Math.abs(A)<EPS) return roots([B,C]);
          const disc=B*B-4*A*C;
          if(disc>=0){ const s=Math.sqrt(disc); return [c((-B+s)/(2*A),0), c((-B-s)/(2*A),0)]; }
          const s=Math.sqrt(-disc); return [c(-B/(2*A), s/(2*A)), c(-B/(2*A), -s/(2*A))];
        }
        coeffs=coeffs.map(function(x){return x/coeffs[0];});
        let r=[]; const radius=1+Math.max.apply(null, coeffs.slice(1).map(Math.abs));
        for(let i=0;i<n;i++){ const a=2*Math.PI*(i+0.5)/n; r.push(c(radius*Math.cos(a), radius*Math.sin(a))); }
        for(let iter=0;iter<220;iter++){ let maxDelta=0; for(let i=0;i<n;i++){ let denom=c(1,0); for(let j=0;j<n;j++) if(i!==j) denom=cmul(denom,csub(r[i],r[j])); if(cabs(denom)<EPS) denom=c(EPS,EPS); const delta=cdiv(evalPoly(coeffs,r[i]),denom); r[i]=csub(r[i],delta); maxDelta=Math.max(maxDelta,cabs(delta)); } if(maxDelta<1e-10) break; }
        return r.filter(function(z){ return Number.isFinite(z.re) && Number.isFinite(z.im); });
      }
      function rootInfo(coeffs, maxDegree){
        const clean=(coeffs||[]).slice().filter(Number.isFinite); let degree=clean.length-1;
        while(clean.length>1 && Math.abs(clean[0])<EPS){ clean.shift(); degree=clean.length-1; }
        if(degree<=0) return {roots:[], skipped:false, degree:0};
        if(degree>maxDegree) return {roots:[], skipped:true, degree:degree};
        return {roots:roots(clean), skipped:false, degree:degree};
      }
      function evalResponseAtHz(b,a,hz,fs){ const w=2*Math.PI*hz/Math.max(fs,1); let num=c(0,0), den=c(0,0); for(let k=0;k<b.length;k++){ num=cadd(num, cmul(c(b[k],0), cpowReal(-w*k))); } for(let k=0;k<a.length;k++){ den=cadd(den, cmul(c(a[k],0), cpowReal(-w*k))); } const h=cdiv(num,den); return {w:w, hz:hz, mag:cabs(h), phase:Math.atan2(h.im,h.re)}; }
      function freqResponse(b,a,N,axis){ const out=[]; const fs=parseNumber($('sampleRate').value,48000); const nyq=fs/2; const logAxis=axis==='log'; const minHz=Math.max(0.1, nyq/10000); for(let i=0;i<N;i++){ let hz; if(logAxis){ hz=minHz*Math.pow(nyq/minHz, i/Math.max(1,N-1)); } else { hz=nyq*i/Math.max(1,N-1); } out.push(evalResponseAtHz(b,a,hz,fs)); } return out; }
      function unwrap(ph){ const out=[]; let prev=ph.length?ph[0]:0, off=0; for(const p of ph){ let v=p+off; while(v-prev>Math.PI){off-=2*Math.PI; v=p+off;} while(v-prev<-Math.PI){off+=2*Math.PI; v=p+off;} out.push(v); prev=v; } return out; }
      function finiteRange(values, fallbackMin, fallbackMax){
        const finite = values.filter(Number.isFinite);
        if(!finite.length) return {min:fallbackMin, max:fallbackMax};
        let min=Math.min.apply(null,finite), max=Math.max.apply(null,finite);
        if(Math.abs(max-min)<1e-9){ const pad=Math.max(1, Math.abs(max)*0.08); min-=pad; max+=pad; }
        return {min:min, max:max};
      }
      function niceStep(span){ const raw=span/4; const pow=Math.pow(10, Math.floor(Math.log10(Math.max(raw,1e-12)))); const n=raw/pow; const m=n<=1?1:n<=2?2:n<=5?5:10; return m*pow; }
      function svgLine(data, opts){
        const W=760,H=300,padL=54,padR=20,padT=30,padB=42;
        let minY=opts.minY, maxY=opts.maxY;
        if(!Number.isFinite(minY) || !Number.isFinite(maxY) || Math.abs(maxY-minY)<1e-12){ const r=finiteRange(data,-1,1); minY=r.min; maxY=r.max; }
        const span=maxY-minY || 1;
        const step=niceStep(span);
        const y0=Math.floor(minY/step)*step;
        const y1=Math.ceil(maxY/step)*step;
        minY=y0; maxY=y1; const plotW=W-padL-padR, plotH=H-padT-padB;
        function x(i){return padL+i*plotW/Math.max(1,data.length-1);}
        function y(v){return padT+(maxY-v)*plotH/(maxY-minY || 1);}
        let grid='';
        for(let gy=minY; gy<=maxY+step*0.2; gy+=step){ const yy=y(gy); grid+='<line x1="'+padL+'" y1="'+yy.toFixed(1)+'" x2="'+(W-padR)+'" y2="'+yy.toFixed(1)+'" stroke="var(--vscode-panel-border)" opacity="0.55"/><text x="6" y="'+(yy+4).toFixed(1)+'" fill="currentColor" font-size="10">'+fmt(gy,5)+'</text>'; }
        const samples=data.map(function(v){ return Number.isFinite(v)?v:minY; });
        let d=''; samples.forEach(function(v,i){ d += (i?'L':'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1) + ' '; });
        let xgrid='';
        if(opts.xTicks && opts.xTicks.length){ opts.xTicks.forEach(function(t){ const xx=x(t.index); xgrid+='<line x1="'+xx.toFixed(1)+'" y1="'+padT+'" x2="'+xx.toFixed(1)+'" y2="'+(H-padB)+'" stroke="var(--vscode-panel-border)" opacity="0.38"/><text x="'+(xx-16).toFixed(1)+'" y="'+(H-20)+'" fill="currentColor" font-size="10">'+t.label+'</text>'; }); }
        const zero = minY<0 && maxY>0 ? '<line x1="'+padL+'" y1="'+y(0).toFixed(1)+'" x2="'+(W-padR)+'" y2="'+y(0).toFixed(1)+'" stroke="var(--vscode-editorWarning-foreground, #ffcc00)" opacity="0.5" />' : '';
        let marker=''; if(Number.isFinite(opts.markerIndex)){ const mx=x(Math.max(0,Math.min(data.length-1,opts.markerIndex))); marker='<line x1="'+mx.toFixed(1)+'" y1="'+padT+'" x2="'+mx.toFixed(1)+'" y2="'+(H-padB)+'" stroke="var(--vscode-editorWarning-foreground, #ffcc00)" stroke-width="1.5" opacity="0.85"/><text x="'+(mx+4).toFixed(1)+'" y="'+(padT+14)+'" fill="currentColor" font-size="10">'+(opts.markerLabel||'f0')+'</text>'; }
        return '<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none"><rect x="0" y="0" width="'+W+'" height="'+H+'" fill="transparent"/>'+grid+xgrid+'<line x1="'+padL+'" y1="'+(H-padB)+'" x2="'+(W-padR)+'" y2="'+(H-padB)+'" stroke="var(--vscode-panel-border)"/><line x1="'+padL+'" y1="'+padT+'" x2="'+padL+'" y2="'+(H-padB)+'" stroke="var(--vscode-panel-border)"/>'+zero+marker+'<path d="'+d+'" fill="none" stroke="var(--vscode-charts-blue)" stroke-width="2.4"/><text x="'+padL+'" y="18" fill="currentColor" font-size="11">'+opts.label+'</text><text x="'+(W-padR-250)+'" y="'+(H-8)+'" fill="currentColor" font-size="11">'+(opts.xLabel||'frequency')+'</text></svg>';
      }
      function nearestIndex(resp, hz){ let best=0, err=Infinity; resp.forEach(function(r,i){ const e=Math.abs(r.hz-hz); if(e<err){err=e; best=i;} }); return best; }
      function hzLabel(hz){ if(!Number.isFinite(hz)) return ''; if(hz>=1000) return fmt(hz/1000,4)+' k'; return fmt(hz,4); }
      function makeXTicks(resp, axis){ if(!resp.length) return []; const out=[]; if(axis==='log'){ const min=Math.max(resp[0].hz,1e-9), max=resp[resp.length-1].hz; let p=Math.pow(10, Math.ceil(Math.log10(min))); while(p<max){ out.push({index:nearestIndex(resp,p), label:hzLabel(p)}); p*=10; } } else { [0,0.25,0.5,0.75,1].forEach(function(t){ const i=Math.round(t*(resp.length-1)); out.push({index:i,label:hzLabel(resp[i].hz)}); }); } return out; }
      function updatePlots(){
        const d=normalizeBA(parseCoeffs($('bCoeffs').value), parseCoeffs($('aCoeffs').value));
        const N=parseInt($('responsePoints').value,10)||256; const floor=parseNumber($('dbFloor').value,-80); const axis=$('responseXAxis') ? $('responseXAxis').value : 'linear'; const resp=freqResponse(d.b,d.a,N,axis);
        const fs=parseNumber($('sampleRate').value,48000), nyq=fs/2;
        const rawMags=resp.map(function(r){return 20*Math.log10(Math.max(1e-14,r.mag));});
        const mags=rawMags.map(function(v){return Math.max(floor, v);});
        let phases=resp.map(function(r){return r.phase;}); if($('phaseMode').value==='unwrapped') phases=unwrap(phases); phases=phases.map(function(p){return p*180/Math.PI;});
        const magRange=finiteRange(mags, floor, 6); let minMag=Math.max(floor, magRange.min), maxMag=magRange.max;
        if(maxMag-minMag<12){ const c=(maxMag+minMag)/2; minMag=Math.max(floor,c-6); maxMag=c+6; }
        maxMag=Math.max(maxMag, 3);
        const markerHz=clamp(parseNumber($('f0').value,0),0,nyq); const markerIndex=nearestIndex(resp, markerHz); const xLabel=(axis==='log'?'log frequency ':'linear frequency ')+'· Fs/2 = '+fmt(nyq,7)+' Hz'; const xTicks=makeXTicks(resp,axis);
        $('magPlot').innerHTML=svgLine(mags,{minY:minMag,maxY:maxMag,label:'Magnitude in dB',xLabel:xLabel,xTicks:xTicks,markerIndex:markerIndex,markerLabel:'f0 '+hzLabel(markerHz)});
        const phaseRange=finiteRange(phases,-180,180); let minP=phaseRange.min, maxP=phaseRange.max; if(maxP-minP<45){ const c=(minP+maxP)/2; minP=c-22.5; maxP=c+22.5; }
        $('phasePlot').innerHTML=svgLine(phases,{minY:minP,maxY:maxP,label:'Phase in degrees',xLabel:xLabel,xTicks:xTicks,markerIndex:markerIndex,markerLabel:'f0 '+hzLabel(markerHz)});
        const peak=Math.max.apply(null,mags); const idx=mags.indexOf(peak); const dc=evalResponseAtHz(d.b,d.a,0,fs), nq=evalResponseAtHz(d.b,d.a,nyq,fs); const dcDb=20*Math.log10(Math.max(1e-14,dc.mag)), nqDb=20*Math.log10(Math.max(1e-14,nq.mag));
        $('responseSummary').innerHTML='<div class="metric-grid"><div class="metric"><strong>Peak on plotted grid</strong>'+fmt(peak,6)+' dB at '+fmt(resp[idx].hz,7)+' Hz</div><div class="metric"><strong>DC gain</strong>'+fmt(Math.max(floor,dcDb),6)+' dB</div><div class="metric"><strong>Nyquist gain</strong>'+fmt(Math.max(floor,nqDb),6)+' dB</div><div class="metric"><strong>Cutoff / center marker</strong>'+fmt(markerHz,7)+' Hz</div><div class="metric"><strong>Source</strong>current b/a textareas</div><div class="metric"><strong>Axis</strong>'+(axis==='log'?'logarithmic':'linear')+'</div></div>';
        if($('responseTrace')) $('responseTrace').innerHTML='Bode and phase use the normalized coefficients currently shown in <span class="mono">b</span> and <span class="mono">a</span>. b length = '+d.b.length+', a length = '+d.a.length+'. Last coefficient snapshot:<br/><span class="mono">b = ['+coeffText(d.b)+']</span><br/><span class="mono">a = ['+coeffText(d.a)+']</span>';
      }
      function updateJuryTriangle(a){
        const W=460,H=330,pad=48,cx=W/2,top=42,bottom=H-48,left=pad,right=W-pad;
        const a1 = a.length>1 ? a[1] : 0, a2 = a.length>2 ? a[2] : 0;
        function x(v){ return cx + v/2*(right-left)/2; }
        function y(v){ return top + (1-v)/2*(bottom-top); }
        const inSecondOrder = a.length===3;
        const c1 = 1 + a1 + a2, c2 = 1 - a1 + a2, c3 = 1 - a2;
        const juryStable = inSecondOrder && c1>0 && c2>0 && c3>0;
        let px=x(Math.max(-2.2,Math.min(2.2,a1))), py=y(Math.max(-1.2,Math.min(1.2,a2)));
        let svg='<svg viewBox="0 0 '+W+' '+H+'"><rect width="'+W+'" height="'+H+'" fill="transparent"/>';
        for(let tx=-2; tx<=2; tx+=1){ const xx=x(tx); svg+='<line x1="'+xx.toFixed(1)+'" y1="'+top+'" x2="'+xx.toFixed(1)+'" y2="'+bottom+'" stroke="var(--vscode-panel-border)" opacity="0.32"/><text x="'+(xx-6).toFixed(1)+'" y="'+(bottom+18)+'" fill="currentColor" font-size="10">'+tx+'</text>'; }
        for(let ty=-1; ty<=1.0001; ty+=0.5){ const yy=y(ty); svg+='<line x1="'+left+'" y1="'+yy.toFixed(1)+'" x2="'+right+'" y2="'+yy.toFixed(1)+'" stroke="var(--vscode-panel-border)" opacity="0.32"/><text x="12" y="'+(yy+4).toFixed(1)+'" fill="currentColor" font-size="10">'+fmt(ty,3)+'</text>'; }
        svg+='<line x1="'+left+'" y1="'+y(0)+'" x2="'+right+'" y2="'+y(0)+'" stroke="var(--vscode-panel-border)"/><line x1="'+cx+'" y1="'+top+'" x2="'+cx+'" y2="'+bottom+'" stroke="var(--vscode-panel-border)"/>';
        svg+='<polygon points="'+x(-2)+','+y(1)+' '+x(2)+','+y(1)+' '+x(0)+','+y(-1)+'" fill="var(--vscode-charts-yellow)" opacity="0.12" stroke="var(--vscode-charts-yellow)" stroke-width="2"/>';
        svg+='<text x="'+(right-26)+'" y="'+(y(0)-8)+'" fill="currentColor" font-size="11">a1</text><text x="'+(cx+8)+'" y="'+(top+14)+'" fill="currentColor" font-size="11">a2</text><text x="'+(left+8)+'" y="24" fill="currentColor" font-size="11">Jury stable area for 1 + a1 z^-1 + a2 z^-2</text>';
        svg+='<circle cx="'+px.toFixed(1)+'" cy="'+py.toFixed(1)+'" r="6" fill="'+(juryStable?'var(--vscode-testing-iconPassed, #73c991)':'var(--vscode-testing-iconFailed, #f48771)')+'" stroke="currentColor"/><text x="'+(px+9).toFixed(1)+'" y="'+(py-8).toFixed(1)+'" fill="currentColor" font-size="10">current a1/a2</text>';
        svg+='</svg>';
        $('juryTrianglePlot').innerHTML=svg;
        if(!inSecondOrder){ $('jurySummary').innerHTML='Jury triangle is specific to a normalized second-order denominator <span class="mono">1 + a1 z^-1 + a2 z^-2</span>. Current denominator order: '+Math.max(0,a.length-1)+'.'; return; }
        $('jurySummary').innerHTML='<strong class="'+(juryStable?'ok':'bad')+'">'+(juryStable?'Inside Jury triangle: stable second-order section':'Outside Jury triangle: unstable or marginal second-order section')+'</strong><br/>a1 = '+fmt(a1,8)+', a2 = '+fmt(a2,8)+'<br/>Conditions: 1+a1+a2 = '+fmt(c1,8)+' &gt; 0, 1-a1+a2 = '+fmt(c2,8)+' &gt; 0, 1-a2 = '+fmt(c3,8)+' &gt; 0.';
      }
      function updateStability(){
        const d=normalizeBA(parseCoeffs($('bCoeffs').value), parseCoeffs($('aCoeffs').value)); const poleInfo=rootInfo(d.a,48), zeroInfo=rootInfo(d.b,48); const poles=poleInfo.roots, zeros=zeroInfo.roots; const stable=!poleInfo.skipped && poles.every(function(p){return cabs(p)<1-1e-9;});
        const allRoots=poles.concat(zeros); const maxR=Math.max(1.2, allRoots.length ? Math.max.apply(null, allRoots.map(cabs).map(function(x){return Math.ceil(x*10)/10;})) : 1.2); const W=420,H=420,cx=W/2,cy=H/2,R=155/maxR; let svg='<svg viewBox="0 0 '+W+' '+H+'"><rect width="'+W+'" height="'+H+'" fill="transparent"/>';
        [0.5,1].forEach(function(rr){ svg+='<circle cx="'+cx+'" cy="'+cy+'" r="'+(rr*R).toFixed(1)+'" fill="none" stroke="var(--vscode-panel-border)" opacity="'+(rr===1?'0.95':'0.42')+'" stroke-width="'+(rr===1?'2':'1')+'"/>'; });
        for(let tx=-Math.floor(maxR); tx<=Math.ceil(maxR); tx+=0.5){ if(Math.abs(tx)>maxR+1e-9) continue; const xx=cx+tx*R; const strong=Math.abs(tx%1)<1e-9; svg+='<line x1="'+xx.toFixed(1)+'" y1="'+(cy-4)+'" x2="'+xx.toFixed(1)+'" y2="'+(cy+4)+'" stroke="currentColor" opacity="0.7"/>'; if(strong && Math.abs(tx)>EPS) svg+='<text x="'+(xx-7).toFixed(1)+'" y="'+(cy+18)+'" fill="currentColor" font-size="10">'+fmt(tx,3)+'</text>'; }
        for(let ty=-Math.floor(maxR); ty<=Math.ceil(maxR); ty+=0.5){ if(Math.abs(ty)>maxR+1e-9 || Math.abs(ty)<EPS) continue; const yy=cy-ty*R; const strong=Math.abs(ty%1)<1e-9; svg+='<line x1="'+(cx-4)+'" y1="'+yy.toFixed(1)+'" x2="'+(cx+4)+'" y2="'+yy.toFixed(1)+'" stroke="currentColor" opacity="0.7"/>'; if(strong) svg+='<text x="'+(cx+8)+'" y="'+(yy+4).toFixed(1)+'" fill="currentColor" font-size="10">'+fmt(ty,3)+'</text>'; }
        svg+='<line x1="20" y1="'+cy+'" x2="'+(W-20)+'" y2="'+cy+'" stroke="var(--vscode-panel-border)"/><line x1="'+cx+'" y1="20" x2="'+cx+'" y2="'+(H-20)+'" stroke="var(--vscode-panel-border)"/><text x="'+(cx+R+4).toFixed(1)+'" y="'+(cy-6)+'" fill="currentColor" font-size="10">|z|=1</text>';
        zeros.forEach(function(z){ const x=cx+z.re*R,y=cy-z.im*R; svg+='<circle cx="'+x.toFixed(1)+'" cy="'+y.toFixed(1)+'" r="6" fill="none" stroke="var(--vscode-charts-blue)" stroke-width="2"/>'; });
        poles.forEach(function(p){ const x=cx+p.re*R,y=cy-p.im*R; svg+='<path d="M '+(x-6).toFixed(1)+' '+(y-6).toFixed(1)+' L '+(x+6).toFixed(1)+' '+(y+6).toFixed(1)+' M '+(x+6).toFixed(1)+' '+(y-6).toFixed(1)+' L '+(x-6).toFixed(1)+' '+(y+6).toFixed(1)+'" stroke="var(--vscode-charts-red)" stroke-width="2"/>'; });
        svg+='<text x="12" y="20" fill="currentColor" font-size="12">o zeros · x poles · graduated unit circle</text></svg>'; $('poleZeroPlot').innerHTML=svg;
        const maxPole=poles.length?Math.max.apply(null,poles.map(cabs)):0; const skipMsg=(zeroInfo.skipped||poleInfo.skipped)?'<div class="warning">Root display is limited to degree 48. '+(zeroInfo.skipped?'Zeros skipped: numerator degree '+zeroInfo.degree+'. ':'')+(poleInfo.skipped?'Poles skipped: denominator degree '+poleInfo.degree+'. ':'')+'</div>':'';
        $('stabilitySummary').innerHTML = '<div class="'+(stable?'ok':'bad')+'"><strong>'+(stable?'Stable':'Unstable, marginal, or not fully evaluated')+'</strong></div><div>Current source: normalized coefficients from the b/a textareas.</div><div>For a causal IIR digital filter, every pole must be strictly inside the unit circle: |p| &lt; 1.</div><div>Poles: '+poles.length+(poleInfo.skipped?' / skipped high order':'')+' · zeros: '+zeros.length+(zeroInfo.skipped?' / skipped high order':'')+' · max pole radius: '+fmt(maxPole,8)+'</div><div>FIR filters with a(z)=1 have no feedback poles; they are BIBO stable when coefficients are finite. The plotted FIR roots are zeros, not stability poles.</div>'+skipMsg+'<div class="svg-caption"><span class="legend-dot" style="border:2px solid var(--vscode-charts-blue)"></span>zeros · <span class="legend-dot" style="background:var(--vscode-charts-red)"></span>poles · unit circle = |z|=1.</div>';
        const rows=[]; zeros.forEach(function(z,i){ rows.push(['zero',i,z]); }); poles.forEach(function(z,i){ rows.push(['pole',i,z]); }); $('rootRows').innerHTML=rows.map(function(r){return '<tr><td>'+r[0]+'</td><td>'+r[1]+'</td><td>'+fmt(r[2].re,8)+'</td><td>'+fmt(r[2].im,8)+'</td><td>'+fmt(cabs(r[2]),8)+'</td></tr>';}).join('') || '<tr><td colspan="5">No finite roots to display. Constant numerator/denominator, or root display skipped for high order.</td></tr>'; updateJuryTriangle(d.a);
      }
      function polyExpr(name, coeffs){ return coeffs.map(function(v,i){ const t=fmt(v,8); return i===0 ? t : t+' z^-'+i; }).join(' + ').split('+ -').join('- '); }
      function updateStructures(){ const d=normalizeBA(parseCoeffs($('bCoeffs').value), parseCoeffs($('aCoeffs').value)); const b=d.b,a=d.a; let eq='y[n] = '; eq += b.map(function(v,i){return fmt(v,8)+' x[n-'+i+']';}).join(' + '); for(let i=1;i<a.length;i++){ eq += ' - ('+fmt(a[i],8)+') y[n-'+i+']'; } $('differenceEquation').textContent=eq; const H='H(z) = ('+polyExpr('b',b)+') / ('+polyExpr('a',a)+')'; $('transferFunction').textContent=H; $('zCurrent').textContent=H+'\\n\\nPoles are roots of the denominator after multiplying by z^N. Zeros are roots of the numerator.'; const order=Math.max(b.length,a.length)-1; let code=[]; code.push('/* Generated by CVI digital filter designer. Coefficients are normalized with a0 = 1. */'); code.push('#include <stddef.h>'); code.push(''); code.push('static const double b[] = { '+coeffText(b)+' };'); code.push('static const double a[] = { '+coeffText(a)+' };'); code.push(''); if(a.length<=1){ code.push('typedef struct { double x['+Math.max(1,b.length)+']; } FirFilter;'); code.push('double fir_step(FirFilter *s, double x)'); code.push('{'); code.push('    for (size_t i = '+(b.length-1)+'; i > 0; --i) s->x[i] = s->x[i - 1];'); code.push('    s->x[0] = x;'); code.push('    double y = 0.0;'); code.push('    for (size_t i = 0; i < '+b.length+'; ++i) y += b[i] * s->x[i];'); code.push('    return y;'); code.push('}'); } else { code.push('typedef struct { double w['+Math.max(1,order)+']; } IirFilter;'); code.push('double iir_step(IirFilter *s, double x)'); code.push('{'); code.push('    double y = b[0] * x + s->w[0];'); for(let i=1;i<order;i++){ code.push('    s->w['+(i-1)+'] = b['+i+'] * x - a['+i+'] * y + s->w['+i+'];'); } code.push('    s->w['+(order-1)+'] = '+(b.length>order ? 'b['+order+'] * x' : '0.0')+' - '+(a.length>order ? 'a['+order+'] * y' : '0.0')+';'); code.push('    return y;'); code.push('}'); } $('cImplementation').value=code.join('\\n'); }
      function familyComparison(){ const W=720,H=300,pad=36; const xs=[]; for(let i=0;i<240;i++) xs.push(i/239*2.4); function ydb(db){ const min=-70,max=6; return H-pad-(Math.max(min,Math.min(max,db))-min)*(H-2*pad)/(max-min); } function xmap(x){return pad+x/2.4*(W-2*pad);} function curve(fn){ let d=''; xs.forEach(function(x,i){ const db=fn(x); d+=(i?'L':'M')+xmap(x).toFixed(1)+' '+ydb(db).toFixed(1)+' '; }); return d; } const curves=[['Butterworth','var(--vscode-charts-pink)',function(x){return 20*Math.log10(1/Math.sqrt(1+Math.pow(Math.max(x,1e-6),8)));}],['Bessel','var(--vscode-charts-blue)',function(x){return -8*Math.log10(1+Math.pow(x,3.2));}],['Chebyshev','var(--vscode-charts-green)',function(x){return x<1 ? -1.2*Math.pow(Math.cos(8*x),2) : -10*Math.log10(1+Math.pow(x,10));}],['Elliptic','var(--vscode-charts-red)',function(x){return x<1 ? -0.8*Math.pow(Math.sin(10*x),2) : -18*Math.log10(1+Math.pow(x,9));}],['FIR linear phase','var(--vscode-charts-purple)',function(x){return x<0.92 ? -0.05 : -24*Math.log10(1+Math.pow(Math.max(0,x-0.9)*4,3));}]]; let svg='<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none"><rect width="'+W+'" height="'+H+'" fill="transparent"/><line x1="'+pad+'" y1="'+(H-pad)+'" x2="'+(W-pad)+'" y2="'+(H-pad)+'" stroke="var(--vscode-panel-border)"/><line x1="'+pad+'" y1="'+pad+'" x2="'+pad+'" y2="'+(H-pad)+'" stroke="var(--vscode-panel-border)"/>'; curves.forEach(function(cu,idx){svg+='<path d="'+curve(cu[2])+'" fill="none" stroke="'+cu[1]+'" stroke-width="2"/><text x="'+(pad+10)+'" y="'+(25+idx*16)+'" fill="'+cu[1]+'" font-size="12">'+cu[0]+'</text>';}); svg+='<text x="'+(W-pad-160)+'" y="'+(H-10)+'" fill="currentColor" font-size="11">normalized frequency</text></svg>'; $('familyPlot').innerHTML=svg; }
      function updateDesignSummary(){ const d=normalizeBA(parseCoeffs($('bCoeffs').value), parseCoeffs($('aCoeffs').value)); const kind = d.a.length <= 1 ? 'FIR / non-recursive' : 'IIR / recursive'; $('designSummary').textContent = kind+'\\nOrder numerator: '+(d.b.length-1)+'\\nOrder denominator: '+(d.a.length-1)+'\\nb = ['+coeffText(d.b)+']\\na = ['+coeffText(d.a)+']'; }
      function updateAll(){ updateDesignSummary(); updatePlots(); updateStability(); updateStructures(); familyComparison(); }
      function copyText(text){ try{ if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text || ''); }catch(e){} vscode.postMessage({ type:'copyFilterValue', text:text || '' }); }
      function insertText(text){ vscode.postMessage({ type:'insertFilterValue', text:text || '' }); }
      document.querySelectorAll('.tab').forEach(function(button){ button.addEventListener('click', function(){ const mode=button.getAttribute('data-mode')||'design'; document.querySelectorAll('.tab').forEach(function(b){b.classList.toggle('active', b===button);}); ['Design','Response','Stability','Structures','Families','Ztransform'].forEach(function(name){ const p=$('panel'+name); if(p) p.hidden = name.toLowerCase() !== mode; }); updateAll(); }); });
      function bind(id, fn){ const el=$(id); if(!el) return; ['input','change','keyup','compositionend'].forEach(function(evt){ el.addEventListener(evt, fn); }); el.addEventListener('paste', function(){ setTimeout(fn,0); }); }
      ['designKind','filterType','sampleRate','f0','f1','qValue','gainDb','firTaps','firWindow'].forEach(function(id){ bind(id, function(){ if($('designKind').value !== 'manual') applyDesignToText(); else updateAll(); }); });
      ['bCoeffs','aCoeffs','responsePoints','dbFloor','phaseMode','responseXAxis'].forEach(function(id){ bind(id, updateAll); });
      $('applyDesign').addEventListener('click', applyDesignToText);
      $('normalizeCoeffs').addEventListener('click', function(){ const d=normalizeBA(parseCoeffs($('bCoeffs').value), parseCoeffs($('aCoeffs').value)); $('bCoeffs').value=coeffText(d.b); $('aCoeffs').value=coeffText(d.a); updateAll(); });
      $('copyCoeffs').addEventListener('click', function(){ copyText('b = ['+$('bCoeffs').value+']\\na = ['+$('aCoeffs').value+']'); });
      $('insertCoeffs').addEventListener('click', function(){ insertText('static const double b[] = { '+$('bCoeffs').value+' };\\nstatic const double a[] = { '+$('aCoeffs').value+' };'); });
      $('copyImplementation').addEventListener('click', function(){ copyText($('cImplementation').value); });
      $('insertImplementation').addEventListener('click', function(){ insertText($('cImplementation').value); });
      if(seedText && seedText.trim()) { $('bCoeffs').value = seedText; $('designKind').value = 'manual'; } else { applyDesignToText(); }
      updateAll(); setTimeout(updateAll,0); if(typeof requestAnimationFrame === 'function') requestAnimationFrame(updateAll);
    }());
  </script>
</body>
</html>`;
}

async function openDigitalFilterDesigner(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const initialText = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : '';
  const panel = vscode.window.createWebviewPanel('cviDigitalFilterDesigner', 'CVI: Digital filter designer', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
  panel.webview.html = buildDigitalFilterDesignerHtml(initialText);
  panel.webview.onDidReceiveMessage(async (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'copyFilterValue' && typeof message.text === 'string') {
      await vscode.env.clipboard.writeText(message.text);
      void vscode.window.showInformationMessage('Copied digital filter artifact to clipboard.');
      return;
    }
    if (message.type === 'insertFilterValue' && typeof message.text === 'string') {
      const activeEditor = vscode.window.activeTextEditor || editor;
      if (!activeEditor) {
        void vscode.window.showErrorMessage('Open a text editor before inserting a digital filter artifact.');
        return;
      }
      await insertTextAtEditorSelections(activeEditor, message.text);
      panel.dispose();
    }
  });
}




export class CviContextToolsService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  openCharacterTable(): Promise<void> {
    return openCharacterTable(this.context);
  }

  convertSelectedTextToDecimalValues(): Promise<void> {
    return convertSelectedTextToDecimalValues();
  }

  convertSelectedNumbersToText(): Promise<void> {
    return convertSelectedNumbersToText();
  }

  openNumberConverter(): Promise<void> {
    return openNumberConverter(this.context);
  }

  openTruthTableDesigner(): Promise<void> {
    return openTruthTableDesigner(this.context);
  }

  openDigitalFilterDesigner(): Promise<void> {
    return openDigitalFilterDesigner(this.context);
  }
}
