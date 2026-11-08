import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PeExportSymbol, parsePeExports } from './cviImportLibraryService';

export interface CviDllImportSymbol {
  name?: string;
  ordinal?: number;
  hint?: number;
}

export interface CviDllImportModule {
  dll: string;
  symbols: CviDllImportSymbol[];
}

export interface CviDllSectionInfo {
  name: string;
  virtualAddress: number;
  virtualSize: number;
  rawSize: number;
  characteristics: number;
}

export interface CviDllResourceTypeInfo {
  id?: number;
  name?: string;
  count: number;
}

export interface CviDllVersionInfo {
  fileVersion?: string;
  productVersion?: string;
  strings: Record<string, string>;
}

export interface CviDllDebugInfo {
  pdbPath?: string;
  pdbGuid?: string;
  pdbAge?: number;
}

export interface CviDllAnalysis {
  filePath: string;
  fileName: string;
  fileSize: number;
  sha256: string;
  architecture: 'x86' | 'x64' | 'arm64';
  peFormat: 'PE32' | 'PE32+';
  machine: number;
  machineLabel: string;
  timestamp: number;
  timestampIso?: string;
  imageBase: string;
  entryPointRva: number;
  sizeOfImage: number;
  checksum: number;
  subsystem: number;
  subsystemLabel: string;
  fileCharacteristics: string[];
  dllCharacteristics: string[];
  authenticodePresent: boolean;
  authenticodeSize: number;
  dotNet: boolean;
  version: CviDllVersionInfo;
  debug: CviDllDebugInfo;
  exports: PeExportSymbol[];
  ordinalOnlyExportCount: number;
  imports: CviDllImportModule[];
  sections: CviDllSectionInfo[];
  resources: CviDllResourceTypeInfo[];
}

interface PeSectionRaw extends CviDllSectionInfo {
  rawPointer: number;
}

interface PeContext {
  buffer: Buffer;
  peOffset: number;
  fileHeader: number;
  optionalOffset: number;
  optionalSize: number;
  magic: number;
  pe32Plus: boolean;
  numberOfDirectories: number;
  dataDirectoryOffset: number;
  sizeOfHeaders: number;
  sections: PeSectionRaw[];
  rvaToOffset(rva: number): number;
  directory(index: number): { rva: number; size: number };
}

export function analyzeDllFile(filePath: string): CviDllAnalysis {
  const resolved = path.resolve(filePath);
  const buffer = fs.readFileSync(resolved);
  const context = parsePeContext(buffer);
  const exports = parsePeExports(buffer);
  const machine = buffer.readUInt16LE(context.fileHeader);
  const timestamp = buffer.readUInt32LE(context.fileHeader + 4);
  const fileCharacteristics = buffer.readUInt16LE(context.fileHeader + 18);
  const entryPointRva = buffer.readUInt32LE(context.optionalOffset + 16);
  const imageBase = context.pe32Plus
    ? `0x${buffer.readBigUInt64LE(context.optionalOffset + 24).toString(16).toUpperCase()}`
    : `0x${buffer.readUInt32LE(context.optionalOffset + 28).toString(16).toUpperCase()}`;
  const sizeOfImage = buffer.readUInt32LE(context.optionalOffset + 56);
  const checksum = buffer.readUInt32LE(context.optionalOffset + 64);
  const subsystem = buffer.readUInt16LE(context.optionalOffset + 68);
  const dllCharacteristics = buffer.readUInt16LE(context.optionalOffset + 70);
  const certificate = context.directory(4);
  const clr = context.directory(14);
  return {
    filePath: resolved,
    fileName: path.basename(resolved),
    fileSize: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    architecture: exports.architecture,
    peFormat: context.pe32Plus ? 'PE32+' : 'PE32',
    machine,
    machineLabel: machineLabel(machine),
    timestamp,
    timestampIso: timestamp ? new Date(timestamp * 1000).toISOString() : undefined,
    imageBase,
    entryPointRva,
    sizeOfImage,
    checksum,
    subsystem,
    subsystemLabel: subsystemLabel(subsystem),
    fileCharacteristics: decodeFlags(fileCharacteristics, FILE_CHARACTERISTICS),
    dllCharacteristics: decodeFlags(dllCharacteristics, DLL_CHARACTERISTICS),
    authenticodePresent: certificate.rva > 0 && certificate.size > 0,
    authenticodeSize: certificate.size,
    dotNet: clr.rva > 0 && clr.size > 0,
    version: parseVersionInfo(context),
    debug: parseDebugInfo(context),
    exports: exports.symbols,
    ordinalOnlyExportCount: exports.ordinalOnlyCount,
    imports: parseImports(context),
    sections: context.sections.map(({ rawPointer: _rawPointer, ...section }) => section),
    resources: parseResourceTypes(context)
  };
}

export function renderDllAnalysisMarkdown(analysis: CviDllAnalysis): string {
  const v = analysis.version;
  const versionStrings = Object.entries(v.strings).sort(([a], [b]) => a.localeCompare(b));
  const lines: string[] = [
    '# CVI DLL Analyzer', '',
    `- File: \`${analysis.filePath}\``,
    `- Size: ${analysis.fileSize} bytes`,
    `- SHA-256: \`${analysis.sha256}\``,
    `- Architecture: **${analysis.architecture}** (${analysis.machineLabel}, 0x${analysis.machine.toString(16).toUpperCase()})`,
    `- PE format: ${analysis.peFormat}`,
    `- Link timestamp: ${analysis.timestampIso ?? 'not set'}`,
    `- Image base: ${analysis.imageBase}`,
    `- Entry point RVA: 0x${analysis.entryPointRva.toString(16).toUpperCase()}`,
    `- Image size: ${analysis.sizeOfImage} bytes`,
    `- Subsystem: ${analysis.subsystemLabel}`,
    `- Authenticode certificate table: ${analysis.authenticodePresent ? `present (${analysis.authenticodeSize} bytes)` : 'not present'}`,
    `- .NET/CLR header: ${analysis.dotNet ? 'present' : 'not present'}`,
    '', '## Version information', '',
    `- File version: ${v.fileVersion ?? 'not available'}`,
    `- Product version: ${v.productVersion ?? 'not available'}`,
    `- File revision: ${versionRevision(v.fileVersion) ?? 'not available'}`
  ];
  for (const [key, value] of versionStrings) lines.push(`- ${key}: ${value}`);
  lines.push('', '## Exports', '', '| Ordinal | RVA | Name | Forwarder |', '| ---: | ---: | --- | --- |');
  for (const symbol of analysis.exports) lines.push(`| ${symbol.ordinal} | 0x${symbol.rva.toString(16).toUpperCase()} | \`${escapeMarkdownCell(symbol.name)}\` | ${symbol.forwarder ? `\`${escapeMarkdownCell(symbol.forwarder)}\`` : ''} |`);
  if (!analysis.exports.length) lines.push('| | | _No named exports_ | |');
  if (analysis.ordinalOnlyExportCount) lines.push('', `Ordinal-only exports: ${analysis.ordinalOnlyExportCount}`);
  lines.push('', '## Imports', '');
  for (const module of analysis.imports) {
    lines.push(`### ${module.dll}`, '');
    if (!module.symbols.length) lines.push('_No decoded symbols._', '');
    else for (const symbol of module.symbols) lines.push(`- ${symbol.name ? `\`${escapeMarkdownCell(symbol.name)}\`` : `ordinal ${symbol.ordinal}`}${symbol.hint !== undefined ? ` (hint ${symbol.hint})` : ''}`);
    lines.push('');
  }
  if (!analysis.imports.length) lines.push('_No imports._', '');
  lines.push('## Sections', '', '| Name | RVA | Virtual size | Raw size | Characteristics |', '| --- | ---: | ---: | ---: | ---: |');
  for (const section of analysis.sections) lines.push(`| ${section.name} | 0x${section.virtualAddress.toString(16).toUpperCase()} | ${section.virtualSize} | ${section.rawSize} | 0x${section.characteristics.toString(16).toUpperCase()} |`);
  lines.push('', '## Resources', '');
  if (!analysis.resources.length) lines.push('_No resource directory._');
  else for (const resource of analysis.resources) lines.push(`- ${resource.name ?? resourceTypeName(resource.id)}${resource.id !== undefined ? ` (${resource.id})` : ''}: ${resource.count} entr${resource.count === 1 ? 'y' : 'ies'}`);
  if (analysis.debug.pdbPath || analysis.debug.pdbGuid) {
    lines.push('', '## Debug / PDB', '');
    if (analysis.debug.pdbPath) lines.push(`- PDB path: \`${analysis.debug.pdbPath}\``);
    if (analysis.debug.pdbGuid) lines.push(`- PDB GUID: \`${analysis.debug.pdbGuid}\``);
    if (analysis.debug.pdbAge !== undefined) lines.push(`- PDB age: ${analysis.debug.pdbAge}`);
  }
  lines.push('');
  return lines.join('\n');
}

function parsePeContext(buffer: Buffer): PeContext {
  if (buffer.length < 0x100 || buffer.toString('ascii', 0, 2) !== 'MZ') throw new Error('File is not a PE image (missing MZ header).');
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset <= 0 || peOffset + 24 > buffer.length || buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') throw new Error('Invalid PE signature.');
  const fileHeader = peOffset + 4;
  const sectionCount = buffer.readUInt16LE(fileHeader + 2);
  const optionalSize = buffer.readUInt16LE(fileHeader + 16);
  const optionalOffset = fileHeader + 20;
  if (optionalOffset + optionalSize > buffer.length) throw new Error('Truncated PE optional header.');
  const magic = buffer.readUInt16LE(optionalOffset);
  const pe32Plus = magic === 0x20b;
  if (!pe32Plus && magic !== 0x10b) throw new Error(`Unsupported PE optional-header magic 0x${magic.toString(16)}.`);
  const numberOfDirectories = buffer.readUInt32LE(optionalOffset + (pe32Plus ? 108 : 92));
  const dataDirectoryOffset = optionalOffset + (pe32Plus ? 112 : 96);
  const sizeOfHeaders = buffer.readUInt32LE(optionalOffset + 60);
  const sectionOffset = optionalOffset + optionalSize;
  const sections: PeSectionRaw[] = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionOffset + index * 40;
    if (offset + 40 > buffer.length) throw new Error('Truncated PE section table.');
    sections.push({
      name: readSectionName(buffer, offset),
      virtualSize: buffer.readUInt32LE(offset + 8),
      virtualAddress: buffer.readUInt32LE(offset + 12),
      rawSize: buffer.readUInt32LE(offset + 16),
      rawPointer: buffer.readUInt32LE(offset + 20),
      characteristics: buffer.readUInt32LE(offset + 36)
    });
  }
  const rvaToOffset = (rva: number): number => {
    if (rva < sizeOfHeaders && rva < buffer.length) return rva;
    for (const section of sections) {
      const span = Math.max(section.virtualSize, section.rawSize);
      if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
        const offset = section.rawPointer + (rva - section.virtualAddress);
        if (offset >= 0 && offset < buffer.length) return offset;
      }
    }
    throw new Error(`Unable to map PE RVA 0x${rva.toString(16)}.`);
  };
  const directory = (index: number): { rva: number; size: number } => {
    if (index < 0 || index >= numberOfDirectories || dataDirectoryOffset + index * 8 + 8 > buffer.length) return { rva: 0, size: 0 };
    return { rva: buffer.readUInt32LE(dataDirectoryOffset + index * 8), size: buffer.readUInt32LE(dataDirectoryOffset + index * 8 + 4) };
  };
  return { buffer, peOffset, fileHeader, optionalOffset, optionalSize, magic, pe32Plus, numberOfDirectories, dataDirectoryOffset, sizeOfHeaders, sections, rvaToOffset, directory };
}

function parseImports(context: PeContext): CviDllImportModule[] {
  const dir = context.directory(1);
  if (!dir.rva || !dir.size) return [];
  let offset: number;
  try { offset = context.rvaToOffset(dir.rva); } catch { return []; }
  const modules: CviDllImportModule[] = [];
  const thunkSize = context.pe32Plus ? 8 : 4;
  const ordinalMask = context.pe32Plus ? 0x8000000000000000n : 0x80000000n;
  for (let index = 0; index < 4096; index += 1) {
    const descriptor = offset + index * 20;
    if (descriptor + 20 > context.buffer.length) break;
    const originalThunk = context.buffer.readUInt32LE(descriptor);
    const nameRva = context.buffer.readUInt32LE(descriptor + 12);
    const firstThunk = context.buffer.readUInt32LE(descriptor + 16);
    if (!originalThunk && !nameRva && !firstThunk) break;
    if (!nameRva) continue;
    let dll = '';
    try { dll = readCString(context.buffer, context.rvaToOffset(nameRva)); } catch { dll = `<invalid-name-rva-0x${nameRva.toString(16)}>`; }
    const symbols: CviDllImportSymbol[] = [];
    const thunkRva = originalThunk || firstThunk;
    if (thunkRva) {
      try {
        const thunkOffset = context.rvaToOffset(thunkRva);
        for (let slot = 0; slot < 65536; slot += 1) {
          const entryOffset = thunkOffset + slot * thunkSize;
          if (entryOffset + thunkSize > context.buffer.length) break;
          const raw = context.pe32Plus ? context.buffer.readBigUInt64LE(entryOffset) : BigInt(context.buffer.readUInt32LE(entryOffset));
          if (raw === 0n) break;
          if ((raw & ordinalMask) !== 0n) {
            symbols.push({ ordinal: Number(raw & 0xffffn) });
          } else {
            const nameEntryRva = Number(raw & 0xffffffffn);
            try {
              const nameOffset = context.rvaToOffset(nameEntryRva);
              if (nameOffset + 2 <= context.buffer.length) symbols.push({ hint: context.buffer.readUInt16LE(nameOffset), name: readCString(context.buffer, nameOffset + 2) });
            } catch { /* ignore malformed thunk */ }
          }
        }
      } catch { /* ignore malformed thunk table */ }
    }
    modules.push({ dll, symbols });
  }
  return modules;
}

function parseVersionInfo(context: PeContext): CviDllVersionInfo {
  const result: CviDllVersionInfo = { strings: {} };
  const versionData = findResourceData(context, 16);
  if (!versionData) return result;
  const { offset, size } = versionData;
  const end = Math.min(context.buffer.length, offset + size);
  if (offset + 6 > end) return result;
  try {
    const root = parseVersionBlock(context.buffer, offset, end);
    if (root.key !== 'VS_VERSION_INFO') return result;
    if (root.valueLength >= 52 && root.valueOffset + 52 <= end && context.buffer.readUInt32LE(root.valueOffset) === 0xFEEF04BD) {
      const fileMs = context.buffer.readUInt32LE(root.valueOffset + 8);
      const fileLs = context.buffer.readUInt32LE(root.valueOffset + 12);
      const productMs = context.buffer.readUInt32LE(root.valueOffset + 16);
      const productLs = context.buffer.readUInt32LE(root.valueOffset + 20);
      result.fileVersion = formatVersion(fileMs, fileLs);
      result.productVersion = formatVersion(productMs, productLs);
    }
    collectVersionStrings(context.buffer, root, result.strings, end);
    result.fileVersion = result.strings.FileVersion || result.fileVersion;
    result.productVersion = result.strings.ProductVersion || result.productVersion;
  } catch { /* leave best-effort fields empty */ }
  return result;
}

interface VersionBlock { offset: number; length: number; valueLength: number; type: number; key: string; valueOffset: number; childrenOffset: number; end: number; }
function parseVersionBlock(buffer: Buffer, offset: number, parentEnd: number): VersionBlock {
  if (offset + 6 > parentEnd) throw new Error('Truncated VERSIONINFO block.');
  const length = buffer.readUInt16LE(offset);
  const valueLength = buffer.readUInt16LE(offset + 2);
  const type = buffer.readUInt16LE(offset + 4);
  if (!length || offset + length > parentEnd) throw new Error('Invalid VERSIONINFO block length.');
  let cursor = offset + 6;
  const chars: number[] = [];
  while (cursor + 2 <= offset + length) {
    const code = buffer.readUInt16LE(cursor); cursor += 2;
    if (code === 0) break;
    chars.push(code);
  }
  const key = String.fromCharCode(...chars);
  const valueOffset = align4(cursor);
  const valueBytes = type === 1 ? valueLength * 2 : valueLength;
  const childrenOffset = align4(Math.min(offset + length, valueOffset + valueBytes));
  return { offset, length, valueLength, type, key, valueOffset, childrenOffset, end: offset + length };
}
function collectVersionStrings(buffer: Buffer, parent: VersionBlock, out: Record<string, string>, absoluteEnd: number): void {
  let cursor = parent.childrenOffset;
  while (cursor + 6 <= parent.end && cursor + 6 <= absoluteEnd) {
    let child: VersionBlock;
    try { child = parseVersionBlock(buffer, cursor, Math.min(parent.end, absoluteEnd)); } catch { break; }
    if (child.type === 1 && child.valueLength > 0 && child.valueOffset < child.end && child.key && child.key !== 'StringFileInfo' && child.key !== 'VarFileInfo') {
      const valueEnd = Math.min(child.end, child.valueOffset + child.valueLength * 2);
      const value = readUtf16String(buffer, child.valueOffset, valueEnd).replace(/\0+$/, '').trim();
      if (value) out[child.key] = value;
    }
    collectVersionStrings(buffer, child, out, absoluteEnd);
    cursor = align4(child.end);
    if (child.length <= 0) break;
  }
}

function parseResourceTypes(context: PeContext): CviDllResourceTypeInfo[] {
  const dir = context.directory(2);
  if (!dir.rva || !dir.size) return [];
  let base: number;
  try { base = context.rvaToOffset(dir.rva); } catch { return []; }
  return readResourceDirectoryEntries(context.buffer, base, base, 0).map(entry => ({ id: entry.id, name: entry.name, count: countResourceLeaves(context.buffer, base, entry.targetOffset, entry.isDirectory, 0) }));
}

function findResourceData(context: PeContext, typeId: number): { offset: number; size: number } | undefined {
  const dir = context.directory(2);
  if (!dir.rva || !dir.size) return undefined;
  let base: number;
  try { base = context.rvaToOffset(dir.rva); } catch { return undefined; }
  const type = readResourceDirectoryEntries(context.buffer, base, base, 0).find(entry => entry.id === typeId);
  if (!type) return undefined;
  let currentOffset = type.targetOffset;
  let isDirectory = type.isDirectory;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!isDirectory) {
      if (currentOffset + 16 > context.buffer.length) return undefined;
      const dataRva = context.buffer.readUInt32LE(currentOffset);
      const size = context.buffer.readUInt32LE(currentOffset + 4);
      try { return { offset: context.rvaToOffset(dataRva), size }; } catch { return undefined; }
    }
    const entries = readResourceDirectoryEntries(context.buffer, base, currentOffset, depth + 1);
    if (!entries.length) return undefined;
    currentOffset = entries[0].targetOffset;
    isDirectory = entries[0].isDirectory;
  }
  return undefined;
}

interface ResourceEntry { id?: number; name?: string; targetOffset: number; isDirectory: boolean; }
function readResourceDirectoryEntries(buffer: Buffer, base: number, directoryOffset: number, depth: number): ResourceEntry[] {
  if (depth > 8 || directoryOffset < 0 || directoryOffset + 16 > buffer.length) return [];
  const named = buffer.readUInt16LE(directoryOffset + 12);
  const ids = buffer.readUInt16LE(directoryOffset + 14);
  const total = Math.min(named + ids, 4096);
  const entries: ResourceEntry[] = [];
  for (let index = 0; index < total; index += 1) {
    const off = directoryOffset + 16 + index * 8;
    if (off + 8 > buffer.length) break;
    const nameRaw = buffer.readUInt32LE(off);
    const targetRaw = buffer.readUInt32LE(off + 4);
    const isName = (nameRaw & 0x80000000) !== 0;
    const targetRelative = targetRaw & 0x7fffffff;
    const targetOffset = base + targetRelative;
    let name: string | undefined;
    let id: number | undefined;
    if (isName) name = readResourceString(buffer, base + (nameRaw & 0x7fffffff)); else id = nameRaw & 0xffff;
    entries.push({ id, name, targetOffset, isDirectory: (targetRaw & 0x80000000) !== 0 });
  }
  return entries;
}
function countResourceLeaves(buffer: Buffer, base: number, offset: number, isDirectory: boolean, depth: number): number {
  if (depth > 8) return 0;
  if (!isDirectory) return offset + 16 <= buffer.length ? 1 : 0;
  const entries = readResourceDirectoryEntries(buffer, base, offset, depth + 1);
  return entries.reduce((sum, entry) => sum + countResourceLeaves(buffer, base, entry.targetOffset, entry.isDirectory, depth + 1), 0);
}

function parseDebugInfo(context: PeContext): CviDllDebugInfo {
  const dir = context.directory(6);
  if (!dir.rva || dir.size < 28) return {};
  let offset: number;
  try { offset = context.rvaToOffset(dir.rva); } catch { return {}; }
  const count = Math.min(Math.floor(dir.size / 28), 1024);
  for (let index = 0; index < count; index += 1) {
    const entry = offset + index * 28;
    if (entry + 28 > context.buffer.length) break;
    const type = context.buffer.readUInt32LE(entry + 12);
    const size = context.buffer.readUInt32LE(entry + 16);
    const raw = context.buffer.readUInt32LE(entry + 24);
    if (type !== 2 || !size || raw + Math.min(size, 24) > context.buffer.length) continue;
    if (context.buffer.toString('ascii', raw, raw + 4) === 'RSDS' && raw + 24 <= context.buffer.length) {
      return { pdbGuid: formatGuid(context.buffer.subarray(raw + 4, raw + 20)), pdbAge: context.buffer.readUInt32LE(raw + 20), pdbPath: readCString(context.buffer, raw + 24) };
    }
  }
  return {};
}

function formatGuid(bytes: Buffer): string {
  if (bytes.length < 16) return '';
  const d1 = bytes.readUInt32LE(0).toString(16).padStart(8, '0');
  const d2 = bytes.readUInt16LE(4).toString(16).padStart(4, '0');
  const d3 = bytes.readUInt16LE(6).toString(16).padStart(4, '0');
  const d4 = bytes.subarray(8, 10).toString('hex');
  const d5 = bytes.subarray(10, 16).toString('hex');
  return `${d1}-${d2}-${d3}-${d4}-${d5}`.toUpperCase();
}

function readSectionName(buffer: Buffer, offset: number): string {
  let end = offset;
  while (end < offset + 8 && buffer[end] !== 0) end += 1;
  return buffer.toString('ascii', offset, end);
}
function readCString(buffer: Buffer, offset: number): string {
  if (offset < 0 || offset >= buffer.length) return '';
  let end = offset;
  while (end < buffer.length && buffer[end] !== 0) end += 1;
  return buffer.toString('utf8', offset, end);
}
function readUtf16String(buffer: Buffer, start: number, end: number): string {
  const safeEnd = Math.min(buffer.length, end - ((end - start) % 2));
  return buffer.toString('utf16le', start, safeEnd).replace(/\u0000+$/g, '');
}
function readResourceString(buffer: Buffer, offset: number): string {
  if (offset < 0 || offset + 2 > buffer.length) return '';
  const chars = buffer.readUInt16LE(offset);
  const end = Math.min(buffer.length, offset + 2 + chars * 2);
  return buffer.toString('utf16le', offset + 2, end);
}
function align4(value: number): number { return (value + 3) & ~3; }
function formatVersion(ms: number, ls: number): string { return `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`; }
function versionRevision(value?: string): string | undefined { const parts = String(value ?? '').split('.'); return parts.length >= 4 ? parts[3] : undefined; }
function escapeMarkdownCell(value: string): string { return String(value).replace(/\|/g, '\\|').replace(/`/g, '\\`'); }
function decodeFlags(value: number, map: Array<[number, string]>): string[] { return map.filter(([mask]) => (value & mask) !== 0).map(([, label]) => label); }
function machineLabel(machine: number): string { return machine === 0x014c ? 'Intel 386' : machine === 0x8664 ? 'AMD64' : machine === 0xaa64 ? 'ARM64' : `Machine 0x${machine.toString(16)}`; }
function subsystemLabel(value: number): string { return ({ 1: 'Native', 2: 'Windows GUI', 3: 'Windows CUI', 5: 'OS/2 CUI', 7: 'POSIX CUI', 9: 'Windows CE GUI', 10: 'EFI application', 11: 'EFI boot-service driver', 12: 'EFI runtime driver', 13: 'EFI ROM', 14: 'Xbox', 16: 'Windows boot application' } as Record<number, string>)[value] ?? `Subsystem ${value}`; }
function resourceTypeName(id?: number): string { return ({ 1: 'Cursor', 2: 'Bitmap', 3: 'Icon', 4: 'Menu', 5: 'Dialog', 6: 'String table', 7: 'Font directory', 8: 'Font', 9: 'Accelerator', 10: 'RCDATA', 11: 'Message table', 12: 'Group cursor', 14: 'Group icon', 16: 'Version', 17: 'Dialog include', 21: 'Animated cursor', 22: 'Animated icon', 23: 'HTML', 24: 'Manifest' } as Record<number, string>)[id ?? -1] ?? `Resource ${id ?? '?'}`; }

const FILE_CHARACTERISTICS: Array<[number, string]> = [
  [0x0001, 'Relocations stripped'], [0x0002, 'Executable image'], [0x0004, 'Line numbers stripped'], [0x0008, 'Local symbols stripped'],
  [0x0020, 'Large address aware'], [0x0100, '32-bit machine'], [0x0200, 'Debug stripped'], [0x1000, 'System'], [0x2000, 'DLL'], [0x4000, 'Uniprocessor only']
];
const DLL_CHARACTERISTICS: Array<[number, string]> = [
  [0x0020, 'High entropy VA'], [0x0040, 'Dynamic base (ASLR)'], [0x0080, 'Force integrity'], [0x0100, 'NX compatible'], [0x0200, 'No isolation'],
  [0x0400, 'No SEH'], [0x0800, 'No bind'], [0x1000, 'AppContainer'], [0x2000, 'WDM driver'], [0x4000, 'Control Flow Guard'], [0x8000, 'Terminal Server aware']
];
