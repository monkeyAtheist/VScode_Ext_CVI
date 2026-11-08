import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type CviArchiveMemberKind = 'linker-table' | 'longnames' | 'import-object' | 'coff-object' | 'elf-object' | 'llvm-bitcode' | 'metadata' | 'unknown';

export interface CviArchiveMemberInfo {
  name: string;
  size: number;
  timestamp?: number;
  timestampIso?: string;
  kind: CviArchiveMemberKind;
  architecture?: string;
  machine?: number;
  importDll?: string;
  importSymbol?: string;
  symbols: string[];
}

export interface CviLibraryAnalysis {
  filePath: string;
  fileName: string;
  extension: string;
  fileSize: number;
  modifiedIso: string;
  sha256: string;
  archiveFormat: string;
  libraryKind: 'static' | 'import' | 'mixed' | 'unknown';
  architectures: string[];
  memberCount: number;
  objectMemberCount: number;
  importObjectCount: number;
  linkerSymbolCount: number;
  symbols: string[];
  importDlls: string[];
  members: CviArchiveMemberInfo[];
  notes: string[];
}

interface RawMember {
  headerOffset: number;
  name: string;
  size: number;
  timestamp?: number;
  data: Buffer;
  kind: CviArchiveMemberKind;
  architecture?: string;
  machine?: number;
  importDll?: string;
  importSymbol?: string;
  symbols: string[];
}

interface ArchiveSymbol {
  name: string;
  memberOffset?: number;
}

const AR_MAGIC = '!<arch>\n';

export function analyzeLibraryFile(filePath: string): CviLibraryAnalysis {
  const resolved = path.resolve(filePath);
  const buffer = fs.readFileSync(resolved);
  if (buffer.length < 8 || buffer.toString('ascii', 0, 8) !== AR_MAGIC) {
    throw new Error('Unsupported library format: expected a GNU/COFF archive beginning with !<arch>.');
  }

  const stat = fs.statSync(resolved);
  const rawMembers = parseArchiveMembers(buffer);
  const linkerSymbols = parseArchiveLinkerSymbols(rawMembers);
  const byOffset = new Map<number, RawMember>(rawMembers.map((member) => [member.headerOffset, member]));
  for (const symbol of linkerSymbols) {
    if (symbol.memberOffset !== undefined) {
      const member = byOffset.get(symbol.memberOffset);
      if (member && !member.symbols.includes(symbol.name)) member.symbols.push(symbol.name);
    }
  }

  const members = rawMembers.map<CviArchiveMemberInfo>((member) => ({
    name: member.name,
    size: member.size,
    timestamp: member.timestamp,
    timestampIso: member.timestamp ? new Date(member.timestamp * 1000).toISOString() : undefined,
    kind: member.kind,
    architecture: member.architecture,
    machine: member.machine,
    importDll: member.importDll,
    importSymbol: member.importSymbol,
    symbols: member.symbols.slice().sort((a, b) => a.localeCompare(b))
  }));

  const objectMembers = rawMembers.filter((member) => member.kind === 'coff-object' || member.kind === 'elf-object' || member.kind === 'llvm-bitcode');
  const importMembers = rawMembers.filter((member) => member.kind === 'import-object');
  const symbols = unique(linkerSymbols.map((entry) => entry.name).filter(Boolean));
  const importDlls = unique([
    ...importMembers.map((member) => member.importDll || '').filter(Boolean),
    ...scanLikelyDllNames(buffer)
  ]);
  const architectures = unique(rawMembers.map((member) => member.architecture || '').filter(Boolean));
  const symbolLooksLikeImport = symbols.some((symbol) => /^__imp_|^_?__IMPORT_DESCRIPTOR_|_head_/i.test(symbol));
  const memberLooksLikeImport = rawMembers.some((member) => /(?:_head_|_iname|_nm_).*\.(?:o|obj)$/i.test(member.name));
  const hasImportEvidence = importMembers.length > 0 || symbolLooksLikeImport || memberLooksLikeImport || /\.dll\.a$/i.test(resolved);
  const hasStaticEvidence = objectMembers.length > 0 && !hasImportEvidence;
  const libraryKind: CviLibraryAnalysis['libraryKind'] = hasImportEvidence && objectMembers.length > 0 && importMembers.length === 0
    ? 'import'
    : hasImportEvidence && objectMembers.length > 0 && importMembers.length > 0
      ? 'mixed'
      : hasImportEvidence
        ? 'import'
        : hasStaticEvidence
          ? 'static'
          : 'unknown';

  const notes: string[] = [
    'Archive libraries do not normally contain PE VERSIONINFO at the archive level. File/product version and revision fields therefore are not intrinsic metadata for .a/.lib files.',
    'A .lib can be either a static COFF archive or a Windows import library; CPM classifies it from member and symbol evidence rather than from the extension alone.'
  ];
  if (/\.lib$/i.test(resolved) && libraryKind === 'static' && architectures.some((arch) => /x86|x64|arm64/i.test(arch))) {
    notes.push('This .lib looks like a static COFF archive. C++ ABI compatibility still depends on the compiler/toolchain that produced the object members.');
  }
  if (/\.a$/i.test(resolved) && libraryKind === 'import') {
    notes.push('This .a appears to be a MinGW/GNU-style import library; the corresponding DLL is still required at runtime.');
  }

  return {
    filePath: resolved,
    fileName: path.basename(resolved),
    extension: archiveExtension(resolved),
    fileSize: buffer.length,
    modifiedIso: stat.mtime.toISOString(),
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    archiveFormat: 'GNU/COFF ar archive',
    libraryKind,
    architectures,
    memberCount: rawMembers.filter((member) => member.kind !== 'linker-table' && member.kind !== 'longnames').length,
    objectMemberCount: objectMembers.length,
    importObjectCount: importMembers.length,
    linkerSymbolCount: symbols.length,
    symbols,
    importDlls,
    members,
    notes
  };
}

export function renderLibraryAnalysisMarkdown(analysis: CviLibraryAnalysis): string {
  const lines: string[] = [
    '# CVI Library Analyzer', '',
    `- File: \`${analysis.filePath}\``,
    `- Extension: \`${analysis.extension}\``,
    `- Size: ${analysis.fileSize} bytes`,
    `- Modified: ${analysis.modifiedIso}`,
    `- SHA-256: \`${analysis.sha256}\``,
    `- Archive format: ${analysis.archiveFormat}`,
    `- Classification: **${analysis.libraryKind} library**`,
    `- Architectures: ${analysis.architectures.length ? analysis.architectures.join(', ') : 'not detected'}`,
    `- Archive members: ${analysis.memberCount}`,
    `- Object members: ${analysis.objectMemberCount}`,
    `- Import-object members: ${analysis.importObjectCount}`,
    `- Linker symbols: ${analysis.linkerSymbolCount}`,
    '', '## Runtime DLL references', ''
  ];
  if (analysis.importDlls.length) analysis.importDlls.forEach((dll) => lines.push(`- \`${dll}\``));
  else lines.push('_No DLL name was detected in the archive._');
  lines.push('', '## Linker symbols', '');
  if (analysis.symbols.length) analysis.symbols.forEach((symbol) => lines.push(`- \`${escapeMarkdown(symbol)}\``));
  else lines.push('_No archive linker symbol table was decoded._');
  lines.push('', '## Members', '', '| Name | Kind | Architecture | Size | Import DLL | Import symbol | Symbols |', '| --- | --- | --- | ---: | --- | --- | ---: |');
  for (const member of analysis.members) {
    lines.push(`| \`${escapeMarkdown(member.name)}\` | ${member.kind} | ${member.architecture ?? ''} | ${member.size} | ${member.importDll ? `\`${escapeMarkdown(member.importDll)}\`` : ''} | ${member.importSymbol ? `\`${escapeMarkdown(member.importSymbol)}\`` : ''} | ${member.symbols.length} |`);
  }
  lines.push('', '## Notes', '');
  analysis.notes.forEach((note) => lines.push(`- ${note}`));
  lines.push('');
  return lines.join('\n');
}

function parseArchiveMembers(buffer: Buffer): RawMember[] {
  const members: RawMember[] = [];
  let offset = 8;
  let longNames = Buffer.alloc(0);
  while (offset + 60 <= buffer.length) {
    const headerOffset = offset;
    const rawName = buffer.toString('ascii', offset, offset + 16).trim();
    const timestampRaw = buffer.toString('ascii', offset + 16, offset + 28).trim();
    const sizeRaw = buffer.toString('ascii', offset + 48, offset + 58).trim();
    const trailer = buffer.toString('ascii', offset + 58, offset + 60);
    if (trailer !== '`\n') break;
    const size = Number.parseInt(sizeRaw, 10);
    if (!Number.isFinite(size) || size < 0 || offset + 60 + size > buffer.length) break;
    const timestamp = Number.parseInt(timestampRaw, 10);
    let dataStart = offset + 60;
    let payloadSize = size;
    let name = rawName;

    if (rawName.startsWith('#1/')) {
      const nameLength = Number.parseInt(rawName.slice(3), 10) || 0;
      if (nameLength > 0 && nameLength <= payloadSize) {
        name = buffer.toString('utf8', dataStart, dataStart + nameLength).replace(/\0+$/, '');
        dataStart += nameLength;
        payloadSize -= nameLength;
      }
    } else if (/^\/\d+$/.test(rawName) && longNames.length) {
      const longOffset = Number.parseInt(rawName.slice(1), 10);
      name = readArLongName(longNames, longOffset);
    } else if (rawName === '/' || rawName === '//' || rawName === '/SYM64/') {
      name = rawName;
    } else {
      name = rawName.replace(/\/$/, '');
    }

    const data = buffer.subarray(dataStart, dataStart + payloadSize);
    let info = classifyArchiveMember(name, data);
    if (rawName === '//') {
      longNames = Buffer.from(data);
      info = { kind: 'longnames' as const };
    } else if (rawName === '/' || rawName === '/SYM64/') {
      info = { kind: 'linker-table' as const };
    }
    members.push({
      headerOffset,
      name,
      size: payloadSize,
      timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined,
      data,
      kind: info.kind,
      architecture: info.architecture,
      machine: info.machine,
      importDll: info.importDll,
      importSymbol: info.importSymbol,
      symbols: []
    });
    offset += 60 + size;
    if (offset & 1) offset += 1;
  }
  return members;
}

function parseArchiveLinkerSymbols(members: RawMember[]): ArchiveSymbol[] {
  const symbols: ArchiveSymbol[] = [];
  for (const member of members.filter((entry) => entry.kind === 'linker-table')) {
    const data = member.data;
    const wide = member.name === '/SYM64/';
    const word = wide ? 8 : 4;
    if (data.length < word) continue;
    let count = 0;
    try { count = wide ? Number(data.readBigUInt64BE(0)) : data.readUInt32BE(0); } catch { continue; }
    if (!Number.isSafeInteger(count) || count < 0 || count > 2_000_000) continue;
    const offsetsStart = word;
    const namesStart = offsetsStart + count * word;
    if (namesStart > data.length) continue;
    let cursor = namesStart;
    for (let index = 0; index < count && cursor < data.length; index += 1) {
      let memberOffset: number | undefined;
      try { memberOffset = wide ? Number(data.readBigUInt64BE(offsetsStart + index * word)) : data.readUInt32BE(offsetsStart + index * word); } catch { memberOffset = undefined; }
      const end = data.indexOf(0, cursor);
      const stop = end >= 0 ? end : data.length;
      const name = data.toString('utf8', cursor, stop);
      if (name) symbols.push({ name, memberOffset });
      cursor = stop + 1;
    }
    if (symbols.length) break;
  }
  return symbols;
}

function classifyArchiveMember(name: string, data: Buffer): { kind: CviArchiveMemberKind; architecture?: string; machine?: number; importDll?: string; importSymbol?: string } {
  if (data.length >= 20 && data.readUInt16LE(0) === 0 && data.readUInt16LE(2) === 0xffff) {
    const machine = data.readUInt16LE(6);
    const strings = readNullStrings(data.subarray(20), 2);
    return { kind: 'import-object', architecture: machineLabel(machine), machine, importSymbol: strings[0], importDll: strings[1] };
  }
  if (data.length >= 20) {
    const machine = data.readUInt16LE(0);
    if ([0x014c, 0x8664, 0xaa64, 0x01c0, 0x01c4].includes(machine)) {
      return { kind: 'coff-object', architecture: machineLabel(machine), machine };
    }
  }
  if (data.length >= 20 && data[0] === 0x7f && data.toString('ascii', 1, 4) === 'ELF') {
    const little = data[5] !== 2;
    const machine = little ? data.readUInt16LE(18) : data.readUInt16BE(18);
    return { kind: 'elf-object', architecture: elfMachineLabel(machine), machine };
  }
  if (data.length >= 4 && data[0] === 0x42 && data[1] === 0x43 && data[2] === 0xc0 && data[3] === 0xde) return { kind: 'llvm-bitcode' };
  if (name === '/' || name === '/SYM64/') return { kind: 'linker-table' };
  if (name === '//') return { kind: 'longnames' };
  if (/^\/?(?:SYMDEF|__.SYMDEF)/i.test(name)) return { kind: 'metadata' };
  return { kind: 'unknown' };
}

function readArLongName(table: Buffer, offset: number): string {
  if (!Number.isFinite(offset) || offset < 0 || offset >= table.length) return `/<${offset}>`;
  let end = offset;
  while (end < table.length && table[end] !== 0x0a && table[end] !== 0x00) end += 1;
  return table.toString('utf8', offset, end).replace(/\/$/, '');
}

function readNullStrings(data: Buffer, max: number): string[] {
  const result: string[] = [];
  let cursor = 0;
  while (result.length < max && cursor < data.length) {
    const end = data.indexOf(0, cursor);
    const stop = end >= 0 ? end : data.length;
    result.push(data.toString('utf8', cursor, stop));
    if (end < 0) break;
    cursor = end + 1;
  }
  return result;
}

function scanLikelyDllNames(buffer: Buffer): string[] {
  const result: string[] = [];
  const ascii = buffer.toString('latin1');
  const regex = /(?:[A-Za-z0-9_.+\-]{1,100})\.dll\x00/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(ascii)) && result.length < 256) result.push(match[0].slice(0, -1));
  return unique(result);
}

function machineLabel(machine: number): string {
  switch (machine) {
    case 0x014c: return 'x86';
    case 0x8664: return 'x64';
    case 0xaa64: return 'ARM64';
    case 0x01c0:
    case 0x01c4: return 'ARM';
    default: return `COFF machine 0x${machine.toString(16).toUpperCase()}`;
  }
}

function elfMachineLabel(machine: number): string {
  switch (machine) {
    case 3: return 'x86';
    case 62: return 'x64';
    case 40: return 'ARM';
    case 183: return 'ARM64';
    case 243: return 'RISC-V';
    default: return `ELF machine ${machine}`;
  }
}

function archiveExtension(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.dll.a')) return '.dll.a';
  return path.extname(filePath).toLowerCase();
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/`/g, '\\`');
}
