import * as fs from 'fs';
import * as path from 'path';
import { IniDocument, IniSection } from './iniDocument';
import { CviBuildConfigurationDescriptor, CviBuildMode, CviProject, CviProjectFile, CviRunOptions, CviWorkspace, CviWorkspaceProjectRef } from './types';
import { createCviPathReference, fromCviPath, isCviAbsolutePath, quote, resolveCviReferencePath, splitCviLongValue, toCviPath, toCviRuntimeStoragePath, unquote } from '../utils/pathUtils';


export interface CviVersionInfoSettings {
  numericFileVersion: string;
  numericProductVersion: string;
  comments: string;
  companyName: string;
  fileDescription: string;
  fileVersion: string;
  internalName: string;
  legalCopyright: string;
  legalTrademarks: string;
  originalFilename: string;
  privateBuild: string;
  productName: string;
  productVersion: string;
  specialBuild: string;
}

export interface CviSigningSettings {
  enabled: boolean;
  store: string;
  certificate: string;
  timestampUrl: string;
  descriptionUrl: string;
  signDebugBuild: boolean;
}

export interface CviWorkspaceBreakpoint {
  filePath: string;
  line: number;
}

export interface CviWorkspaceBreakpointSyncResult {
  changed: boolean;
  requestedCount: number;
  appliedCount: number;
  preservedNativeCount: number;
  removedTrackedCount: number;
  removedNativeCount: number;
  createdWorkspaceFileSections: string[];
  ignoredBreakpoints: CviWorkspaceBreakpoint[];
  trackedBreakpoints: CviWorkspaceBreakpoint[];
}

export interface CviNativeCompilerSettings {
  is64Bit: boolean;
  isRelease: boolean;
  defaultCallingConvention: string;
  optimizationLevel: string;
  supportsOptimizationLevel: boolean;
  requirePrototypes: boolean;
  showWarningIdsInBuildOutput: boolean;
  supportsWarningProfile: boolean;
  selectedWarningLevel: string;
  warningListNone: string;
  warningListCommon: string;
  warningListExtended: string;
  warningListAll: string;
  warningMode: string;
  enablePointerMismatchWarning: boolean;
  enableUnreachableCodeWarning: boolean;
  enableUnreferencedIdentifiersWarning: boolean;
  enableAssignmentInConditionalWarning: boolean;
  uninitializedLocalsCompileWarning: string;
  requireReturnValues: boolean;
  enableC99Extensions: boolean;
  enableOpenMpExtensions: boolean;
  supportsOpenMp: boolean;
  stackSize: string;
  stackReserve: string;
  stackCommit: string;
  supportsStackReserveCommit: boolean;
  imageBaseAddress: string;
  imageBaseAddress64: string;
  compilerDefines: string;
}

export interface CviProjectCompilerSettings {
  includePaths: string[];
  oOptionCompatibleWith50: boolean;
  precompilePrefixHeader: boolean;
  prefixHeaderFile: string;
}

export interface CviExternalCompilerSupportSettings {
  uirCallbacksFileOption: string;
  usingLoadExternalModule: boolean;
  createProjectSymbolsFile: boolean;
  uirCallbacksObjFile: string;
  projectSymbolsHeaderFile: string;
  projectSymbolsObjFile: string;
}

export interface CviWorkspaceNativeBuildOptions {
  generateBrowseInfo: boolean;
  enableUninitializedLocalsRuntimeWarning: boolean;
  batchBuild: boolean;
  profile: string;
  debuggingLevel: string;
  executionTrace: string;
  breakOnLibraryErrors: boolean;
  breakOnFirstChanceExceptions: boolean;
}

export interface CviCompilerConfigurationIssue {
  severity: 'warning' | 'error';
  field: string;
  message: string;
}

export interface CviNativeTargetSettings {
  targetType: string;
  outputPath: string;
  applicationTitle: string;
  iconFile: string;
  runtimeSupport: string;
  runtimeBinding: string;
  generateSourceDocumentation: string;
  manifestEmbed: boolean;
  manifestPath: string;
  embedProjectUirs: boolean;
  generateMapFile: boolean;
  createConsoleApplication: boolean;
  embedTimestamp: boolean;
  usingLoadExternalModule: boolean;
  forcedModules: string[];
  useDefaultImportLibBaseName: boolean;
  dllImportLibraryChoice: string;
  importLibBaseName: string;
  whereToCopyDll: string;
  customDirectoryToCopyDll: string;
  useIviSubdirectoriesForImportLibraries: boolean;
  useVxiPnpSubdirectoriesForImportLibraries: boolean;
  dllExports: string;
  exportFiles: string[];
  addTypeLibToDll: boolean;
  includeTypeLibHelpLinks: boolean;
  tlbHelpStyle: string;
  typeLibFpFile: string;
  addNiTypeInfoToDll: boolean;
  useSingleHeaderForNiTypeInfo: boolean;
  singleHeaderNiTypeInfoFile: string;
  versionInfo: CviVersionInfoSettings;
  signing: CviSigningSettings;
}

export type CviNativeTextEncoding = 'utf8' | 'utf8-bom' | 'utf16le-bom' | 'ansi-byte-preserving';

export interface CviNativeTextInfo {
  encoding: CviNativeTextEncoding;
  byteLength: number;
  text: string;
}

export interface CviNativeCompatibilityReport {
  formatVersion?: number;
  approximateReleaseYear?: number;
  encoding: CviNativeTextEncoding;
  warnings: string[];
  notes: string[];
}

function isValidUtf8(buffer: Buffer): boolean {
  if (buffer.length === 0) return true;
  const decoded = buffer.toString('utf8');
  return Buffer.from(decoded, 'utf8').equals(buffer);
}

function decodeNativeText(buffer: Buffer): CviNativeTextInfo {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { encoding: 'utf8-bom', byteLength: buffer.length, text: buffer.subarray(3).toString('utf8') };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { encoding: 'utf16le-bom', byteLength: buffer.length, text: buffer.subarray(2).toString('utf16le') };
  }
  if (isValidUtf8(buffer)) {
    return { encoding: 'utf8', byteLength: buffer.length, text: buffer.toString('utf8') };
  }
  // Legacy CVI projects can be stored using the active ANSI code page. Node does not
  // expose the Windows ACP directly, so latin1 is intentionally used as a byte-preserving
  // 1:1 mapping. Existing non-ASCII bytes therefore survive parse/edit/write unchanged.
  return { encoding: 'ansi-byte-preserving', byteLength: buffer.length, text: buffer.toString('latin1') };
}

function encodeNativeText(text: string, encoding: CviNativeTextEncoding): Buffer {
  switch (encoding) {
    case 'utf8-bom':
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
    case 'utf16le-bom':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    case 'ansi-byte-preserving': {
      for (let index = 0; index < text.length; index += 1) {
        if (text.charCodeAt(index) > 0xff) {
          throw new Error('The native CVI file uses a legacy ANSI encoding and the edited content contains characters that cannot be preserved byte-for-byte. Save/convert the file to UTF-8 in CVI first, or use characters supported by the original system code page.');
        }
      }
      return Buffer.from(text, 'latin1');
    }
    default:
      return Buffer.from(text, 'utf8');
  }
}

export function inspectNativeTextEncoding(filePath: string): CviNativeTextInfo {
  return decodeNativeText(fs.readFileSync(filePath));
}

interface NativeMutationSnapshot {
  buffer: Buffer;
  text: string;
}

function readText(filePath: string): string {
  return inspectNativeTextEncoding(filePath).text;
}

function readTextForMutation(filePath: string): NativeMutationSnapshot {
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (error) {
    throw new Error(`Cannot read ${filePath}. The file may be unavailable, disconnected, or permission-protected: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { buffer, text: decodeNativeText(buffer).text };
}

function assertWritableFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    throw new Error(`Cannot access ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!stat.isFile()) throw new Error(`Cannot update ${filePath}: the path is not a regular file.`);
  if ((stat.mode & 0o222) === 0) throw new Error(`Cannot update ${filePath}: the file is read-only.`);
  try {
    fs.accessSync(filePath, fs.constants.W_OK);
  } catch {
    throw new Error(`Cannot update ${filePath}: write permission is denied or the location is unavailable.`);
  }
}

function assertReadableRegularFile(filePath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    throw new Error(`Cannot add/replace file ${filePath}: the file is missing, disconnected, or inaccessible: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!stat.isFile()) throw new Error(`Cannot add/replace file ${filePath}: the path is not a regular file.`);
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
  } catch {
    throw new Error(`Cannot add/replace file ${filePath}: read permission is denied.`);
  }
}

function writeText(filePath: string, content: string, expectedOriginal?: Buffer): void {
  const currentBuffer = fs.existsSync(filePath) ? fs.readFileSync(filePath) : undefined;
  if (expectedOriginal !== undefined && (currentBuffer === undefined || !currentBuffer.equals(expectedOriginal))) {
    throw new Error(`${path.basename(filePath)} changed on disk while CVI Project Manager was preparing the operation. The write was cancelled to avoid overwriting changes made by LabWindows/CVI or another process. Refresh the project and retry.`);
  }
  const currentInfo = currentBuffer ? decodeNativeText(currentBuffer) : undefined;
  if (currentInfo?.text === content) {
    return;
  }
  assertWritableFile(filePath);
  validateNativeDocument(filePath, content);
  if (currentBuffer !== undefined && isNativeCviDocument(filePath)) {
    createNativeBackup(filePath, currentBuffer);
  }
  const targetEncoding = currentInfo?.encoding ?? 'utf8';
  const rendered = encodeNativeText(content, targetEncoding);
  const temporaryPath = `${filePath}.vscode-cvi-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, rendered);
    fs.copyFileSync(temporaryPath, filePath);
  } catch (error) {
    throw new Error(`Cannot write ${filePath}. The file or directory may be read-only, locked, disconnected, or unavailable: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* ignored */ }
  }
}

function isNativeCviDocument(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return extension === '.cws' || extension === '.prj';
}

function validateNativeDocument(filePath: string, content: string): void {
  if (!isNativeCviDocument(filePath)) {
    return;
  }
  const document = IniDocument.parse(content);
  const extension = path.extname(filePath).toLowerCase();
  const requiredSection = extension === '.cws' ? 'Workspace Header' : 'Project Header';
  const header = document.getSection(requiredSection);
  if (!header) {
    throw new Error(`Refusing to overwrite ${path.basename(filePath)}: generated content is missing [${requiredSection}].`);
  }

  for (const section of document.sections) {
    for (const { key, value } of section.entries()) {
      if (!/Rel Path(?: Line\d{4})?$/i.test(key)) {
        continue;
      }
      const stored = unquote(value) ?? '';
      if (/^[A-Za-z]:[\\/]/.test(stored) || /^\/[A-Za-z]\//.test(stored)) {
        throw new Error(`Refusing to overwrite ${path.basename(filePath)}: ${section.name}/${key} contains an absolute path in a relative-path field (${stored}).`);
      }
    }
  }

  if (extension === '.cws') {
    const projectCount = Number(header.get('Number of Projects') ?? '0');
    const entries = header.entries().filter(({ key, value }) => /^Project \d{4}$/i.test(key) && Boolean((unquote(value) ?? '').trim()));
    if (entries.length !== projectCount) {
      throw new Error(`Refusing to overwrite ${path.basename(filePath)}: Number of Projects=${projectCount}, but ${entries.length} non-empty Project NNNN entries exist.`);
    }
    for (let index = 1; index <= projectCount; index += 1) {
      const projectKey = `Project ${String(index).padStart(4, '0')}`;
      if (!(unquote(header.get(projectKey)) ?? '').trim()) {
        throw new Error(`Refusing to overwrite ${path.basename(filePath)}: ${projectKey} is empty while Number of Projects=${projectCount}.`);
      }
    }
    const active = Number(header.get('Active Project') ?? (projectCount > 0 ? '1' : '0'));
    if ((projectCount === 0 && active !== 0) || (projectCount > 0 && (!Number.isInteger(active) || active < 1 || active > projectCount))) {
      throw new Error(`Refusing to overwrite ${path.basename(filePath)}: Active Project=${active} is invalid for ${projectCount} project(s).`);
    }
    const fileSections = document.sections.filter((section) => /^File \d{4}$/i.test(section.name));
    // "Number of Opened Files" is CVI UI/session state, not the number of [File NNNN]
    // workspace reference sections. Real CVI workspaces can legitimately contain many
    // more [File] sections than currently opened editor windows. Preserve this field.
    for (const section of document.sections) {
      const projectSectionMatch = section.name.match(WORKSPACE_PROJECT_SECTION_PATTERN);
      if (projectSectionMatch) {
        const index = Number(projectSectionMatch[2]);
        if (index < 1 || index > projectCount) throw new Error(`Refusing to overwrite ${path.basename(filePath)}: orphaned section [${section.name}].`);
      }
      if (/^File \d{4}$/i.test(section.name)) {
        for (const index of parseWorkspaceMemberships(section)) {
          if (index < 1 || index > projectCount) throw new Error(`Refusing to overwrite ${path.basename(filePath)}: [${section.name}] references missing project ${index}.`);
        }
      }
    }
  } else {
    // Be deliberately permissive with pre-existing CVI project indexing. Native CVI
    // accepts projects where Number of Files is stale, [File NNNN] identifiers contain
    // gaps, and file sections are serialized in an order unrelated to their numeric ID.
    // These are legacy/native layout details, not corruption. Operation-specific code
    // validates the entry it creates or changes; the generic write barrier must not block
    // an unrelated Replace/Add because of a CVI-tolerated pre-existing layout.
    const fileSections = document.sections.filter((section) => /^File \d{4}$/i.test(section.name));
    const seenSectionNames = new Set<string>();
    for (const section of fileSections) {
      const key = section.name.toLowerCase();
      if (seenSectionNames.has(key)) {
        throw new Error(`Refusing to overwrite ${path.basename(filePath)}: duplicate section [${section.name}] makes the target file ambiguous.`);
      }
      seenSectionNames.add(key);
    }
  }
}

function createNativeBackup(filePath: string, content: Buffer): string {
  const backupDirectory = path.join(path.dirname(filePath), '.vscode', 'cvi-native-backups');
  fs.mkdirSync(backupDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDirectory, `${path.basename(filePath)}.${stamp}.bak`);
  fs.writeFileSync(backupPath, content);
  const prefix = `${path.basename(filePath)}.`;
  const backups = fs.readdirSync(backupDirectory)
    .filter((name: string) => name.startsWith(prefix) && name.endsWith('.bak'))
    .sort();
  while (backups.length > 20) {
    const oldest = backups.shift();
    if (oldest) {
      try { fs.rmSync(path.join(backupDirectory, oldest), { force: true }); } catch { /* ignored */ }
    }
  }
  return backupPath;
}

function deletePossiblyLongValue(section: IniSection, key: string): void {
  section.delete(key);
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  section.deleteMatching(new RegExp(`^\\s*${escapedKey} Line\\d{4}\\s*=`, 'i'));
}

function setPossiblyLongRuntimePathValue(section: IniSection, key: string, value: string): void {
  setPossiblyLongStringValue(section, key, toCviRuntimeStoragePath(value));
}

function reconstructValue(section: IniSection, key: string): string | undefined {
  const direct = section.get(key);
  if (direct !== undefined) {
    return unquote(direct);
  }

  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const linePattern = new RegExp(`^${escapedKey} Line(\\d{4})$`, 'i');
  const parts = section.entries()
    .map(({ key: entryKey, value }) => {
      const match = entryKey.match(linePattern);
      return match ? { index: Number(match[1]), value: unquote(value) ?? '' } : undefined;
    })
    .filter((entry): entry is { index: number; value: string } => entry !== undefined)
    .sort((a, b) => a.index - b.index);

  return parts.length > 0 ? parts.map((entry) => entry.value).join('') : undefined;
}

function setPossiblyLongValue(section: IniSection, key: string, value: string): void {
  section.delete(key);
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  section.deleteMatching(new RegExp(`^\\s*${escapedKey} Line\\d{4}\\s*=`, 'i'));

  const cviValue = toCviPath(value);
  const chunks = splitCviLongValue(cviValue);
  if (chunks.length === 1) {
    section.set(key, quote(chunks[0]));
    return;
  }
  chunks.forEach((chunk, index) => section.set(`${key} Line${String(index + 1).padStart(4, '0')}`, quote(chunk)));
}

function setPossiblyLongStringValue(section: IniSection, key: string, value: string): void {
  section.delete(key);
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  section.deleteMatching(new RegExp(`^\\s*${escapedKey} Line\\d{4}\\s*=`, 'i'));
  const chunks = splitCviLongValue(value);
  if (chunks.length === 1) {
    section.set(key, quote(chunks[0]));
    return;
  }
  chunks.forEach((chunk, index) => section.set(`${key} Line${String(index + 1).padStart(4, '0')}`, quote(chunk)));
}

function getProjectModeSection(document: IniDocument, mode: CviBuildMode): IniSection {
  const sectionName = `Default Build Config ${modeSuffix(mode)}`;
  const section = document.getSection(sectionName);
  if (!section) {
    throw new Error(`Invalid CVI project: missing [${sectionName}].`);
  }
  return section;
}

function excludeEligibleFileType(fileType: string, filePath = ''): boolean {
  const normalized = fileType.trim().toLowerCase();
  if (['csource', 'library', 'dll', 'object', 'object file'].includes(normalized)) return true;
  const extension = path.extname(filePath).toLowerCase();
  return ['.c', '.lib', '.obj', '.dll'].includes(extension);
}

function buildConfigurationDescriptors(document: IniDocument): CviBuildConfigurationDescriptor[] {
  const result: CviBuildConfigurationDescriptor[] = [];
  for (const section of document.sections) {
    const name = unquote(section.get('Config Name'))?.trim();
    if (!name) continue;
    const sectionModeMatch = section.name.match(/^Default Build Config (Debug|Release|Debug64|Release64)$/i);
    const mode = sectionModeMatch ? buildModeFromNativeConfiguration(sectionModeMatch[1]) : undefined;
    const looksLikeBuildConfiguration = Boolean(mode) || section.has('Is 64-Bit') || section.has('Is Release');
    if (!looksLikeBuildConfiguration) continue;
    const fallbackMode = mode ?? buildModeFromNativeConfiguration(name);
    result.push({
      name,
      sectionName: section.name,
      is64Bit: parseBoolean(section.get('Is 64-Bit'), fallbackMode === 'debug64' || fallbackMode === 'release64'),
      isRelease: parseBoolean(section.get('Is Release'), fallbackMode === 'release' || fallbackMode === 'release64'),
      isCustom: !mode,
      mode
    });
  }
  return result;
}

function compilerSettingsFromSection(document: IniDocument, config: IniSection, fallbackMode?: CviBuildMode): CviNativeCompilerSettings {
  const compilerOptions = document.getSection('Compiler Options') ?? new IniSection('Compiler Options', []);
  const runOptions = document.getSection('Run Options') ?? new IniSection('Run Options', []);
  const compilerDefines = document.getSection('Compiler Defines') ?? new IniSection('Compiler Defines', []);
  const stringValue = (key: string, fallbackSection?: IniSection): string => unquote(config.get(key)) ?? (fallbackSection ? unquote(fallbackSection.get(key)) : undefined) ?? '';
  const boolValue = (key: string, fallbackSection?: IniSection, fallback = false): boolean => config.has(key)
    ? parseBoolean(config.get(key), fallback)
    : parseBoolean(fallbackSection?.get(key), fallback);
  const fallback64 = fallbackMode === 'debug64' || fallbackMode === 'release64';
  const fallbackRelease = fallbackMode === 'release' || fallbackMode === 'release64';
  return {
    is64Bit: parseBoolean(config.get('Is 64-Bit'), fallback64),
    isRelease: parseBoolean(config.get('Is Release'), fallbackRelease),
    defaultCallingConvention: stringValue('Default Calling Convention', compilerOptions) || 'cdecl',
    optimizationLevel: stringValue('Optimization Level'),
    supportsOptimizationLevel: config.has('Optimization Level'),
    requirePrototypes: boolValue('Require Prototypes', compilerOptions, true),
    showWarningIdsInBuildOutput: boolValue('Show Warning IDs in Build Output'),
    supportsWarningProfile: config.has('Selected Warning Level') || config.has('Warning Mode') || config.has('Warning List Common'),
    selectedWarningLevel: stringValue('Selected Warning Level'),
    warningListNone: stringValue('Warning List None'),
    warningListCommon: stringValue('Warning List Common'),
    warningListExtended: stringValue('Warning List Extended'),
    warningListAll: stringValue('Warning List All'),
    warningMode: unquote(config.get('Warning Mode')) ?? config.get('Warning Mode') ?? '',
    enablePointerMismatchWarning: boolValue('Enable Pointer Mismatch Warning', compilerOptions),
    enableUnreachableCodeWarning: boolValue('Enable Unreachable Code Warning', compilerOptions),
    enableUnreferencedIdentifiersWarning: boolValue('Enable Unreferenced Identifiers Warning', compilerOptions),
    enableAssignmentInConditionalWarning: boolValue('Enable Assignment In Conditional Warning', compilerOptions),
    uninitializedLocalsCompileWarning: stringValue('Uninitialized Locals Compile Warning', compilerOptions) || 'Conservative',
    requireReturnValues: boolValue('Require Return Values', compilerOptions, true),
    enableC99Extensions: boolValue('Enable C99 Extensions', compilerOptions, true),
    enableOpenMpExtensions: boolValue('Enable OpenMP Extensions'),
    supportsOpenMp: config.has('Enable OpenMP Extensions'),
    stackSize: unquote(config.get('Stack Size')) ?? config.get('Stack Size') ?? unquote(runOptions.get('Stack Size')) ?? runOptions.get('Stack Size') ?? '',
    stackReserve: unquote(config.get('Stack Reserve')) ?? config.get('Stack Reserve') ?? '',
    stackCommit: unquote(config.get('Stack Commit')) ?? config.get('Stack Commit') ?? '',
    supportsStackReserveCommit: config.has('Stack Reserve') || config.has('Stack Commit'),
    imageBaseAddress: unquote(config.get('Image Base Address')) ?? config.get('Image Base Address') ?? unquote(runOptions.get('Image Base Address')) ?? runOptions.get('Image Base Address') ?? '',
    imageBaseAddress64: unquote(config.get('Image Base Address x64')) ?? config.get('Image Base Address x64') ?? unquote(runOptions.get('Image Base Address x64')) ?? runOptions.get('Image Base Address x64') ?? '',
    compilerDefines: reconstructValue(config, 'Compiler Defines') ?? reconstructValue(compilerDefines, 'Compiler Defines') ?? ''
  };
}

function writeNativeCompilerSettingsToSection(config: IniSection, settings: CviNativeCompilerSettings, forcedMode?: CviBuildMode): void {
  const is64Bit = forcedMode ? (forcedMode === 'debug64' || forcedMode === 'release64') : settings.is64Bit;
  const isRelease = forcedMode ? (forcedMode === 'release' || forcedMode === 'release64') : settings.isRelease;
  setBoolean(config, 'Is 64-Bit', is64Bit);
  setBoolean(config, 'Is Release', isRelease);
  config.set('Default Calling Convention', quote(settings.defaultCallingConvention || 'cdecl'));
  setBoolean(config, 'Require Prototypes', settings.requirePrototypes);
  setBoolean(config, 'Enable Pointer Mismatch Warning', settings.enablePointerMismatchWarning);
  setBoolean(config, 'Enable Unreachable Code Warning', settings.enableUnreachableCodeWarning);
  setBoolean(config, 'Enable Unreferenced Identifiers Warning', settings.enableUnreferencedIdentifiersWarning);
  setBoolean(config, 'Enable Assignment In Conditional Warning', settings.enableAssignmentInConditionalWarning);
  config.set('Uninitialized Locals Compile Warning', quote(settings.uninitializedLocalsCompileWarning || 'Conservative'));
  setBoolean(config, 'Require Return Values', settings.requireReturnValues);
  setBoolean(config, 'Enable C99 Extensions', settings.enableC99Extensions);
  config.set('Stack Size', settings.stackSize || '250000');
  config.set('Image Base Address', settings.imageBaseAddress || '4194304');
  config.set('Image Base Address x64', settings.imageBaseAddress64 || settings.imageBaseAddress || '4194304');
  setPossiblyLongStringValue(config, 'Compiler Defines', settings.compilerDefines.trim());
  if (config.has('Optimization Level')) config.set('Optimization Level', quote(settings.optimizationLevel));
  if (config.has('Show Warning IDs in Build Output')) setBoolean(config, 'Show Warning IDs in Build Output', settings.showWarningIdsInBuildOutput);
  if (config.has('Selected Warning Level')) config.set('Selected Warning Level', quote(settings.selectedWarningLevel));
  if (config.has('Warning List None')) config.set('Warning List None', quote(settings.warningListNone));
  if (config.has('Warning List Common')) config.set('Warning List Common', quote(settings.warningListCommon));
  if (config.has('Warning List Extended')) config.set('Warning List Extended', quote(settings.warningListExtended));
  if (config.has('Warning List All')) config.set('Warning List All', quote(settings.warningListAll));
  if (config.has('Warning Mode')) config.set('Warning Mode', settings.warningMode || '0');
  if (config.has('Enable OpenMP Extensions')) setBoolean(config, 'Enable OpenMP Extensions', settings.enableOpenMpExtensions);
  if (config.has('Stack Reserve')) config.set('Stack Reserve', settings.stackReserve || '1048576');
  if (config.has('Stack Commit')) config.set('Stack Commit', settings.stackCommit || '4096');
}

function setBoolean(section: IniSection, key: string, value: boolean): void {
  section.set(key, value ? 'True' : 'False');
}

function parseStringList(section: IniSection | undefined, keyPattern: RegExp): string[] {
  if (!section) {
    return [];
  }
  return section.entries()
    .filter(({ key }) => keyPattern.test(key))
    .sort((left, right) => numericSuffix(left.key) - numericSuffix(right.key))
    .map(({ value }) => unquote(value) ?? '')
    .filter(Boolean);
}

function writeStringList(section: IniSection, prefix: string, values: string[], withRelativeFlag = false): void {
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  section.deleteMatching(new RegExp(`^\\s*${escapedPrefix} \\d{4}(?: Is Rel)?\\s*=`, 'i'));
  values.map((value) => value.trim()).filter(Boolean).forEach((value, index) => {
    const suffix = String(index + 1).padStart(4, '0');
    if (withRelativeFlag) {
      section.set(`${prefix} ${suffix} Is Rel`, 'False');
    }
    section.set(`${prefix} ${suffix}`, quote(value));
  });
}

function resolveStoredPath(section: IniSection, key: string): string {
  const value = reconstructValue(section, key) ?? '';
  return value ? fromCviPath(value) : '';
}

function resolveProjectStoredReference(projectPath: string, section: IniSection, key: string): string {
  const relativeFlag = section.get(`${key} Is Rel`);
  const relativePath = reconstructValue(section, `${key} Rel Path`);
  const relativeTo = unquote(section.get(`${key} Rel To`))?.toLowerCase();
  if ((relativeFlag === undefined || parseBoolean(relativeFlag)) && relativePath && (!relativeTo || relativeTo === 'project')) {
    return resolveCviReferencePath(dirnameForPath(projectPath), relativePath);
  }
  const direct = reconstructValue(section, key);
  return direct ? fromCviPath(direct) : (relativePath ? resolveCviReferencePath(dirnameForPath(projectPath), relativePath) : '');
}

function tokenizeCompilerDefines(value: string): string[] {
  const result: string[] = [];
  let token = '';
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    if (ch === '"') {
      quoted = !quoted;
      token += ch;
      continue;
    }
    if (/\s/.test(ch) && !quoted) {
      if (token.trim()) {
        result.push(token.trim());
        token = '';
      }
      continue;
    }
    token += ch;
  }
  if (token.trim()) {
    result.push(token.trim());
  }
  return result;
}

function compilerDefineIssues(value: string): CviCompilerConfigurationIssue[] {
  const issues: CviCompilerConfigurationIssue[] = [];
  for (const token of tokenizeCompilerDefines(value)) {
    if (!/^\/D[A-Za-z_][A-Za-z0-9_]*(?:=(?:"[^"]*"|\S+))?$/i.test(token)) {
      issues.push({
        severity: 'warning',
        field: 'Compiler Defines',
        message: `Compiler define token ${JSON.stringify(token)} does not use the expected /DNAME or /DNAME=value syntax.`
      });
    }
  }
  return issues;
}

function resolveProjectReferencedPath(projectDirectory: string, value: string): string {
  return resolveCviReferencePath(projectDirectory, value);
}

function projectRelativePath(projectDirectory: string, absolutePath: string): string | undefined {
  const reference = createCviPathReference(projectDirectory, absolutePath);
  return reference.isRelative ? reference.relativePath : undefined;
}

function setProjectReferencedPath(section: IniSection, key: string, projectPath: string, value: string): void {
  const trimmed = value.trim();
  deletePossiblyLongValue(section, `${key} Rel Path`);
  section.delete(`${key} Rel To`);
  if (!trimmed) {
    section.set(`${key} Is Rel`, 'False');
    setPossiblyLongStringValue(section, key, '');
    return;
  }
  const projectDirectory = path.dirname(projectPath);
  const absolutePath = resolveProjectReferencedPath(projectDirectory, trimmed);
  const relativePath = projectRelativePath(projectDirectory, absolutePath);
  if (relativePath !== undefined) {
    section.set(`${key} Is Rel`, 'True');
    section.set(`${key} Rel To`, quote('Project'));
    setPossiblyLongStringValue(section, `${key} Rel Path`, relativePath);
  } else {
    section.set(`${key} Is Rel`, 'False');
  }
  setPossiblyLongValue(section, key, absolutePath);
}

function resolveOutputPathBySuffix(section: IniSection, suffix: string, projectPath: string): string | undefined {
  const key = `Executable File_${suffix}`;
  const relativeFlag = section.get(`${key} Is Rel`);
  const relativePath = reconstructValue(section, `${key} Rel Path`);
  const absoluteValue = reconstructValue(section, key);

  // When CVI explicitly marks the output as absolute, any stale Rel Path must be ignored.
  if (relativeFlag !== undefined && !parseBoolean(relativeFlag)) {
    return absoluteValue ? fromCviPath(absoluteValue) : undefined;
  }

  if ((relativeFlag === undefined || parseBoolean(relativeFlag)) && relativePath) {
    return resolveCviReferencePath(dirnameForPath(projectPath), relativePath);
  }

  // Legacy files may omit the Is Rel flag while still carrying only the absolute value.
  return absoluteValue ? fromCviPath(absoluteValue) : undefined;
}

function resolveOutputPath(section: IniSection, mode: CviBuildMode, projectPath: string): string | undefined {
  return resolveOutputPathBySuffix(section, modeSuffix(mode), projectPath);
}

function setOutputPathBySuffix(section: IniSection, suffix: string, projectPath: string, value: string): void {
  const normalizedSuffix = suffix.trim();
  if (!normalizedSuffix || /[\r\n]/.test(normalizedSuffix)) {
    throw new Error('The CVI build configuration name cannot be empty and cannot contain line breaks.');
  }
  const key = `Executable File_${normalizedSuffix}`;
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('The target output path cannot be empty.');
  }
  const projectDirectory = dirnameForPath(projectPath);
  const absolutePath = resolveProjectReferencedPath(projectDirectory, trimmed);
  const relativePath = projectRelativePath(projectDirectory, absolutePath);
  deletePossiblyLongValue(section, `${key} Rel Path`);
  section.delete(`${key} Rel To`);
  if (relativePath !== undefined) {
    section.set(`${key} Is Rel`, 'True');
    section.set(`${key} Rel To`, quote('Project'));
    setPossiblyLongStringValue(section, `${key} Rel Path`, relativePath);
  } else {
    section.set(`${key} Is Rel`, 'False');
  }
  setPossiblyLongValue(section, key, absolutePath);
}

function setOutputPath(section: IniSection, mode: CviBuildMode, projectPath: string, value: string): void {
  setOutputPathBySuffix(section, modeSuffix(mode), projectPath, value);
}


function collectConfiguredRunValues(document: IniDocument): Map<string, Map<string, Set<string>>> {
  const result = new Map<string, Map<string, Set<string>>>();
  for (const section of document.sections) {
    const match = section.name.match(/^Default Build Config (\d{4}) (?:Debug|Release|Debug64|Release64)$/i);
    if (!match) {
      continue;
    }
    let valuesByKey = result.get(match[1]);
    if (!valuesByKey) {
      valuesByKey = new Map<string, Set<string>>();
      result.set(match[1], valuesByKey);
    }
    for (const key of ['Command Line Args', 'Working Directory', 'Environment Options', 'External Process Path']) {
      const value = reconstructValue(section, key) ?? '';
      if (!value) {
        continue;
      }
      let values = valuesByKey.get(key);
      if (!values) {
        values = new Set<string>();
        valuesByKey.set(key, values);
      }
      values.add(value);
    }
  }
  return result;
}

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (!value) {
    return fallback;
  }
  return value.trim().toLowerCase() === 'true';
}

function fileTypeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.c': return 'CSource';
    case '.h': return 'Include';
    case '.uir': return 'User Interface Resource';
    case '.fp': return 'Function Panel';
    case '.lib': return 'Library';
    case '.obj': return 'Object';
    default: return 'Unknown';
  }
}

export function defaultFolderForType(fileType: string): string {
  switch (fileType) {
    case 'CSource': return 'Source Files';
    case 'Include': return 'Include Files';
    case 'User Interface Resource': return 'User Interface Files';
    case 'Function Panel': return 'Instrument Files';
    case 'Library': return 'Library Files';
    default: return 'Not In A Folder';
  }
}

function resolveProjectFilePath(projectPath: string, section: IniSection): { absolutePath: string; relativePath?: string } {
  const projectDirectory = path.dirname(projectPath);
  const relativePath = unquote(section.get('Path Rel Path'));
  const isRelative = parseBoolean(section.get('Path Is Rel'), relativePath !== undefined);
  const relativeTo = unquote(section.get('Path Rel To'))?.toLowerCase();

  if (relativePath && isRelative && (!relativeTo || relativeTo === 'project')) {
    return { absolutePath: resolveCviReferencePath(projectDirectory, relativePath), relativePath };
  }

  const absoluteValue = reconstructValue(section, 'Path');
  if (absoluteValue) {
    return { absolutePath: fromCviPath(absoluteValue), relativePath };
  }

  if (relativePath) {
    return { absolutePath: resolveCviReferencePath(projectDirectory, relativePath), relativePath };
  }

  return { absolutePath: path.join(projectDirectory, `unknown-${section.name}`) };
}

function modeSuffix(mode: CviBuildMode): string {
  switch (mode) {
    case 'debug': return 'Debug';
    case 'release': return 'Release';
    case 'debug64': return 'Debug64';
    case 'release64': return 'Release64';
  }
}

function buildModeFromNativeConfiguration(value: string | undefined): CviBuildMode | undefined {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'debug': return 'debug';
    case 'release': return 'release';
    case 'debug64':
    case 'debug x64': return 'debug64';
    case 'release64':
    case 'release x64': return 'release64';
    default: return undefined;
  }
}



function pathApiFor(filePath: string): typeof path {
  return /^[A-Za-z]:[\\/]/.test(filePath) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(filePath)
    ? path.win32
    : path;
}

function dirnameForPath(filePath: string): string {
  return pathApiFor(filePath).dirname(filePath);
}

function replaceExtension(filePath: string, extension: string): string {
  const api = pathApiFor(filePath);
  return api.join(api.dirname(filePath), `${api.basename(filePath, api.extname(filePath))}${extension}`);
}

function normalizeLogicalFolder(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/').trim();
}

const CVI_ROOT_FOLDER = 'Not In A Folder';

function projectFolderForUi(value: string): string {
  const normalized = normalizeLogicalFolder(value);
  return normalized.toLowerCase() === CVI_ROOT_FOLDER.toLowerCase() ? '' : normalized;
}

function projectFolderForStorage(value: string): string {
  const normalized = normalizeLogicalFolder(value);
  return normalized || CVI_ROOT_FOLDER;
}

function validateFlatLogicalFolder(folder: string): void {
  const normalized = normalizeLogicalFolder(folder);
  if (!normalized || normalized.toLowerCase() === CVI_ROOT_FOLDER.toLowerCase()) {
    return;
  }
  if (/[\\/]/.test(folder)) {
    throw new Error('LabWindows/CVI logical folders are single-level. Use a folder name without / or \\.');
  }
}

function updateProjectFileCount(document: IniDocument): void {
  const header = document.getSection('Project Header');
  if (!header) return;
  // CVI project section numbers are stable resource identifiers, not array positions.
  // Native CVI projects legitimately keep gaps and may serialize [File NNNN] sections
  // in an arbitrary physical order. Never renumber existing sections as a side effect
  // of Remove/Delete/Repair; only keep the count synchronized when the file set changes.
  const files = document.sections.filter((section) => /^File \d{4}$/i.test(section.name));
  header.set('Number of Files', String(files.length));
}

function addProjectFileSection(document: IniDocument, section: IniSection): void {
  const fileIndexes = document.sections
    .map((candidate, index) => /^File \d{4}$/i.test(candidate.name) ? index : -1)
    .filter((index) => index >= 0);
  if (fileIndexes.length > 0) {
    // Keep the existing native section layout intact and append after the last physical
    // [File] block. This works for both common layouts ([Folders] before files or after
    // files) and avoids moving legacy sections around. Numeric section IDs remain stable.
    document.sections.splice(Math.max(...fileIndexes) + 1, 0, section);
    return;
  }
  const foldersIndex = document.sections.findIndex((candidate) => candidate.name.toLowerCase() === 'folders');
  if (foldersIndex >= 0) document.sections.splice(foldersIndex + 1, 0, section);
  else document.sections.push(section);
}

function projectUsesFolderIds(document: IniDocument): boolean {
  const files = document.sections.filter((section) => /^File \d{4}$/i.test(section.name));
  if (files.length > 0) {
    // Preserve the style already used by the native project instead of upgrading old
    // files opportunistically. CVI 2012 projects commonly use Folder without Folder Id.
    return files.some((section) => section.get('Folder Id') !== undefined);
  }
  const version = Number(document.getSection('Project Header')?.get('Version') ?? '0');
  return Number.isFinite(version) && version >= 1300;
}

function flattenLogicalFolder(folder: string): string {
  return folder.split(/[\\/]+/).map((part) => part.trim()).filter(Boolean).join(' - ');
}

function isSameOrDescendantFolder(candidate: string, parent: string): boolean {
  const normalizedCandidate = normalizeLogicalFolder(candidate).toLowerCase();
  const normalizedParent = normalizeLogicalFolder(parent).toLowerCase();
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}/`);
}

function replaceFolderPrefix(candidate: string, oldPrefix: string, newPrefix: string): string {
  const suffix = normalizeLogicalFolder(candidate).slice(normalizeLogicalFolder(oldPrefix).length).replace(/^\/+/, '');
  return [normalizeLogicalFolder(newPrefix), suffix].filter(Boolean).join('/');
}


function numericSuffix(value: string): number {
  const match = value.match(/(\d+)$/);
  return match ? Number(match[1]) : 0;
}


const WORKSPACE_BUILD_MODES = ['Debug', 'Release', 'Debug64', 'Release64'] as const;

function workspaceProjectSuffix(projectIndex: number): string {
  return String(projectIndex).padStart(4, '0');
}

function addWorkspaceSectionIfMissing(document: IniDocument, section: IniSection, changes: string[], beforePattern?: RegExp): void {
  if (document.getSection(section.name)) {
    return;
  }
  if (beforePattern) {
    const insertionIndex = document.sections.findIndex((candidate) => beforePattern.test(candidate.name));
    if (insertionIndex >= 0) {
      document.sections.splice(insertionIndex, 0, section);
    } else {
      document.addSection(section);
    }
  } else {
    document.addSection(section);
  }
  changes.push(`[${section.name}] added.`);
}

function createWorkspaceProjectHeader(projectIndex: number, version: number): IniSection {
  const suffix = workspaceProjectSuffix(projectIndex);
  const section = new IniSection(`Project Header ${suffix}`, []);
  section.set('Version', String(version));
  section.set("Don't Update DistKit", 'False');
  section.set('Platform Code', '4');
  section.set('Build Configuration', quote('Debug'));
  section.set('Warn User If Debugging Release', '1');
  section.set('Batch Build Release', 'False');
  section.set('Batch Build Debug', 'False');
  section.set('Force Rebuild', 'False');
  section.lines.push('');
  return section;
}

function createWorkspaceDefaultBuildConfig(projectIndex: number, mode: typeof WORKSPACE_BUILD_MODES[number]): IniSection {
  const suffix = workspaceProjectSuffix(projectIndex);
  const section = new IniSection(`Default Build Config ${suffix} ${mode}`, []);
  section.set('Generate Browse Info', 'True');
  section.set('Enable Uninitialized Locals Runtime Warning', 'True');
  section.set('Batch Build', 'False');
  section.set('Profile', quote('Disabled'));
  section.set('Debugging Level', quote('Standard'));
  section.set('Execution Trace', quote('Disabled'));
  section.set('Command Line Args', quote(''));
  section.set('Working Directory', quote(''));
  section.set('Environment Options', quote(''));
  section.set('External Process Path', quote(''));
  section.lines.push('');
  return section;
}

function createWorkspaceBuildDependencies(projectIndex: number): IniSection {
  const suffix = workspaceProjectSuffix(projectIndex);
  const section = new IniSection(`Build Dependencies ${suffix}`, []);
  section.set('Number of Dependencies', '0');
  section.lines.push('');
  return section;
}

function createWorkspaceBuildOptions(projectIndex: number): IniSection {
  const suffix = workspaceProjectSuffix(projectIndex);
  const section = new IniSection(`Build Options ${suffix}`, []);
  section.set('Generate Browse Info', 'True');
  section.set('Enable Uninitialized Locals Runtime Warning', 'True');
  section.set('Execution Trace', quote('Disabled'));
  section.set('Profile', quote('Disabled'));
  section.set('Debugging Level', quote('Standard'));
  section.set('Break On Library Errors', 'True');
  section.set('Break On First Chance Exceptions', 'False');
  section.lines.push('');
  return section;
}

function createWorkspaceExecutionTarget(projectIndex: number): IniSection {
  const suffix = workspaceProjectSuffix(projectIndex);
  const section = new IniSection(`Execution Target ${suffix}`, []);
  section.set('Execution Target Address', quote('Local desktop computer'));
  section.set('Execution Target Port', '0');
  section.set('Execution Target Type', '0');
  section.lines.push('');
  return section;
}

function createWorkspaceSccOptions(projectIndex: number): IniSection {
  const suffix = workspaceProjectSuffix(projectIndex);
  const section = new IniSection(`SCC Options ${suffix}`, []);
  section.set('Use global settings', 'True');
  section.set('SCC Provider', quote(''));
  section.set('SCC Project', quote(''));
  section.set('Local Path', quote(''));
  section.set('Auxiliary Path', quote(''));
  section.set('Perform Same Action For .h File As For .uir File', quote('Ask'));
  section.set('Perform Same Action For .cds File As For .prj File', quote('Ask'));
  section.set('Username', quote(''));
  section.set('Comment', quote(''));
  section.set('Use Default Username', 'False');
  section.set('Use Default Comment', 'False');
  section.set('Suppress CVI Error Messages', 'False');
  section.set('Always show confirmation dialog', 'True');
  section.lines.push('');
  return section;
}

function createWorkspaceDllDebuggingSupport(projectIndex: number): IniSection {
  const suffix = workspaceProjectSuffix(projectIndex);
  const section = new IniSection(`DLL Debugging Support ${suffix}`, []);
  section.set('External Process Path', quote(''));
  section.lines.push('');
  return section;
}

function createWorkspaceCommandLineArgs(projectIndex: number): IniSection {
  const suffix = workspaceProjectSuffix(projectIndex);
  const section = new IniSection(`Command Line Args ${suffix}`, []);
  section.set('Command Line Args', quote(''));
  section.set('Working Directory', quote(''));
  section.set('Environment Options', quote(''));
  section.lines.push('');
  return section;
}

function workspaceUsesBuildDependencies(document: IniDocument, version: number): boolean {
  return version >= 2000 || document.sections.some((section) => /^Build Dependencies \d{4}$/i.test(section.name));
}

function requiredWorkspaceProjectSectionNames(document: IniDocument, projectIndex: number, version: number): string[] {
  const suffix = workspaceProjectSuffix(projectIndex);
  return [
    `Project Header ${suffix}`,
    ...WORKSPACE_BUILD_MODES.map((mode) => `Default Build Config ${suffix} ${mode}`),
    ...(workspaceUsesBuildDependencies(document, version) ? [`Build Dependencies ${suffix}`] : []),
    `Build Options ${suffix}`,
    `Execution Target ${suffix}`,
    `SCC Options ${suffix}`,
    `DLL Debugging Support ${suffix}`,
    `Command Line Args ${suffix}`
  ];
}

function ensureWorkspaceProjectSections(document: IniDocument, projectIndex: number, version: number): string[] {
  const changes: string[] = [];
  addWorkspaceSectionIfMissing(document, createWorkspaceProjectHeader(projectIndex, version), changes, /^(?:File \d{4}|Default Build Config \d{4} )/i);
  for (const mode of WORKSPACE_BUILD_MODES) {
    addWorkspaceSectionIfMissing(document, createWorkspaceDefaultBuildConfig(projectIndex, mode), changes);
  }
  if (workspaceUsesBuildDependencies(document, version)) {
    addWorkspaceSectionIfMissing(document, createWorkspaceBuildDependencies(projectIndex), changes);
  }
  addWorkspaceSectionIfMissing(document, createWorkspaceBuildOptions(projectIndex), changes);
  addWorkspaceSectionIfMissing(document, createWorkspaceExecutionTarget(projectIndex), changes);
  addWorkspaceSectionIfMissing(document, createWorkspaceSccOptions(projectIndex), changes);
  addWorkspaceSectionIfMissing(document, createWorkspaceDllDebuggingSupport(projectIndex), changes);
  addWorkspaceSectionIfMissing(document, createWorkspaceCommandLineArgs(projectIndex), changes);
  return changes;
}


const WORKSPACE_PROJECT_SECTION_PATTERN = /^(Project Header|Default Build Config|Build Dependencies|Build Options|Execution Target|SCC Options|DLL Debugging Support|DLLs Used By Executable|Command Line Args) (\d{4})(.*)$/i;

function shiftedWorkspaceProjectIndex(index: number, removedProjectIndex: number): number | undefined {
  if (index === removedProjectIndex) {
    return undefined;
  }
  return index > removedProjectIndex ? index - 1 : index;
}

function reindexWorkspaceHeaderProjects(header: IniSection, removedProjectIndex: number): void {
  const projectLine = /^\s*Project (\d{4})(.*?)\s*=\s*(.*)$/i;
  const nextLines: string[] = [];
  for (const line of header.lines) {
    const match = line.match(projectLine);
    if (!match) {
      nextLines.push(line);
      continue;
    }
    const currentIndex = Number(match[1]);
    const nextIndex = shiftedWorkspaceProjectIndex(currentIndex, removedProjectIndex);
    if (nextIndex === undefined) {
      continue;
    }
    nextLines.push(`Project ${workspaceProjectSuffix(nextIndex)}${match[2]} = ${match[3]}`);
  }
  header.lines = nextLines;
}

function reindexWorkspaceProjectSections(document: IniDocument, removedProjectIndex: number): void {
  const nextSections: IniSection[] = [];
  for (const section of document.sections) {
    const match = section.name.match(WORKSPACE_PROJECT_SECTION_PATTERN);
    if (!match) {
      nextSections.push(section);
      continue;
    }
    const currentIndex = Number(match[2]);
    const nextIndex = shiftedWorkspaceProjectIndex(currentIndex, removedProjectIndex);
    if (nextIndex === undefined) {
      continue;
    }
    const nextName = `${match[1]} ${workspaceProjectSuffix(nextIndex)}${match[3]}`;
    nextSections.push(new IniSection(nextName, section.lines.slice()));
  }
  document.sections.splice(0, document.sections.length, ...nextSections);
}

function reindexWorkspaceFileMemberships(document: IniDocument, removedProjectIndex: number): void {
  for (const section of document.sections.filter((candidate) => /^File \d{4}$/i.test(candidate.name))) {
    const stored = unquote(section.get('In Projects')) ?? '';
    if (!stored.trim()) {
      continue;
    }
    const nextProjects: number[] = [];
    const seen = new Set<number>();
    for (const token of stored.split(',')) {
      const currentIndex = Number(token.trim());
      if (!Number.isInteger(currentIndex) || currentIndex < 1) {
        continue;
      }
      const nextIndex = shiftedWorkspaceProjectIndex(currentIndex, removedProjectIndex);
      if (nextIndex !== undefined && !seen.has(nextIndex)) {
        seen.add(nextIndex);
        nextProjects.push(nextIndex);
      }
    }
    section.set('In Projects', quote(nextProjects.length > 0 ? `${nextProjects.join(',')},` : ''));
  }
}

function validateWorkspaceProjectIndexing(document: IniDocument): void {
  const header = document.getSection('Workspace Header');
  if (!header) {
    throw new Error('Invalid CVI workspace: missing [Workspace Header].');
  }
  const projectCount = Number(header.get('Number of Projects') ?? '0');
  const validIndexes = new Set<number>();
  for (let index = 1; index <= projectCount; index += 1) {
    validIndexes.add(index);
    const projectValue = unquote(header.get(`Project ${workspaceProjectSuffix(index)}`)) ?? '';
    if (!projectValue.trim()) {
      throw new Error(`Invalid CVI workspace: Project ${workspaceProjectSuffix(index)} is missing after reindexing.`);
    }
  }

  for (const section of document.sections) {
    const projectSectionMatch = section.name.match(WORKSPACE_PROJECT_SECTION_PATTERN);
    if (projectSectionMatch && !validIndexes.has(Number(projectSectionMatch[2]))) {
      throw new Error(`Invalid CVI workspace: orphaned project section [${section.name}] after reindexing.`);
    }
    if (!/^File \d{4}$/i.test(section.name)) {
      continue;
    }
    const stored = unquote(section.get('In Projects')) ?? '';
    for (const token of stored.split(',')) {
      const index = Number(token.trim());
      if (Number.isInteger(index) && index > 0 && !validIndexes.has(index)) {
        throw new Error(`Invalid CVI workspace: [${section.name}] references missing project ${index}.`);
      }
    }
  }
}


function normalizeComparablePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  const normalized = /^[A-Za-z]:[\\/]/.test(trimmed)
    ? path.win32.normalize(trimmed)
    : path.resolve(trimmed);
  return normalized.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function cviWorkspaceFileType(projectFileType: string, filePath: string): string {
  if (projectFileType === 'CSource' || /\.(?:c|cc|cpp|cxx)$/i.test(filePath)) {
    return 'CSource';
  }
  if (projectFileType === 'Include' || /\.(?:h|hh|hpp|hxx)$/i.test(filePath)) {
    return 'Include';
  }
  return projectFileType || 'Unknown';
}

function isBreakpointCompatibleProjectFile(file: CviProjectFile): boolean {
  return file.type === 'CSource' || file.type === 'Include' || /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(file.absolutePath);
}

function readWorkspaceFilePath(section: IniSection): string | undefined {
  const value = reconstructValue(section, 'Path');
  return value ? fromCviPath(value) : undefined;
}

function parseWorkspaceBreakpointLine(value: string | undefined): number | undefined {
  const rendered = unquote(value);
  const first = rendered?.split(',')[0]?.trim();
  if (!first || !/^\d+$/.test(first)) {
    return undefined;
  }
  const line = Number(first);
  return line > 0 ? line : undefined;
}

function readWorkspaceBreakpoints(section: IniSection): Map<number, string> {
  const result = new Map<number, string>();
  for (const line of section.lines) {
    const match = line.match(/^\s*Breakpoint\s+\d{4}\s*=\s*(.*)$/i);
    const sourceLine = parseWorkspaceBreakpointLine(match?.[1]);
    if (match && sourceLine !== undefined && !result.has(sourceLine)) {
      result.set(sourceLine, match[1].trim());
    }
  }
  return result;
}

function replaceWorkspaceBreakpoints(section: IniSection, values: Map<number, string>): void {
  section.deleteMatching(/^\s*Breakpoint\s+\d{4}\s*=/i);
  const entries = [...values.entries()].sort(([left], [right]) => left - right);
  if (entries.length === 0) {
    return;
  }
  let insertionIndex = section.lines.findIndex((line) => /^\s*(?:Tracepoint\s+\d{4}|Window\s+)/i.test(line));
  if (insertionIndex < 0) {
    insertionIndex = section.lines.length;
    while (insertionIndex > 0 && section.lines[insertionIndex - 1].trim() === '') {
      insertionIndex -= 1;
    }
  }
  const rendered = entries.map(([, value], index) => `Breakpoint ${String(index + 1).padStart(4, '0')} = ${value}`);
  section.lines.splice(insertionIndex, 0, ...rendered);
}

function nextWorkspaceFileIndex(document: IniDocument): number {
  return document.sections
    .filter((section) => /^File \d{4}$/i.test(section.name))
    .map((section) => numericSuffix(section.name))
    .reduce((maximum, value) => Math.max(maximum, value), 0) + 1;
}

function ensureWorkspaceFileSection(
  document: IniDocument,
  header: IniSection,
  projectIndex: number,
  projectFile: CviProjectFile
): { section: IniSection; created: boolean } {
  const comparable = normalizeComparablePath(projectFile.absolutePath);
  const existing = document.sections.find((section) => /^File \d{4}$/i.test(section.name)
    && normalizeComparablePath(readWorkspaceFilePath(section) ?? '') === comparable);
  if (existing) {
    return { section: existing, created: false };
  }

  const index = nextWorkspaceFileIndex(document);
  const section = new IniSection(`File ${String(index).padStart(4, '0')}`, []);
  section.set('Path', quote(toCviPath(projectFile.absolutePath)));
  section.set('File Type', quote(cviWorkspaceFileType(projectFile.type, projectFile.absolutePath)));
  section.set('In Projects', quote(`${projectIndex},`));
  section.lines.push('');
  const tabOrderIndex = document.sections.findIndex((candidate) => candidate.name.toLowerCase() === 'tab order');
  const buildConfigIndex = document.sections.findIndex((candidate) => /^Default Build Config \d{4} /i.test(candidate.name));
  const insertionIndex = tabOrderIndex >= 0 ? tabOrderIndex : buildConfigIndex >= 0 ? buildConfigIndex : document.sections.length;
  document.sections.splice(insertionIndex, 0, section);
  // Do not modify Number of Opened Files here. It describes CVI editor/session state,
  // not the number of workspace [File NNNN] references.
  return { section, created: true };
}



function parseWorkspaceMemberships(section: IniSection): number[] {
  const stored = unquote(section.get('In Projects')) ?? '';
  const result: number[] = [];
  const seen = new Set<number>();
  for (const token of stored.split(',')) {
    const index = Number(token.trim());
    if (Number.isInteger(index) && index > 0 && !seen.has(index)) {
      seen.add(index);
      result.push(index);
    }
  }
  return result;
}

function exactWorkspaceProjectEntries(header: IniSection): Array<{ index: number; storedPath: string }> {
  const result: Array<{ index: number; storedPath: string }> = [];
  const seen = new Set<number>();
  for (const { key, value } of header.entries()) {
    const match = key.match(/^Project (\d{4})$/i);
    if (!match) continue;
    const index = Number(match[1]);
    const storedPath = unquote(value) ?? '';
    if (!storedPath.trim() || seen.has(index)) continue;
    seen.add(index);
    result.push({ index, storedPath });
  }
  return result.sort((left, right) => left.index - right.index);
}

function duplicateSectionNames(document: IniDocument): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const section of document.sections) {
    const key = section.name.toLowerCase();
    if (seen.has(key)) duplicates.add(section.name);
    seen.add(key);
  }
  return [...duplicates];
}

function remapWorkspaceProjectStructure(document: IniDocument): string[] {
  const header = document.getSection('Workspace Header');
  if (!header) throw new Error('Invalid CVI workspace: missing [Workspace Header].');
  const changes: string[] = [];
  const entries = exactWorkspaceProjectEntries(header);
  const indexMap = new Map<number, number>();
  entries.forEach((entry, position) => indexMap.set(entry.index, position + 1));

  const declaredCount = Number(header.get('Number of Projects') ?? '0');
  if (declaredCount !== entries.length) {
    changes.push(`[Workspace Header] Number of Projects ${declaredCount} -> ${entries.length}.`);
  }

  const projectLine = /^(\s*)Project (\d{4})(.*?)(\s*=\s*)(.*)$/i;
  const nextHeaderLines: string[] = [];
  const reportedDropped = new Set<number>();
  for (const line of header.lines) {
    const match = line.match(projectLine);
    if (!match) {
      nextHeaderLines.push(line);
      continue;
    }
    const oldIndex = Number(match[2]);
    const nextIndex = indexMap.get(oldIndex);
    if (nextIndex === undefined) {
      if (!reportedDropped.has(oldIndex)) {
        changes.push(`[Workspace Header] removed orphaned metadata for project ${workspaceProjectSuffix(oldIndex)}.`);
        reportedDropped.add(oldIndex);
      }
      continue;
    }
    if (oldIndex !== nextIndex) {
      changes.push(`[Workspace Header] project index ${workspaceProjectSuffix(oldIndex)} -> ${workspaceProjectSuffix(nextIndex)}.`);
    }
    nextHeaderLines.push(`${match[1]}Project ${workspaceProjectSuffix(nextIndex)}${match[3]}${match[4]}${match[5]}`);
  }
  header.lines = nextHeaderLines;
  header.set('Number of Projects', String(entries.length));

  const oldActive = Number(header.get('Active Project') ?? '0');
  let nextActive = entries.length === 0 ? 0 : (indexMap.get(oldActive) ?? 1);
  if (oldActive !== nextActive) {
    changes.push(`[Workspace Header] Active Project ${oldActive} -> ${nextActive}.`);
  }
  header.set('Active Project', String(nextActive));

  const seenSectionNames = new Set<string>();
  const nextSections: IniSection[] = [];
  for (const section of document.sections) {
    const match = section.name.match(WORKSPACE_PROJECT_SECTION_PATTERN);
    if (!match) {
      nextSections.push(section);
      continue;
    }
    const oldIndex = Number(match[2]);
    const nextIndex = indexMap.get(oldIndex);
    if (nextIndex === undefined) {
      changes.push(`Removed orphaned workspace section [${section.name}].`);
      continue;
    }
    const nextName = `${match[1]} ${workspaceProjectSuffix(nextIndex)}${match[3]}`;
    const comparable = nextName.toLowerCase();
    if (seenSectionNames.has(comparable)) {
      changes.push(`Removed duplicate workspace section [${section.name}] while rebuilding project indexes.`);
      continue;
    }
    seenSectionNames.add(comparable);
    if (nextName !== section.name) changes.push(`[${section.name}] -> [${nextName}].`);
    nextSections.push(new IniSection(nextName, section.lines.slice()));
  }
  document.sections.splice(0, document.sections.length, ...nextSections);

  for (const section of document.sections.filter((candidate) => /^File \d{4}$/i.test(candidate.name))) {
    const current = parseWorkspaceMemberships(section);
    const next = [...new Set(current.map((index) => indexMap.get(index)).filter((index): index is number => index !== undefined))].sort((a, b) => a - b);
    if (current.join(',') !== next.join(',')) {
      section.set('In Projects', quote(next.length > 0 ? `${next.join(',')},` : ''));
      changes.push(`[${section.name}] rebuilt In Projects -> ${next.join(',') || '(none)'}.`);
    }
  }
  return changes;
}

function canonicalProjectFilePathReference(projectPath: string, section: IniSection): { absolutePath: string; isRelative: boolean; relativePath?: string; storedPath: string } | undefined {
  const relativeTo = (unquote(section.get('Path Rel To')) ?? 'Project').toLowerCase();
  if (relativeTo !== 'project') return undefined;
  const resolved = resolveProjectFilePath(projectPath, section).absolutePath;
  const reference = createCviPathReference(path.dirname(projectPath), resolved);
  return { absolutePath: resolved, isRelative: reference.isRelative, relativePath: reference.relativePath, storedPath: reference.absolutePath };
}


function approximateCviReleaseYear(formatVersion: number | undefined): number | undefined {
  if (!formatVersion || !Number.isFinite(formatVersion)) return undefined;
  const generation = Math.floor(formatVersion / 100);
  return generation >= 3 && generation <= 99 ? 2000 + generation : undefined;
}

function cviReleaseYearFromDirectory(inputPath: string | undefined): number | undefined {
  if (!inputPath) return undefined;
  const native = nativeCompatibilityPath(inputPath);
  const match = native.match(/(?:^|[\\/])CVI(?:[^0-9]*)(20\d{2}|\d{2})(?:[^0-9]|$)/i);
  if (!match) return undefined;
  const numeric = Number(match[1]);
  return numeric < 100 ? 2000 + numeric : numeric;
}

function nativeCompatibilityPath(pathValue: string): string {
  const trimmed = (unquote(pathValue) ?? '').trim();
  if (!trimmed) return '';
  if (isCviAbsolutePath(trimmed)) return fromCviPath(trimmed);
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(trimmed)) {
    return path.win32.normalize(trimmed.replace(/\//g, '\\'));
  }
  return trimmed;
}

function pathCompatibilityWarnings(label: string, inputPath: string): string[] {
  const candidate = nativeCompatibilityPath(inputPath);
  if (!candidate) return [];
  const warnings: string[] = [];
  if (candidate.length >= 260) {
    warnings.push(`[Path length] ${label} is ${candidate.length} characters long. Several CVI generations have known failures around the traditional 260-character Windows path limit: ${candidate}`);
  }
  if (candidate.normalize('NFC') !== candidate) {
    warnings.push(`[Unicode path] ${label} contains decomposed Unicode characters. CVI has documented problems opening such paths: ${candidate}`);
  }
  if (/[^\x00-\x7f]/.test(candidate)) {
    warnings.push(`[Code page] ${label} contains non-ASCII characters. CVI file paths must be compatible with the Windows System Codepage; verify this path in the selected native CVI installation: ${candidate}`);
  }
  return warnings;
}

function nativeTargetSettingsFromSection(
  document: IniDocument,
  projectPath: string,
  config: IniSection,
  configurationName: string,
  fallbackMode?: CviBuildMode
): CviNativeTargetSettings {
  const header = document.getSection('Project Header');
  if (!header) throw new Error('Invalid CVI project: missing [Project Header].');
  const createExecutable = document.getSection('Create Executable') ?? new IniSection('Create Executable', []);
  const modules = document.getSection('Modules Forced Into Executable');
  const signing = document.getSection('Signing Info') ?? new IniSection('Signing Info', []);
  const manifest = document.getSection('Manifest Info') ?? new IniSection('Manifest Info', []);
  const stringValue = (key: string, fallback = ''): string => unquote(config.get(key)) ?? unquote(createExecutable.get(key)) ?? fallback;
  const boolValue = (key: string, fallback = false): boolean => config.has(key) ? parseBoolean(config.get(key), fallback) : parseBoolean(createExecutable.get(key), fallback);
  const pathValue = (key: string): string => {
    const configHasPath = config.has(key) || config.has(`${key} Is Rel`) || config.has(`${key} Rel Path`);
    return configHasPath ? resolveStoredPath(config, key) : resolveStoredPath(createExecutable, key);
  };
  const versionValue = (key: string): string => unquote(config.get(`${key} Ex`)) ?? unquote(config.get(key)) ?? unquote(createExecutable.get(`${key} Ex`)) ?? unquote(createExecutable.get(key)) ?? '';
  const outputPath = resolveOutputPathBySuffix(createExecutable, configurationName.trim(), projectPath)
    ?? (fallbackMode ? resolveOutputPath(createExecutable, fallbackMode, projectPath) : undefined)
    ?? '';
  const exportFiles = parseStringList(config, /^Export File ?\d+$/i);
  return {
    targetType: unquote(header.get('Target Type')) ?? 'Executable',
    outputPath,
    applicationTitle: stringValue('Application Title'),
    iconFile: pathValue('Icon File'),
    runtimeSupport: stringValue('Runtime Support', 'Full Runtime Support'),
    runtimeBinding: stringValue('Runtime Binding', 'Shared'),
    generateSourceDocumentation: stringValue('Generate Source Documentation', 'None'),
    manifestEmbed: config.has('Manifest Embed') || createExecutable.has('Manifest Embed') ? boolValue('Manifest Embed') : parseBoolean(manifest.get('Embed')),
    manifestPath: pathValue('Manifest Path'),
    embedProjectUirs: boolValue('Embed Project .UIRs'),
    generateMapFile: boolValue('Generate Map File'),
    createConsoleApplication: boolValue('Create Console Application'),
    embedTimestamp: boolValue('Embed Timestamp', true),
    usingLoadExternalModule: boolValue('Using LoadExternalModule'),
    forcedModules: parseStringList(modules, /^Module \d{4}$/i),
    useDefaultImportLibBaseName: boolValue('Use Dflt Import Lib Base Name', true),
    dllImportLibraryChoice: stringValue('DLL Import Library Choice'),
    importLibBaseName: stringValue('Import Lib Base Name'),
    whereToCopyDll: stringValue('Where to Copy DLL', 'Do not copy'),
    customDirectoryToCopyDll: pathValue('Custom Directory to Copy DLL'),
    useIviSubdirectoriesForImportLibraries: boolValue('Use IVI Subdirectories for Import Libraries'),
    useVxiPnpSubdirectoriesForImportLibraries: boolValue('Use VXIPNP Subdirectories for Import Libraries'),
    dllExports: stringValue('DLL Exports', 'Include File Symbols'),
    exportFiles: exportFiles.length ? exportFiles : parseStringList(createExecutable, /^Export File ?\d+$/i),
    addTypeLibToDll: boolValue('Add Type Lib To DLL'),
    includeTypeLibHelpLinks: boolValue('Include Type Lib Help Links'),
    tlbHelpStyle: stringValue('TLB Help Style', 'HLP'),
    typeLibFpFile: pathValue('Type Lib FP File'),
    addNiTypeInfoToDll: boolValue('Add NI Type Info To DLL'),
    useSingleHeaderForNiTypeInfo: boolValue('Use Single Header for NI Type Info'),
    singleHeaderNiTypeInfoFile: pathValue('Single Header NI Type Info File'),
    versionInfo: {
      numericFileVersion: stringValue('Numeric File Version', '1,0,0,0'),
      numericProductVersion: stringValue('Numeric Prod Version', '1,0,0,0'),
      comments: versionValue('Comments'), companyName: versionValue('Company Name'), fileDescription: versionValue('File Description'),
      fileVersion: versionValue('File Version'), internalName: versionValue('Internal Name'), legalCopyright: versionValue('Legal Copyright'),
      legalTrademarks: versionValue('Legal Trademarks'), originalFilename: versionValue('Original Filename'), privateBuild: versionValue('Private Build'),
      productName: versionValue('Product Name'), productVersion: versionValue('Product Version'), specialBuild: versionValue('Special Build')
    },
    signing: {
      enabled: config.has('Sign') ? parseBoolean(config.get('Sign')) : parseBoolean(signing.get('Sign')),
      store: unquote(config.get('Sign Store')) ?? unquote(signing.get('Store')) ?? '',
      certificate: unquote(config.get('Sign Certificate')) ?? unquote(signing.get('Certificate')) ?? '',
      timestampUrl: unquote(config.get('Sign Timestamp URL')) ?? unquote(signing.get('Timestamp URL')) ?? '',
      descriptionUrl: unquote(config.get('Sign URL')) ?? unquote(signing.get('URL')) ?? '',
      signDebugBuild: parseBoolean(signing.get('Sign Debug Build'))
    }
  };
}

function writeNativeTargetSettingsToSection(document: IniDocument, projectPath: string, config: IniSection, configurationName: string, settings: CviNativeTargetSettings): void {
  const header = document.getSection('Project Header');
  if (!header) throw new Error('Invalid CVI project: missing [Project Header].');
  const createExecutable = document.ensureSection('Create Executable');
  const signing = document.ensureSection('Signing Info');
  header.set('Target Type', quote(settings.targetType));
  setOutputPathBySuffix(createExecutable, configurationName, projectPath, settings.outputPath);
  config.set('Application Title', quote(settings.applicationTitle));
  setProjectReferencedPath(config, 'Icon File', projectPath, settings.iconFile);
  config.set('Runtime Support', quote(settings.runtimeSupport));
  config.set('Runtime Binding', quote(settings.runtimeBinding));
  config.set('Generate Source Documentation', quote(settings.generateSourceDocumentation));
  setBoolean(config, 'Manifest Embed', settings.manifestEmbed);
  setProjectReferencedPath(config, 'Manifest Path', projectPath, settings.manifestPath);
  setBoolean(config, 'Embed Project .UIRs', settings.embedProjectUirs);
  setBoolean(config, 'Generate Map File', settings.generateMapFile);
  setBoolean(config, 'Create Console Application', settings.createConsoleApplication);
  setBoolean(config, 'Embed Timestamp', settings.embedTimestamp);
  setBoolean(config, 'Using LoadExternalModule', settings.usingLoadExternalModule);
  const modules = document.ensureSection('Modules Forced Into Executable', 'ActiveX Server Options');
  writeStringList(modules, 'Module', settings.forcedModules, true);
  if (settings.forcedModules.filter((value) => value.trim()).length === 0) document.removeSection('Modules Forced Into Executable');
  setBoolean(config, 'Use Dflt Import Lib Base Name', settings.useDefaultImportLibBaseName);
  config.set('DLL Import Library Choice', quote(settings.dllImportLibraryChoice));
  config.set('Import Lib Base Name', quote(settings.importLibBaseName));
  config.set('Where to Copy DLL', quote(settings.whereToCopyDll));
  setProjectReferencedPath(config, 'Custom Directory to Copy DLL', projectPath, settings.customDirectoryToCopyDll);
  setBoolean(config, 'Use IVI Subdirectories for Import Libraries', settings.useIviSubdirectoriesForImportLibraries);
  setBoolean(config, 'Use VXIPNP Subdirectories for Import Libraries', settings.useVxiPnpSubdirectoriesForImportLibraries);
  config.set('DLL Exports', quote(settings.dllExports));
  writeStringList(config, 'Export File', settings.exportFiles);
  setBoolean(config, 'Add Type Lib To DLL', settings.addTypeLibToDll);
  setBoolean(config, 'Include Type Lib Help Links', settings.includeTypeLibHelpLinks);
  config.set('TLB Help Style', quote(settings.tlbHelpStyle));
  setProjectReferencedPath(config, 'Type Lib FP File', projectPath, settings.typeLibFpFile);
  setBoolean(config, 'Add NI Type Info To DLL', settings.addNiTypeInfoToDll);
  setBoolean(config, 'Use Single Header for NI Type Info', settings.useSingleHeaderForNiTypeInfo);
  setProjectReferencedPath(config, 'Single Header NI Type Info File', projectPath, settings.singleHeaderNiTypeInfoFile);
  const versionPairs: Array<[string, string]> = [
    ['Comments', settings.versionInfo.comments], ['Company Name', settings.versionInfo.companyName], ['File Description', settings.versionInfo.fileDescription],
    ['File Version', settings.versionInfo.fileVersion], ['Internal Name', settings.versionInfo.internalName], ['Legal Copyright', settings.versionInfo.legalCopyright],
    ['Legal Trademarks', settings.versionInfo.legalTrademarks], ['Original Filename', settings.versionInfo.originalFilename], ['Private Build', settings.versionInfo.privateBuild],
    ['Product Name', settings.versionInfo.productName], ['Product Version', settings.versionInfo.productVersion], ['Special Build', settings.versionInfo.specialBuild]
  ];
  config.set('Numeric File Version', quote(settings.versionInfo.numericFileVersion));
  config.set('Numeric Prod Version', quote(settings.versionInfo.numericProductVersion));
  versionPairs.forEach(([key, value]) => { config.set(key, quote(value)); config.set(`${key} Ex`, quote(value)); });
  setBoolean(config, 'Sign', settings.signing.enabled);
  config.set('Sign Store', quote(settings.signing.store));
  config.set('Sign Certificate', quote(settings.signing.certificate));
  config.set('Sign Timestamp URL', quote(settings.signing.timestampUrl));
  config.set('Sign URL', quote(settings.signing.descriptionUrl));
  setBoolean(signing, 'Sign Debug Build', settings.signing.signDebugBuild);
}

export class CviParser {

  inspectNativeCompatibility(filePath: string): CviNativeCompatibilityReport {
    const textInfo = inspectNativeTextEncoding(filePath);
    const document = IniDocument.parse(textInfo.text);
    const extension = path.extname(filePath).toLowerCase();
    const headerName = extension === '.cws' ? 'Workspace Header' : 'Project Header';
    const header = document.getSection(headerName);
    const formatVersion = header ? Number(header.get('Version') ?? '') : undefined;
    const releaseYear = approximateCviReleaseYear(formatVersion);
    const warnings: string[] = [];
    const notes: string[] = [];

    const encodingLabel: Record<CviNativeTextEncoding, string> = {
      'utf8': 'UTF-8',
      'utf8-bom': 'UTF-8 with BOM',
      'utf16le-bom': 'UTF-16LE with BOM',
      'ansi-byte-preserving': 'legacy ANSI / byte-preserving single-byte encoding'
    };
    notes.push(`[Encoding] ${encodingLabel[textInfo.encoding]}. CVI PM preserves this encoding when rewriting the native file.`);
    if (textInfo.encoding === 'ansi-byte-preserving') {
      notes.push('[Encoding] Existing non-ASCII bytes are preserved 1:1. New characters outside the original single-byte range are rejected instead of silently corrupting the file.');
    }
    if (textInfo.encoding === 'utf16le-bom') {
      warnings.push('[Encoding] UTF-16LE is unusual for native CVI .cws/.prj files. CVI PM preserves it, but native IDE compatibility should be verified before relying on this format.');
    }

    if (formatVersion && Number.isFinite(formatVersion)) {
      notes.push(`[Format] Native format Version=${formatVersion}${releaseYear ? ` (approximately CVI ${releaseYear} generation)` : ''}.`);
      if (formatVersion < 1300) {
        notes.push('[Folders] Pre-2013 format detected: CVI PM enforces single-level logical folders.');
      } else {
        notes.push('[Folders] CVI 2013+ generation detected. Native CVI supports project subfolders, but CVI PM intentionally creates only single-level folders until the exact native hierarchy metadata is fully preserved. Existing native hierarchy metadata is not synthesized from slash-separated names.');
      }
    }

    warnings.push(...pathCompatibilityWarnings(path.basename(filePath), filePath));
    if (header) {
      const pathname = reconstructValue(header, 'Pathname');
      if (pathname) warnings.push(...pathCompatibilityWarnings(`${headerName}/Pathname`, pathname));
      const cviDir = reconstructValue(header, 'CVI Dir');
      if (cviDir) {
        warnings.push(...pathCompatibilityWarnings(`${headerName}/CVI Dir`, cviDir));
        const cviDirYear = cviReleaseYearFromDirectory(cviDir);
        if (releaseYear && cviDirYear) {
          if (releaseYear > cviDirYear) {
            warnings.push(`[Version] Native format Version=${formatVersion} targets approximately CVI ${releaseYear}, but CVI Dir points to CVI ${cviDirYear}. An older CVI installation may reject or rewrite this file.`);
          } else if (releaseYear < cviDirYear) {
            notes.push(`[Version] Native format is older than the referenced CVI ${cviDirYear} installation. This is normally backward-compatible, but saving in the native IDE may upgrade project metadata.`);
          }
        }
      }
    }

    if (extension === '.cws' && header) {
      const count = Number(header.get('Number of Projects') ?? '0');
      for (let index = 1; index <= count; index += 1) {
        const stored = unquote(header.get(`Project ${workspaceProjectSuffix(index)}`)) ?? '';
        if (!stored) continue;
        const resolved = resolveCviReferencePath(path.dirname(filePath), stored);
        warnings.push(...pathCompatibilityWarnings(`Project ${workspaceProjectSuffix(index)}`, resolved));
      }
      for (const section of document.sections) {
        if (!/^Default Build Config \d{4} (?:Debug|Release|Debug64|Release64)$/i.test(section.name)) continue;
        for (const key of ['Working Directory', 'External Process Path']) {
          const value = reconstructValue(section, key);
          if (value) warnings.push(...pathCompatibilityWarnings(`${section.name}/${key}`, value));
        }
      }
    }

    if (extension === '.prj') {
      for (const section of document.sections.filter((candidate) => /^File \d{4}$/i.test(candidate.name))) {
        const resolved = resolveProjectFilePath(filePath, section).absolutePath;
        warnings.push(...pathCompatibilityWarnings(`${section.name}`, resolved));
      }
      const output = document.getSection('Create Executable');
      if (output) {
        for (const mode of ['debug', 'release', 'debug64', 'release64'] as CviBuildMode[]) {
          const target = resolveOutputPath(output, mode, filePath);
          if (target) warnings.push(...pathCompatibilityWarnings(`Create Executable/${modeSuffix(mode)}`, target));
        }
      }
    }

    return {
      formatVersion: formatVersion && Number.isFinite(formatVersion) ? formatVersion : undefined,
      approximateReleaseYear: releaseYear,
      encoding: textInfo.encoding,
      warnings: [...new Set(warnings)],
      notes: [...new Set(notes)]
    };
  }


  parseWorkspace(workspacePath: string): CviWorkspace {
    const document = IniDocument.parse(readText(workspacePath));
    const header = document.getSection('Workspace Header');
    if (!header) {
      throw new Error(`Invalid CVI workspace: missing [Workspace Header] in ${workspacePath}`);
    }

    const numberOfProjects = Number(header.get('Number of Projects') ?? '0');
    const activeProjectIndex = Number(header.get('Active Project') ?? (numberOfProjects > 0 ? '1' : '0'));
    const workspaceDirectory = path.dirname(workspacePath);
    const projects: CviWorkspaceProjectRef[] = [];

    for (let index = 1; index <= numberOfProjects; index += 1) {
      const key = `Project ${String(index).padStart(4, '0')}`;
      const storedPath = unquote(header.get(key));
      if (!storedPath) {
        continue;
      }
      const absolutePath = resolveCviReferencePath(workspaceDirectory, storedPath);
      const projectHeader = document.getSection(`Project Header ${String(index).padStart(4, '0')}`);
      const buildConfiguration = unquote(projectHeader?.get('Build Configuration'));
      projects.push({
        index,
        relativePath: storedPath,
        absolutePath,
        name: path.basename(absolutePath, path.extname(absolutePath)),
        exists: fs.existsSync(absolutePath),
        buildConfiguration,
        buildMode: buildModeFromNativeConfiguration(buildConfiguration)
      });
    }

    return {
      path: workspacePath,
      name: path.basename(workspacePath, path.extname(workspacePath)),
      activeProjectIndex,
      projects,
      cviDir: reconstructValue(header, 'CVI Dir') ? fromCviPath(reconstructValue(header, 'CVI Dir')!) : undefined
    };
  }

  parseStandaloneProject(projectPath: string): CviWorkspace {
    return {
      path: projectPath,
      name: path.basename(projectPath, path.extname(projectPath)),
      activeProjectIndex: 1,
      projects: [{
        index: 1,
        relativePath: path.basename(projectPath),
        absolutePath: projectPath,
        name: path.basename(projectPath, path.extname(projectPath)),
        exists: fs.existsSync(projectPath)
      }]
    };
  }

  parseProject(projectPath: string): CviProject {
    const document = IniDocument.parse(readText(projectPath));
    const header = document.getSection('Project Header');
    if (!header) {
      throw new Error(`Invalid CVI project: missing [Project Header] in ${projectPath}`);
    }

    const files = document.sections
      .filter((section) => /^File \d{4}$/i.test(section.name))
      .map((section): CviProjectFile => {
        const id = Number(section.name.match(/\d{4}/)?.[0] ?? section.get('Res Id') ?? '0');
        const resolved = resolveProjectFilePath(projectPath, section);
        const fileType = unquote(section.get('File Type')) ?? 'Unknown';
        return {
          sectionName: section.name,
          id,
          type: fileType,
          folder: projectFolderForUi(unquote(section.get('Folder')) ?? defaultFolderForType(fileType)),
          relativePath: resolved.relativePath,
          absolutePath: resolved.absolutePath,
          excluded: parseBoolean(section.get('Exclude')),
          compileIntoObjectFile: parseBoolean(section.get('Compile Into Object File')),
          excludeEligible: excludeEligibleFileType(fileType, resolved.absolutePath),
          projectFlags: Number(section.get('Project Flags') ?? '0') || 0,
          pathForceAbsolute: parseBoolean(section.get('Path Force Path Absolute')),
          exists: fs.existsSync(resolved.absolutePath)
        };
      })
      .sort((a, b) => a.id - b.id);

    const foldersSection = document.getSection('Folders');
    const folders = foldersSection
      ? foldersSection.entries()
        .filter(({ key }) => /^Folder \d+$/i.test(key))
        .map(({ value }) => unquote(value) ?? '')
        .filter(Boolean)
      : [];

    return {
      path: projectPath,
      name: path.basename(projectPath, path.extname(projectPath)),
      targetType: unquote(header.get('Target Type')) ?? 'Unknown',
      cviDir: reconstructValue(header, 'CVI Dir') ? fromCviPath(reconstructValue(header, 'CVI Dir')!) : undefined,
      folders,
      files
    };
  }



  getNativeBuildConfigurations(projectPath: string): CviBuildConfigurationDescriptor[] {
    const document = IniDocument.parse(readText(projectPath));
    return buildConfigurationDescriptors(document);
  }

  getNativeBuildConfiguration(projectPath: string, configurationName: string): CviBuildConfigurationDescriptor | undefined {
    const expected = configurationName.trim().toLowerCase();
    if (!expected) return undefined;
    return this.getNativeBuildConfigurations(projectPath).find((entry) => entry.name.trim().toLowerCase() === expected);
  }

  getDeclaredCustomBuildConfigurationCount(projectPath: string): number {
    const document = IniDocument.parse(readText(projectPath));
    const custom = document.getSection('Custom Build Configs');
    const header = document.getSection('Project Header');
    const raw = custom?.get('Num Custom Build Configs') ?? custom?.get('Number of Custom Build Configs') ?? header?.get('Num Custom Build Configs') ?? '0';
    const parsed = Number(unquote(raw) ?? raw);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
  }

  getNativeCompilerSettingsForConfiguration(projectPath: string, configurationName: string): CviNativeCompilerSettings | undefined {
    const document = IniDocument.parse(readText(projectPath));
    const descriptor = buildConfigurationDescriptors(document).find((entry) => entry.name.trim().toLowerCase() === configurationName.trim().toLowerCase());
    if (!descriptor) return undefined;
    const config = document.getSection(descriptor.sectionName);
    if (!config) return undefined;
    return compilerSettingsFromSection(document, config, descriptor.mode);
  }

  getNativeCompilerSettings(projectPath: string, mode: CviBuildMode): CviNativeCompilerSettings {
    const document = IniDocument.parse(readText(projectPath));
    return compilerSettingsFromSection(document, getProjectModeSection(document, mode), mode);
  }

  setNativeCompilerSettings(projectPath: string, mode: CviBuildMode, settings: CviNativeCompilerSettings): void {
    const snapshot = readTextForMutation(projectPath);
    const document = IniDocument.parse(snapshot.text);
    writeNativeCompilerSettingsToSection(getProjectModeSection(document, mode), settings, mode);
    writeText(projectPath, document.toString(), snapshot.buffer);
  }

  setNativeCompilerSettingsForConfiguration(projectPath: string, configurationName: string, settings: CviNativeCompilerSettings): void {
    const normalizedName = configurationName.trim();
    if (!normalizedName || /[\r\n]/.test(normalizedName)) throw new Error('CVI build configuration name must be non-empty and cannot contain line breaks.');
    const snapshot = readTextForMutation(projectPath);
    const document = IniDocument.parse(snapshot.text);
    const descriptor = buildConfigurationDescriptors(document).find((entry) => entry.name.trim().toLowerCase() === normalizedName.toLowerCase());
    if (!descriptor) throw new Error(`Cannot update compiler settings: native CVI configuration ${JSON.stringify(normalizedName)} was not found in the project.`);
    const config = document.getSection(descriptor.sectionName);
    if (!config) throw new Error(`Cannot update compiler settings: native CVI section [${descriptor.sectionName}] is missing.`);
    writeNativeCompilerSettingsToSection(config, settings, descriptor.mode);
    writeText(projectPath, document.toString(), snapshot.buffer);
  }

  getProjectCompilerSettings(projectPath: string): CviProjectCompilerSettings {
    const document = IniDocument.parse(readText(projectPath));
    const compilerOptions = document.getSection('Compiler Options') ?? new IniSection('Compiler Options', []);
    const includeSection = document.getSection('Include Paths');
    const includeKeys = includeSection
      ? includeSection.entries().map(({ key }) => key.match(/^Include Path (\d+)(?: |$)/i)?.[1]).filter((value): value is string => !!value)
      : [];
    const indexes = [...new Set(includeKeys.map(Number))].sort((a, b) => a - b);
    return {
      includePaths: includeSection ? indexes.map((index) => resolveProjectStoredReference(projectPath, includeSection, `Include Path ${index}`)).filter(Boolean) : [],
      oOptionCompatibleWith50: parseBoolean(compilerOptions.get('O Option Compatible With 5.0')),
      precompilePrefixHeader: parseBoolean(compilerOptions.get('Precompile Prefix Header')),
      prefixHeaderFile: resolveProjectStoredReference(projectPath, compilerOptions, 'Prefix Header File') || unquote(compilerOptions.get('Prefix Header File')) || ''
    };
  }

  getExternalCompilerSupportSettings(projectPath: string): CviExternalCompilerSupportSettings {
    const document = IniDocument.parse(readText(projectPath));
    const section = document.getSection('External Compiler Support') ?? new IniSection('External Compiler Support', []);
    return {
      uirCallbacksFileOption: unquote(section.get('UIR Callbacks File Option')) ?? section.get('UIR Callbacks File Option') ?? '0',
      usingLoadExternalModule: parseBoolean(section.get('Using LoadExternalModule')),
      createProjectSymbolsFile: parseBoolean(section.get('Create Project Symbols File'), true),
      uirCallbacksObjFile: resolveProjectStoredReference(projectPath, section, 'UIR Callbacks Obj File') || '',
      projectSymbolsHeaderFile: resolveProjectStoredReference(projectPath, section, 'Project Symbols H File') || '',
      projectSymbolsObjFile: resolveProjectStoredReference(projectPath, section, 'Project Symbols Obj File') || ''
    };
  }

  setProjectCompilerSettings(projectPath: string, settings: CviProjectCompilerSettings): void {
    const snapshot = readTextForMutation(projectPath);
    const document = IniDocument.parse(snapshot.text);
    const compilerOptions = document.ensureSection('Compiler Options', 'Run Options');
    setBoolean(compilerOptions, 'O Option Compatible With 5.0', settings.oOptionCompatibleWith50);
    setBoolean(compilerOptions, 'Precompile Prefix Header', settings.precompilePrefixHeader);
    setProjectReferencedPath(compilerOptions, 'Prefix Header File', projectPath, settings.prefixHeaderFile);
    const includeSection = document.ensureSection('Include Paths', 'Create Executable');
    includeSection.deleteMatching(/^\s*Include Path \d+(?:\s+(?:Is Rel|Rel To|Rel Path(?: Line\d{4})?))?\s*=/i);
    const seen = new Set<string>();
    settings.includePaths.map((entry) => entry.trim()).filter(Boolean).forEach((entry) => {
      const absolute = resolveProjectReferencedPath(dirnameForPath(projectPath), entry);
      const key = pathApiFor(absolute).normalize(absolute).toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      setProjectReferencedPath(includeSection, `Include Path ${seen.size}`, projectPath, absolute);
    });
    writeText(projectPath, document.toString(), snapshot.buffer);
  }

  inspectNativeCompilerConfiguration(projectPath: string, mode: CviBuildMode): CviCompilerConfigurationIssue[] {
    return this.inspectNativeCompilerConfigurationForConfiguration(projectPath, modeSuffix(mode), mode);
  }

  inspectNativeCompilerConfigurationForConfiguration(projectPath: string, configurationName: string, fallbackMode?: CviBuildMode): CviCompilerConfigurationIssue[] {
    const document = IniDocument.parse(readText(projectPath));
    const descriptor = buildConfigurationDescriptors(document).find((entry) => entry.name.trim().toLowerCase() === configurationName.trim().toLowerCase());
    const config = descriptor ? document.getSection(descriptor.sectionName) : (fallbackMode ? getProjectModeSection(document, fallbackMode) : undefined);
    if (!config) {
      return [{ severity: 'warning', field: 'Build Configuration', message: `CVI configuration ${JSON.stringify(configurationName)} is referenced but its serialized compiler section was not found in the project.` }];
    }
    const issues = compilerDefineIssues(reconstructValue(config, 'Compiler Defines') ?? reconstructValue(document.getSection('Compiler Defines') ?? new IniSection('', []), 'Compiler Defines') ?? '');
    if (descriptor) {
      if (config.has('Is 64-Bit') && parseBoolean(config.get('Is 64-Bit')) !== descriptor.is64Bit) {
        issues.push({ severity: 'warning', field: 'Is 64-Bit', message: `${descriptor.name} stores an inconsistent Is 64-Bit value.` });
      }
      if (config.has('Is Release') && parseBoolean(config.get('Is Release')) !== descriptor.isRelease) {
        issues.push({ severity: 'warning', field: 'Is Release', message: `${descriptor.name} stores an inconsistent Is Release value.` });
      }
    }
    const projectSettings = this.getProjectCompilerSettings(projectPath);
    if (projectSettings.precompilePrefixHeader && !projectSettings.prefixHeaderFile.trim()) {
      issues.push({ severity: 'warning', field: 'Prefix Header File', message: 'Precompile Prefix Header is enabled but no prefix header file is configured.' });
    }
    const declared = this.getDeclaredCustomBuildConfigurationCount(projectPath);
    const discovered = buildConfigurationDescriptors(document).filter((entry) => entry.isCustom).length;
    if (declared !== discovered && (declared > 0 || discovered > 0)) {
      issues.push({ severity: 'warning', field: 'Custom Build Configurations', message: `Project declares ${declared} custom configuration(s), while ${discovered} serialized configuration section(s) were safely recognized.` });
    }
    return issues;
  }


  getNativeTargetSettings(projectPath: string, mode: CviBuildMode): CviNativeTargetSettings {
    const document = IniDocument.parse(readText(projectPath));
    return nativeTargetSettingsFromSection(document, projectPath, getProjectModeSection(document, mode), modeSuffix(mode), mode);
  }

  getNativeTargetSettingsForConfiguration(projectPath: string, configurationName: string, fallbackMode?: CviBuildMode): CviNativeTargetSettings | undefined {
    const document = IniDocument.parse(readText(projectPath));
    const expected = configurationName.trim().toLowerCase();
    if (!expected) return undefined;
    const descriptor = buildConfigurationDescriptors(document).find((entry) => entry.name.trim().toLowerCase() === expected);
    if (!descriptor) return undefined;
    const config = document.getSection(descriptor.sectionName);
    if (!config) return undefined;
    return nativeTargetSettingsFromSection(document, projectPath, config, descriptor.name, descriptor.mode ?? fallbackMode);
  }

  setNativeTargetSettings(projectPath: string, mode: CviBuildMode, settings: CviNativeTargetSettings): void {
    const snapshot = readTextForMutation(projectPath);
    const document = IniDocument.parse(snapshot.text);
    const config = getProjectModeSection(document, mode);
    writeNativeTargetSettingsToSection(document, projectPath, config, modeSuffix(mode), settings);
    writeText(projectPath, document.toString(), snapshot.buffer);
  }

  setNativeTargetSettingsForConfiguration(projectPath: string, configurationName: string, settings: CviNativeTargetSettings): void {
    const normalizedName = configurationName.trim();
    if (!normalizedName || /[\r\n]/.test(normalizedName)) {
      throw new Error('CVI build configuration name must be non-empty and cannot contain line breaks.');
    }
    const snapshot = readTextForMutation(projectPath);
    const document = IniDocument.parse(snapshot.text);
    const descriptor = buildConfigurationDescriptors(document).find((entry) => entry.name.trim().toLowerCase() === normalizedName.toLowerCase());
    if (!descriptor) {
      throw new Error(`Cannot update target settings: native CVI configuration ${JSON.stringify(normalizedName)} was not found in the project.`);
    }
    const config = document.getSection(descriptor.sectionName);
    if (!config) {
      throw new Error(`Cannot update target settings: native CVI section [${descriptor.sectionName}] is missing.`);
    }
    writeNativeTargetSettingsToSection(document, projectPath, config, descriptor.name, settings);
    writeText(projectPath, document.toString(), snapshot.buffer);
  }

  getTargetPath(projectPath: string, mode: CviBuildMode): string | undefined {
    const document = IniDocument.parse(readText(projectPath));
    const section = document.getSection('Create Executable');
    return section ? resolveOutputPath(section, mode, projectPath) : undefined;
  }

  getTargetPathForConfiguration(projectPath: string, configurationName: string, fallbackMode?: CviBuildMode): string | undefined {
    const document = IniDocument.parse(readText(projectPath));
    const section = document.getSection('Create Executable');
    if (!section) return undefined;
    const exact = resolveOutputPathBySuffix(section, configurationName.trim(), projectPath);
    return exact ?? (fallbackMode ? resolveOutputPath(section, fallbackMode, projectPath) : undefined);
  }

  getWorkspaceProjectBuildConfiguration(workspacePath: string, projectIndex: number): string | undefined {
    if (path.extname(workspacePath).toLowerCase() !== '.cws') {
      return undefined;
    }
    const document = IniDocument.parse(readText(workspacePath));
    const section = document.getSection(`Project Header ${workspaceProjectSuffix(projectIndex)}`);
    return unquote(section?.get('Build Configuration'));
  }

  getWorkspaceProjectBuildMode(workspacePath: string, projectIndex: number): CviBuildMode | undefined {
    return buildModeFromNativeConfiguration(this.getWorkspaceProjectBuildConfiguration(workspacePath, projectIndex));
  }

  setWorkspaceProjectBuildMode(workspacePath: string, projectIndex: number, mode: CviBuildMode): void {
    this.setWorkspaceProjectBuildConfiguration(workspacePath, projectIndex, modeSuffix(mode));
  }

  setWorkspaceProjectBuildConfiguration(workspacePath: string, projectIndex: number, configurationName: string): void {
    if (path.extname(workspacePath).toLowerCase() !== '.cws') {
      return;
    }
    const normalizedName = configurationName.trim();
    if (!normalizedName || /[\r\n]/.test(normalizedName)) {
      throw new Error('CVI build configuration name must be non-empty and cannot contain line breaks.');
    }
    const snapshot = readTextForMutation(workspacePath);
    const document = IniDocument.parse(snapshot.text);
    const header = document.getSection('Workspace Header');
    if (!header) {
      throw new Error('Invalid CVI workspace: missing [Workspace Header].');
    }
    const projectCount = Number(header.get('Number of Projects') ?? '0');
    if (projectIndex < 1 || projectIndex > projectCount || !header.has(`Project ${workspaceProjectSuffix(projectIndex)}`)) {
      throw new Error(`Refusing to update CVI build configuration: project ${projectIndex} is not declared in the workspace.`);
    }
    const sectionName = `Project Header ${workspaceProjectSuffix(projectIndex)}`;
    const projectHeader = document.getSection(sectionName);
    if (!projectHeader) {
      throw new Error(`Invalid CVI workspace: missing [${sectionName}].`);
    }
    projectHeader.set('Build Configuration', quote(normalizedName));
    writeText(workspacePath, document.toString(), snapshot.buffer);
  }


  hasWorkspaceBuildConfigurationSection(workspacePath: string, projectIndex: number, configurationName: string): boolean {
    if (path.extname(workspacePath).toLowerCase() !== '.cws') return false;
    const normalizedName = configurationName.trim();
    if (!normalizedName) return false;
    const document = IniDocument.parse(readText(workspacePath));
    return Boolean(document.getSection(`Default Build Config ${workspaceProjectSuffix(projectIndex)} ${normalizedName}`));
  }

  getWorkspaceNativeBuildOptionsForConfiguration(workspacePath: string, projectIndex: number, configurationName: string): CviWorkspaceNativeBuildOptions | undefined {
    if (path.extname(workspacePath).toLowerCase() !== '.cws') return undefined;
    const normalizedName = configurationName.trim();
    if (!normalizedName) return undefined;
    const document = IniDocument.parse(readText(workspacePath));
    const suffix = workspaceProjectSuffix(projectIndex);
    const config = document.getSection(`Default Build Config ${suffix} ${normalizedName}`);
    const global = document.getSection(`Build Options ${suffix}`);
    if (!config) return undefined;
    const boolValue = (key: string, fallback = false): boolean => config.has(key) ? parseBoolean(config.get(key), fallback) : parseBoolean(global?.get(key), fallback);
    const stringValue = (key: string, fallback = ''): string => unquote(config.get(key)) ?? config.get(key) ?? unquote(global?.get(key)) ?? global?.get(key) ?? fallback;
    return {
      generateBrowseInfo: boolValue('Generate Browse Info', true),
      enableUninitializedLocalsRuntimeWarning: boolValue('Enable Uninitialized Locals Runtime Warning', true),
      batchBuild: boolValue('Batch Build'),
      profile: stringValue('Profile', 'Disabled'),
      debuggingLevel: stringValue('Debugging Level', 'Standard'),
      executionTrace: stringValue('Execution Trace', 'Disabled'),
      breakOnLibraryErrors: parseBoolean(global?.get('Break On Library Errors')),
      breakOnFirstChanceExceptions: parseBoolean(global?.get('Break On First Chance Exceptions'))
    };
  }

  setWorkspaceNativeBuildOptionsForConfiguration(workspacePath: string, projectIndex: number, configurationName: string, options: CviWorkspaceNativeBuildOptions): void {
    if (path.extname(workspacePath).toLowerCase() !== '.cws') return;
    const normalizedName = configurationName.trim();
    if (!normalizedName || /[\r\n]/.test(normalizedName)) throw new Error('CVI build configuration name must be non-empty and cannot contain line breaks.');
    const snapshot = readTextForMutation(workspacePath);
    const document = IniDocument.parse(snapshot.text);
    const suffix = workspaceProjectSuffix(projectIndex);
    const config = document.getSection(`Default Build Config ${suffix} ${normalizedName}`);
    if (!config) {
      throw new Error(`CVI workspace does not contain a serialized run/build section for custom configuration ${JSON.stringify(normalizedName)}. Open/save that configuration once in CVI before editing its workspace options from VS Code.`);
    }
    const global = document.getSection(`Build Options ${suffix}`) ?? document.ensureSection(`Build Options ${suffix}`);
    setBoolean(config, 'Generate Browse Info', options.generateBrowseInfo);
    setBoolean(config, 'Enable Uninitialized Locals Runtime Warning', options.enableUninitializedLocalsRuntimeWarning);
    setBoolean(config, 'Batch Build', options.batchBuild);
    config.set('Profile', quote(options.profile || 'Disabled'));
    config.set('Debugging Level', quote(options.debuggingLevel || 'Standard'));
    config.set('Execution Trace', quote(options.executionTrace || 'Disabled'));
    setBoolean(global, 'Break On Library Errors', options.breakOnLibraryErrors);
    setBoolean(global, 'Break On First Chance Exceptions', options.breakOnFirstChanceExceptions);
    writeText(workspacePath, document.toString(), snapshot.buffer);
  }

  getWorkspaceNativeBuildOptions(workspacePath: string, projectIndex: number, mode: CviBuildMode): CviWorkspaceNativeBuildOptions | undefined {
    if (path.extname(workspacePath).toLowerCase() !== '.cws') {
      return undefined;
    }
    const document = IniDocument.parse(readText(workspacePath));
    const suffix = workspaceProjectSuffix(projectIndex);
    const config = document.getSection(`Default Build Config ${suffix} ${modeSuffix(mode)}`);
    const global = document.getSection(`Build Options ${suffix}`);
    if (!config && !global) {
      return undefined;
    }
    const boolValue = (key: string, fallback = false): boolean => config?.has(key)
      ? parseBoolean(config.get(key), fallback)
      : parseBoolean(global?.get(key), fallback);
    const stringValue = (key: string, fallback = ''): string => unquote(config?.get(key)) ?? config?.get(key) ?? unquote(global?.get(key)) ?? global?.get(key) ?? fallback;
    return {
      generateBrowseInfo: boolValue('Generate Browse Info', true),
      enableUninitializedLocalsRuntimeWarning: boolValue('Enable Uninitialized Locals Runtime Warning', true),
      batchBuild: boolValue('Batch Build'),
      profile: stringValue('Profile', 'Disabled'),
      debuggingLevel: stringValue('Debugging Level', 'Standard'),
      executionTrace: stringValue('Execution Trace', 'Disabled'),
      breakOnLibraryErrors: parseBoolean(global?.get('Break On Library Errors')),
      breakOnFirstChanceExceptions: parseBoolean(global?.get('Break On First Chance Exceptions'))
    };
  }

  setWorkspaceNativeBuildOptions(workspacePath: string, projectIndex: number, mode: CviBuildMode, options: CviWorkspaceNativeBuildOptions): void {
    if (path.extname(workspacePath).toLowerCase() !== '.cws') {
      return;
    }
    const snapshot = readTextForMutation(workspacePath);
    const document = IniDocument.parse(snapshot.text);
    const header = document.getSection('Workspace Header');
    if (!header) {
      throw new Error('Invalid CVI workspace: missing [Workspace Header].');
    }
    const projectCount = Number(header.get('Number of Projects') ?? '0');
    if (projectIndex < 1 || projectIndex > projectCount || !header.has(`Project ${workspaceProjectSuffix(projectIndex)}`)) {
      throw new Error(`Refusing to update CVI build options: project ${projectIndex} is not declared in the workspace.`);
    }
    const version = Number(header.get('Version') ?? '1200');
    ensureWorkspaceProjectSections(document, projectIndex, version);
    const suffix = workspaceProjectSuffix(projectIndex);
    const config = document.ensureSection(`Default Build Config ${suffix} ${modeSuffix(mode)}`);
    const global = document.ensureSection(`Build Options ${suffix}`);
    setBoolean(config, 'Generate Browse Info', options.generateBrowseInfo);
    setBoolean(config, 'Enable Uninitialized Locals Runtime Warning', options.enableUninitializedLocalsRuntimeWarning);
    setBoolean(config, 'Batch Build', options.batchBuild);
    config.set('Profile', quote(options.profile || 'Disabled'));
    config.set('Debugging Level', quote(options.debuggingLevel || 'Standard'));
    config.set('Execution Trace', quote(options.executionTrace || 'Disabled'));
    setBoolean(global, 'Break On Library Errors', options.breakOnLibraryErrors);
    setBoolean(global, 'Break On First Chance Exceptions', options.breakOnFirstChanceExceptions);
    writeText(workspacePath, document.toString(), snapshot.buffer);
  }


  getWorkspaceRunOptionsForConfiguration(workspacePath: string, projectIndex: number, configurationName: string): CviRunOptions | undefined {
    if (path.extname(workspacePath).toLowerCase() !== '.cws') return undefined;
    const normalizedName = configurationName.trim();
    if (!normalizedName) return undefined;
    const document = IniDocument.parse(readText(workspacePath));
    const suffix = workspaceProjectSuffix(projectIndex);
    const config = document.getSection(`Default Build Config ${suffix} ${normalizedName}`);
    if (!config) return undefined;
    const legacyArgs = document.getSection(`Command Line Args ${suffix}`);
    const legacyDll = document.getSection(`DLL Debugging Support ${suffix}`);
    const value = (key: string): string => reconstructValue(config, key)
      ?? reconstructValue(legacyArgs ?? new IniSection('', []), key)
      ?? '';
    return {
      arguments: value('Command Line Args'),
      workingDirectory: value('Working Directory'),
      environmentOptions: value('Environment Options'),
      externalProcessPath: value('External Process Path') || reconstructValue(legacyDll ?? new IniSection('', []), 'External Process Path') || ''
    };
  }

  setWorkspaceRunOptionsForConfiguration(workspacePath: string, projectIndex: number, configurationName: string, options: CviRunOptions): void {
    if (path.extname(workspacePath).toLowerCase() !== '.cws') return;
    const normalizedName = configurationName.trim();
    if (!normalizedName || /[\r\n]/.test(normalizedName)) throw new Error('CVI build configuration name must be non-empty and cannot contain line breaks.');
    const snapshot = readTextForMutation(workspacePath);
    const document = IniDocument.parse(snapshot.text);
    const suffix = workspaceProjectSuffix(projectIndex);
    const config = document.getSection(`Default Build Config ${suffix} ${normalizedName}`);
    if (!config) {
      throw new Error(`CVI workspace does not contain a serialized run/build section for custom configuration ${JSON.stringify(normalizedName)}. Open/save that configuration once in CVI before editing its Run & Debug settings from VS Code.`);
    }
    setPossiblyLongStringValue(config, 'Command Line Args', options.arguments);
    setPossiblyLongRuntimePathValue(config, 'Working Directory', options.workingDirectory);
    setPossiblyLongStringValue(config, 'Environment Options', options.environmentOptions);
    setPossiblyLongRuntimePathValue(config, 'External Process Path', options.externalProcessPath);
    writeText(workspacePath, document.toString(), snapshot.buffer);
  }

  getWorkspaceRunOptions(workspacePath: string, projectIndex: number, mode: CviBuildMode = 'debug'): CviRunOptions {
    if (path.extname(workspacePath).toLowerCase() !== '.cws') {
      return { arguments: '', workingDirectory: '', environmentOptions: '', externalProcessPath: '' };
    }
    const document = IniDocument.parse(readText(workspacePath));
    const suffix = String(projectIndex).padStart(4, '0');
    const modeSection = document.getSection(`Default Build Config ${suffix} ${modeSuffix(mode)}`);
    const section = document.getSection(`Command Line Args ${suffix}`);
    const dllSection = document.getSection(`DLL Debugging Support ${suffix}`);
    const value = (key: string): string => reconstructValue(modeSection ?? new IniSection('', []), key)
      ?? reconstructValue(section ?? new IniSection('', []), key)
      ?? '';
    return {
      arguments: value('Command Line Args'),
      workingDirectory: value('Working Directory'),
      environmentOptions: value('Environment Options'),
      externalProcessPath: value('External Process Path') || reconstructValue(dllSection ?? new IniSection('', []), 'External Process Path') || ''
    };
  }

  setWorkspaceRunOptions(workspacePath: string, projectIndex: number, mode: CviBuildMode, options: CviRunOptions): void {
    if (path.extname(workspacePath).toLowerCase() !== '.cws') {
      return;
    }
    const snapshot = readTextForMutation(workspacePath);
    const document = IniDocument.parse(snapshot.text);
    const header = document.getSection('Workspace Header');
    if (!header) {
      throw new Error('Invalid CVI workspace: missing [Workspace Header].');
    }
    const projectCount = Number(header.get('Number of Projects') ?? '0');
    if (projectIndex < 1 || projectIndex > projectCount || !header.has(`Project ${workspaceProjectSuffix(projectIndex)}`)) {
      throw new Error(`Refusing to update CVI run settings: project ${projectIndex} is not declared in the workspace.`);
    }
    const version = Number(header.get('Version') ?? '1200');
    ensureWorkspaceProjectSections(document, projectIndex, version);
    const suffix = workspaceProjectSuffix(projectIndex);
    const sectionName = `Default Build Config ${suffix} ${modeSuffix(mode)}`;
    const config = document.getSection(sectionName);
    if (!config) {
      throw new Error(`Unable to initialize CVI run settings: [${sectionName}] is missing.`);
    }
    // CVI persists run options per build configuration in [Default Build Config ....].
    // Do not mirror values into the legacy [Command Line Args ....] or
    // [DLL Debugging Support ....] sections: rewriting those compatibility
    // sections caused some CVI workspaces to become unreadable.
    setPossiblyLongStringValue(config, 'Command Line Args', options.arguments);
    setPossiblyLongRuntimePathValue(config, 'Working Directory', options.workingDirectory);
    setPossiblyLongStringValue(config, 'Environment Options', options.environmentOptions);
    setPossiblyLongRuntimePathValue(config, 'External Process Path', options.externalProcessPath);
    writeText(workspacePath, document.toString(), snapshot.buffer);
  }

  inspectWorkspaceCompatibility(workspacePath: string): string[] {
    if (path.extname(workspacePath).toLowerCase() !== '.cws' || !fs.existsSync(workspacePath)) {
      return [];
    }
    const document = IniDocument.parse(readText(workspacePath));
    const issues: string[] = [];
    const header = document.getSection('Workspace Header');
    if (!header) return ['Missing [Workspace Header].'];

    for (const duplicate of duplicateSectionNames(document)) {
      issues.push(`Duplicate section name [${duplicate}].`);
    }

    const version = Number(header.get('Version') ?? '1200');
    const declaredCount = Number(header.get('Number of Projects') ?? '0');
    const entries = exactWorkspaceProjectEntries(header);
    const actualIndexes = new Set(entries.map((entry) => entry.index));
    if (declaredCount !== entries.length) {
      issues.push(`[Workspace Header] Number of Projects=${declaredCount}, but ${entries.length} non-empty Project NNNN entries exist.`);
    }
    entries.forEach((entry, position) => {
      if (entry.index !== position + 1) {
        issues.push(`[Workspace Header] Project ${workspaceProjectSuffix(entry.index)} is not contiguous; expected ${workspaceProjectSuffix(position + 1)}.`);
      }
      const absolutePath = resolveCviReferencePath(path.dirname(workspacePath), entry.storedPath);
      if (!fs.existsSync(absolutePath)) {
        issues.push(`[Workspace Header] Project ${workspaceProjectSuffix(entry.index)} references a missing project file: ${absolutePath}`);
      }
      for (const sectionName of requiredWorkspaceProjectSectionNames(document, entry.index, version)) {
        if (!document.getSection(sectionName)) {
          issues.push(`[${sectionName}] is missing for workspace project ${workspaceProjectSuffix(entry.index)}.`);
        }
      }
    });
    const activeProject = Number(header.get('Active Project') ?? '0');
    if ((entries.length === 0 && activeProject !== 0) || (entries.length > 0 && !actualIndexes.has(activeProject))) {
      issues.push(`[Workspace Header] Active Project=${activeProject} does not identify a declared project.`);
    }

    for (const section of document.sections) {
      const projectSectionMatch = section.name.match(WORKSPACE_PROJECT_SECTION_PATTERN);
      if (projectSectionMatch && !actualIndexes.has(Number(projectSectionMatch[2]))) {
        issues.push(`Orphaned workspace project section [${section.name}].`);
      }
    }

    const fileSections = document.sections.filter((candidate) => /^File \d{4}$/i.test(candidate.name));
    const openedFilesRaw = header.get('Number of Opened Files');
    if (openedFilesRaw !== undefined) {
      const openedFiles = Number(openedFilesRaw);
      if (!Number.isInteger(openedFiles) || openedFiles < 0) {
        issues.push(`[Workspace Header] Number of Opened Files=${openedFilesRaw} is not a valid non-negative CVI session count.`);
      }
    }
    const filePaths = new Map<string, string>();
    for (const section of fileSections) {
      const storedPath = readWorkspaceFilePath(section);
      if (!storedPath) {
        issues.push(`[${section.name}] has no valid Path.`);
      } else {
        const comparable = normalizeComparablePath(storedPath);
        const previous = filePaths.get(comparable);
        if (previous) issues.push(`[${section.name}] duplicates ${previous}: ${storedPath}`);
        else filePaths.set(comparable, section.name);
      }
      const memberships = parseWorkspaceMemberships(section);
      if (memberships.length !== new Set(memberships).size) {
        issues.push(`[${section.name}] contains duplicate In Projects indexes.`);
      }
      for (const index of memberships) {
        if (!actualIndexes.has(index)) issues.push(`[${section.name}] In Projects references missing project ${index}.`);
      }
    }

    const configuredValues = collectConfiguredRunValues(document);
    for (const section of document.sections) {
      if (/^Default Build Config \d{4} (?:Debug|Release|Debug64|Release64)$/i.test(section.name) || /^DLL Debugging Support \d{4}$/i.test(section.name)) {
        for (const key of ['Working Directory', 'External Process Path']) {
          const value = reconstructValue(section, key);
          if (value && toCviRuntimeStoragePath(value) !== value) {
            issues.push(`[${section.name}] ${key} uses a non-CVI path representation: ${value}`);
          }
        }
      }
      const legacyCommandMatch = section.name.match(/^Command Line Args (\d{4})$/i);
      if (legacyCommandMatch) {
        if (reconstructValue(section, 'External Process Path') !== undefined) {
          issues.push(`[${section.name}] contains an unexpected External Process Path compatibility key.`);
        }
        for (const key of ['Command Line Args', 'Working Directory', 'Environment Options']) {
          const value = reconstructValue(section, key) ?? '';
          if (value && configuredValues.get(legacyCommandMatch[1])?.get(key)?.has(value)) {
            issues.push(`[${section.name}] duplicates per-configuration ${key}.`);
          }
        }
      }
      const legacyDllMatch = section.name.match(/^DLL Debugging Support (\d{4})$/i);
      if (legacyDllMatch) {
        const value = reconstructValue(section, 'External Process Path') ?? '';
        if (value && configuredValues.get(legacyDllMatch[1])?.get('External Process Path')?.has(value)) {
          issues.push(`[${section.name}] duplicates a per-configuration External Process Path.`);
        }
      }
    }
    return [...new Set(issues)];
  }

  repairWorkspaceCompatibility(workspacePath: string): { changed: boolean; changes: string[] } {
    if (path.extname(workspacePath).toLowerCase() !== '.cws') {
      throw new Error('Native workspace compatibility repair requires a .cws workspace.');
    }
    const document = IniDocument.parse(readText(workspacePath));
    const changes: string[] = [];
    const header = document.getSection('Workspace Header');
    if (!header) throw new Error('Invalid CVI workspace: missing [Workspace Header].');

    changes.push(...remapWorkspaceProjectStructure(document));

    const normalizePathKey = (section: IniSection, key: string): void => {
      const current = reconstructValue(section, key);
      if (current === undefined) return;
      const normalized = toCviRuntimeStoragePath(current);
      if (normalized !== current) {
        setPossiblyLongStringValue(section, key, normalized);
        changes.push(`[${section.name}] ${key}: ${current} -> ${normalized}`);
      }
    };
    for (const section of document.sections) {
      if (/^Default Build Config \d{4} (?:Debug|Release|Debug64|Release64)$/i.test(section.name)) {
        normalizePathKey(section, 'Working Directory');
        normalizePathKey(section, 'External Process Path');
      }
    }
    const configuredValues = collectConfiguredRunValues(document);
    for (const section of document.sections) {
      const legacyCommandMatch = section.name.match(/^Command Line Args (\d{4})$/i);
      if (legacyCommandMatch) {
        normalizePathKey(section, 'Working Directory');
        if (reconstructValue(section, 'External Process Path') !== undefined) {
          deletePossiblyLongValue(section, 'External Process Path');
          changes.push(`[${section.name}] removed unexpected External Process Path compatibility key.`);
        }
        for (const key of ['Command Line Args', 'Working Directory', 'Environment Options']) {
          const current = reconstructValue(section, key) ?? '';
          if (current && configuredValues.get(legacyCommandMatch[1])?.get(key)?.has(current)) {
            setPossiblyLongStringValue(section, key, '');
            changes.push(`[${section.name}] cleared duplicated legacy ${key}.`);
          }
        }
      }
      const legacyDllMatch = section.name.match(/^DLL Debugging Support (\d{4})$/i);
      if (legacyDllMatch) {
        normalizePathKey(section, 'External Process Path');
        const current = reconstructValue(section, 'External Process Path') ?? '';
        if (current && configuredValues.get(legacyDllMatch[1])?.get('External Process Path')?.has(current)) {
          setPossiblyLongStringValue(section, 'External Process Path', '');
          changes.push(`[${section.name}] cleared duplicated legacy External Process Path.`);
        }
      }
    }

    const version = Number(header.get('Version') ?? '1200');
    const projectCount = Number(header.get('Number of Projects') ?? '0');
    for (let projectIndex = 1; projectIndex <= projectCount; projectIndex += 1) {
      changes.push(...ensureWorkspaceProjectSections(document, projectIndex, version));
    }

    // Merge duplicate workspace file sections by physical path and preserve memberships/breakpoints.
    const byPath = new Map<string, IniSection>();
    for (const section of [...document.sections].filter((candidate) => /^File \d{4}$/i.test(candidate.name))) {
      const storedPath = readWorkspaceFilePath(section);
      if (!storedPath) {
        const index = document.sections.indexOf(section);
        if (index >= 0) document.sections.splice(index, 1);
        changes.push(`Removed [${section.name}] because it has no valid Path.`);
        continue;
      }
      const key = normalizeComparablePath(storedPath);
      const first = byPath.get(key);
      if (!first) {
        byPath.set(key, section);
        continue;
      }
      const memberships = [...new Set([...parseWorkspaceMemberships(first), ...parseWorkspaceMemberships(section)])].sort((a, b) => a - b);
      first.set('In Projects', quote(memberships.length > 0 ? `${memberships.join(',')},` : ''));
      const breakpoints = readWorkspaceBreakpoints(first);
      for (const [line, value] of readWorkspaceBreakpoints(section)) if (!breakpoints.has(line)) breakpoints.set(line, value);
      replaceWorkspaceBreakpoints(first, breakpoints);
      const firstType = unquote(first.get('File Type')) ?? 'Unknown';
      const duplicateType = unquote(section.get('File Type')) ?? 'Unknown';
      if (firstType === 'Unknown' && duplicateType !== 'Unknown') first.set('File Type', quote(duplicateType));
      const index = document.sections.indexOf(section);
      if (index >= 0) document.sections.splice(index, 1);
      changes.push(`Merged duplicate workspace file [${section.name}] into [${first.name}]: ${storedPath}`);
    }

    // Rebuild In Projects from the actual project files whenever the project is readable.
    const expectedMemberships = new Map<string, number[]>();
    for (let projectIndex = 1; projectIndex <= projectCount; projectIndex += 1) {
      const stored = unquote(header.get(`Project ${workspaceProjectSuffix(projectIndex)}`)) ?? '';
      if (!stored) continue;
      const projectPath = resolveCviReferencePath(path.dirname(workspacePath), stored);
      if (!fs.existsSync(projectPath)) continue;
      try {
        for (const file of this.parseProject(projectPath).files) {
          const key = normalizeComparablePath(file.absolutePath);
          const indexes = expectedMemberships.get(key) ?? [];
          if (!indexes.includes(projectIndex)) indexes.push(projectIndex);
          expectedMemberships.set(key, indexes);
        }
      } catch { /* keep existing metadata if a project cannot be parsed */ }
    }
    for (const section of document.sections.filter((candidate) => /^File \d{4}$/i.test(candidate.name))) {
      const storedPath = readWorkspaceFilePath(section);
      if (!storedPath) continue;
      const expected = (expectedMemberships.get(normalizeComparablePath(storedPath)) ?? []).sort((a, b) => a - b);
      const current = parseWorkspaceMemberships(section).filter((index) => index >= 1 && index <= projectCount).sort((a, b) => a - b);
      if (current.join(',') !== expected.join(',')) {
        section.set('In Projects', quote(expected.length > 0 ? `${expected.join(',')},` : ''));
        changes.push(`[${section.name}] synchronized In Projects -> ${expected.join(',') || '(none)'}.`);
      }
    }

    // Preserve Number of Opened Files: it is CVI UI/session state and cannot be
    // reconstructed from the number of [File NNNN] reference sections.

    if (changes.length > 0) writeText(workspacePath, document.toString());
    return { changed: changes.length > 0, changes };
  }

  getProjectBuildActions(projectPath: string, mode: CviBuildMode): { preBuildActions: string[]; customBuildActions: string[]; postBuildActions: string[]; nativeSectionsPresent: boolean } {
    const document = IniDocument.parse(readText(projectPath));
    const modeName = modeSuffix(mode);
    const readActions = (kind: string): { actions: string[]; present: boolean } => {
      const section = document.getSection(`${modeName} ${kind}`);
      if (!section) {
        return { actions: [], present: false };
      }
      const actions = section.entries()
        .filter(({ key }) => /^Build Action\d+$/i.test(key))
        .sort((left, right) => numericSuffix(left.key) - numericSuffix(right.key))
        .map(({ value }) => unquote(value) ?? '')
        .filter(Boolean);
      return { actions, present: true };
    };
    const pre = readActions('Pre-build Actions');
    const custom = readActions('Custom Build Actions');
    const post = readActions('Post-build Actions');
    return {
      preBuildActions: pre.actions,
      customBuildActions: custom.actions,
      postBuildActions: post.actions,
      nativeSectionsPresent: pre.present || custom.present || post.present
    };
  }

  setProjectBuildActions(projectPath: string, mode: CviBuildMode, actions: { preBuildActions: string[]; customBuildActions: string[]; postBuildActions: string[] }): void {
    const snapshot = readTextForMutation(projectPath);
    const document = IniDocument.parse(snapshot.text);
    const modeName = modeSuffix(mode);
    const writeActions = (kind: string, values: string[]): void => {
      const sectionName = `${modeName} ${kind}`;
      const normalized = values.map((value) => String(value).trim()).filter(Boolean);
      if (!normalized.length) {
        document.removeSection(sectionName);
        return;
      }
      const section = document.ensureSection(sectionName, 'Signing Info');
      section.deleteMatching(/^\s*Build Action\d+\s*=/i);
      normalized.forEach((value, index) => section.set(`Build Action${index + 1}`, quote(value)));
      if (!section.lines.some((line) => line.trim() === '')) {
        section.lines.push('');
      }
    };
    writeActions('Custom Build Actions', actions.customBuildActions);
    writeActions('Pre-build Actions', actions.preBuildActions);
    writeActions('Post-build Actions', actions.postBuildActions);
    writeText(projectPath, document.toString(), snapshot.buffer);
  }

  setTargetType(projectPath: string, targetType: string): void {
    if (!['Executable', 'Dynamic Link Library', 'Static Library'].includes(targetType)) {
      throw new Error(`Unsupported CVI target type: ${targetType}`);
    }
    const snapshot = readTextForMutation(projectPath);
    const document = IniDocument.parse(snapshot.text);
    const header = document.getSection('Project Header');
    if (!header) {
      throw new Error('Invalid CVI project: missing [Project Header].');
    }
    header.set('Target Type', quote(targetType));
    const target = document.ensureSection('Create Executable');
    const extension = targetType === 'Dynamic Link Library' ? '.dll' : targetType === 'Static Library' ? '.lib' : '.exe';
    const modes: CviBuildMode[] = ['debug', 'release', 'debug64', 'release64'];
    for (const mode of modes) {
      const suffix = modeSuffix(mode);
      const key = `Executable File_${suffix}`;
      const relativeFlag = target.get(`${key} Is Rel`);
      const wasExplicitlyAbsolute = relativeFlag !== undefined && !parseBoolean(relativeFlag);
      const currentPath = resolveOutputPath(target, mode, projectPath);
      const nextPath = replaceExtension(currentPath ?? projectPath, extension);
      setOutputPath(target, mode, projectPath, nextPath);

      // Target type changes must not silently change an explicit absolute output into a relative one.
      if (wasExplicitlyAbsolute) {
        deletePossiblyLongValue(target, `${key} Rel Path`);
        target.delete(`${key} Rel To`);
        target.set(`${key} Is Rel`, 'False');
        setPossiblyLongValue(target, key, nextPath);
      }
    }
    writeText(projectPath, document.toString(), snapshot.buffer);
  }

  updateWorkspacePathAfterRename(workspacePath: string): void {
    const document = IniDocument.parse(readText(workspacePath));
    const header = document.getSection('Workspace Header');
    if (!header) {
      throw new Error('Invalid CVI workspace: missing [Workspace Header].');
    }
    setPossiblyLongValue(header, 'Pathname', workspacePath);
    writeText(workspacePath, document.toString());
  }

  updateProjectPathAfterRename(projectPath: string, previousProjectPath: string): void {
    const document = IniDocument.parse(readText(projectPath));
    const header = document.getSection('Project Header');
    if (!header) {
      throw new Error('Invalid CVI project: missing [Project Header].');
    }

    setPossiblyLongValue(header, 'Pathname', projectPath);

    const previousBaseName = path.basename(previousProjectPath, path.extname(previousProjectPath));
    const nextBaseName = path.basename(projectPath, path.extname(projectPath));
    const createExecutable = document.getSection('Create Executable');
    if (createExecutable && previousBaseName.toLowerCase() !== nextBaseName.toLowerCase()) {
      for (const mode of ['Debug', 'Release', 'Debug64', 'Release64']) {
        const relativeKey = `Executable File_${mode} Rel Path`;
        const relativeValue = unquote(createExecutable.get(relativeKey));
        if (relativeValue) {
          const relativeExtension = path.extname(relativeValue);
          const relativeBaseName = path.basename(relativeValue, relativeExtension);
          if (relativeBaseName.toLowerCase() === previousBaseName.toLowerCase()) {
            createExecutable.set(relativeKey, quote(`${nextBaseName}${relativeExtension}`));
          }
        }

        const absoluteKey = `Executable File_${mode}`;
        const absoluteValue = reconstructValue(createExecutable, absoluteKey);
        if (absoluteValue) {
          const nativeAbsolute = fromCviPath(absoluteValue);
          const absoluteExtension = path.extname(nativeAbsolute);
          const absoluteBaseName = path.basename(nativeAbsolute, absoluteExtension);
          if (absoluteBaseName.toLowerCase() === previousBaseName.toLowerCase()) {
            setPossiblyLongValue(createExecutable, absoluteKey, path.join(path.dirname(projectPath), `${nextBaseName}${absoluteExtension}`));
          }
        }
      }
    }

    writeText(projectPath, document.toString());
  }

  updateWorkspaceProjectPath(workspacePath: string, projectIndex: number, projectPath: string): void {
    if (path.extname(workspacePath).toLowerCase() !== '.cws') {
      return;
    }
    const document = IniDocument.parse(readText(workspacePath));
    const header = document.getSection('Workspace Header');
    if (!header) {
      throw new Error('Invalid CVI workspace: missing [Workspace Header].');
    }
    const key = `Project ${workspaceProjectSuffix(projectIndex)}`;
    if (!header.has(key)) {
      throw new Error(`CVI workspace project entry not found: ${key}.`);
    }
    const reference = createCviPathReference(path.dirname(workspacePath), projectPath);
    header.set(key, quote(reference.storedPath));
    writeText(workspacePath, document.toString());
  }

  updateWorkspaceReferencedFilePath(workspacePath: string, previousPath: string, nextPath: string): void {
    if (path.extname(workspacePath).toLowerCase() !== '.cws' || !fs.existsSync(workspacePath)) {
      return;
    }
    const snapshot = readTextForMutation(workspacePath);
    const document = IniDocument.parse(snapshot.text);
    let changed = false;
    const previousNormalized = path.normalize(previousPath).toLowerCase();
    for (const section of document.sections.filter((candidate) => /^File \d{4}$/i.test(candidate.name))) {
      const stored = reconstructValue(section, 'Path');
      if (!stored) {
        continue;
      }
      const storedNative = fromCviPath(stored);
      if (path.normalize(storedNative).toLowerCase() !== previousNormalized) {
        continue;
      }
      section.set('Path', quote(toCviPath(nextPath)));
      section.set('File Type', quote(cviWorkspaceFileType(fileTypeForPath(nextPath), nextPath)));
      changed = true;
    }
    if (changed) {
      writeText(workspacePath, document.toString(), snapshot.buffer);
    }
  }

  updateWorkspaceReferencedFileMemberships(workspacePath: string, filePath: string, projectIndexes: number[]): void {
    if (path.extname(workspacePath).toLowerCase() !== '.cws' || !fs.existsSync(workspacePath)) {
      return;
    }
    const snapshot = readTextForMutation(workspacePath);
    const document = IniDocument.parse(snapshot.text);
    const target = normalizeComparablePath(filePath);
    const indexes = [...new Set(projectIndexes.filter((index) => Number.isInteger(index) && index > 0))].sort((a, b) => a - b);
    let changed = false;
    for (const section of document.sections.filter((candidate) => /^File \d{4}$/i.test(candidate.name))) {
      const storedPath = readWorkspaceFilePath(section);
      if (!storedPath || normalizeComparablePath(storedPath) !== target) {
        continue;
      }
      section.set('In Projects', quote(indexes.length > 0 ? `${indexes.join(',')},` : ''));
      changed = true;
    }
    if (changed) {
      writeText(workspacePath, document.toString(), snapshot.buffer);
    }
  }

  removeWorkspaceReferencedFile(workspacePath: string, filePath: string): void {
    if (path.extname(workspacePath).toLowerCase() !== '.cws' || !fs.existsSync(workspacePath)) {
      return;
    }
    const snapshot = readTextForMutation(workspacePath);
    const document = IniDocument.parse(snapshot.text);
    const header = document.getSection('Workspace Header');
    if (!header) {
      throw new Error('Invalid CVI workspace: missing [Workspace Header].');
    }
    const target = normalizeComparablePath(filePath);
    let changed = false;
    for (const section of [...document.sections].filter((candidate) => /^File \d{4}$/i.test(candidate.name))) {
      const storedPath = readWorkspaceFilePath(section);
      if (!storedPath || normalizeComparablePath(storedPath) !== target) {
        continue;
      }
      document.removeSection(section.name);
      changed = true;
    }
    if (changed) {
      // Preserve Number of Opened Files; removing a workspace reference does not let
      // CVI PM reliably infer which native editor windows CVI currently considers open.
      writeText(workspacePath, document.toString(), snapshot.buffer);
    }
  }

  setWorkspaceActiveProject(workspacePath: string, projectIndex: number): void {
    if (path.extname(workspacePath).toLowerCase() !== '.cws') {
      return;
    }
    const document = IniDocument.parse(readText(workspacePath));
    const header = document.getSection('Workspace Header');
    if (!header) {
      throw new Error('Invalid CVI workspace: missing [Workspace Header].');
    }
    const projectCount = Number(header.get('Number of Projects') ?? '0');
    if (projectIndex < 1 || projectIndex > projectCount) {
      throw new Error(`Invalid project index ${projectIndex}.`);
    }
    header.set('Active Project', String(projectIndex));
    writeText(workspacePath, document.toString());
  }

  addProjectToWorkspace(workspacePath: string, projectPath: string): number {
    if (path.extname(workspacePath).toLowerCase() !== '.cws') {
      throw new Error('A standalone .prj cannot contain multiple projects. Open or create a .cws workspace first.');
    }
    const document = IniDocument.parse(readText(workspacePath));
    const header = document.getSection('Workspace Header');
    if (!header) {
      throw new Error('Invalid CVI workspace: missing [Workspace Header].');
    }

    const workspaceDirectory = path.dirname(workspacePath);
    const reference = createCviPathReference(workspaceDirectory, projectPath);
    const expectedPath = path.normalize(reference.absolutePath).toLowerCase();
    const existing = header.entries().find(({ key, value }) => {
      if (!/^Project \d{4}$/i.test(key)) {
        return false;
      }
      const stored = unquote(value) ?? '';
      if (!stored) {
        return false;
      }
      const existingAbsolute = resolveCviReferencePath(workspaceDirectory, stored);
      return path.normalize(existingAbsolute).toLowerCase() === expectedPath;
    });
    if (existing) {
      return Number(existing.key.match(/\d{4}/)?.[0] ?? '1');
    }

    const nextIndex = Number(header.get('Number of Projects') ?? '0') + 1;
    header.set('Number of Projects', String(nextIndex));
    header.set(`Project ${workspaceProjectSuffix(nextIndex)}`, quote(reference.storedPath));
    const currentActive = Number(header.get('Active Project') ?? '0');
    if (nextIndex === 1 || !Number.isInteger(currentActive) || currentActive < 1 || currentActive > nextIndex) {
      header.set('Active Project', '1');
    }
    const version = Number(header.get('Version') ?? '1200');
    ensureWorkspaceProjectSections(document, nextIndex, version);
    writeText(workspacePath, document.toString());
    return nextIndex;
  }

  removeProjectFromWorkspace(workspacePath: string, projectIndex: number): void {
    if (path.extname(workspacePath).toLowerCase() !== '.cws') {
      throw new Error('Cannot remove the only project from a standalone .prj view.');
    }
    const document = IniDocument.parse(readText(workspacePath));
    const header = document.getSection('Workspace Header');
    if (!header) {
      throw new Error('Invalid CVI workspace: missing [Workspace Header].');
    }

    const count = Number(header.get('Number of Projects') ?? '0');
    if (!Number.isInteger(projectIndex) || projectIndex < 1 || projectIndex > count) {
      throw new Error(`Invalid project index ${projectIndex}. Workspace contains ${count} project(s).`);
    }
    if (!(unquote(header.get(`Project ${workspaceProjectSuffix(projectIndex)}`)) ?? '').trim()) {
      throw new Error(`Cannot remove project ${projectIndex}: Project ${workspaceProjectSuffix(projectIndex)} is missing from [Workspace Header].`);
    }

    const currentActive = Number(header.get('Active Project') ?? '0');

    reindexWorkspaceHeaderProjects(header, projectIndex);
    reindexWorkspaceProjectSections(document, projectIndex);
    reindexWorkspaceFileMemberships(document, projectIndex);

    const nextCount = count - 1;
    header.set('Number of Projects', String(nextCount));
    let nextActive = 0;
    if (nextCount > 0) {
      if (currentActive === projectIndex) {
        nextActive = Math.min(projectIndex, nextCount);
      } else if (currentActive > projectIndex) {
        nextActive = currentActive - 1;
      } else if (currentActive >= 1) {
        nextActive = Math.min(currentActive, nextCount);
      } else {
        nextActive = 1;
      }
    }
    header.set('Active Project', String(nextActive));

    validateWorkspaceProjectIndexing(document);
    writeText(workspacePath, document.toString());
  }

  addFilesToProject(projectPath: string, filePaths: string[], folderOverride?: string): number {
    const snapshot = readTextForMutation(projectPath);
    const document = IniDocument.parse(snapshot.text);
    const header = document.getSection('Project Header');
    if (!header) {
      throw new Error('Invalid CVI project: missing [Project Header].');
    }

    const projectDirectory = path.dirname(projectPath);
    const existingFiles = this.parseProject(projectPath).files.map((file) => path.normalize(file.absolutePath).toLowerCase());
    const useFolderIds = projectUsesFolderIds(document);
    let nextId = document.sections
      .filter((section) => /^File \d{4}$/i.test(section.name))
      .map((section) => Number(section.name.match(/\d{4}/)?.[0] ?? '0'))
      .reduce((max, value) => Math.max(max, value), 0) + 1;
    let added = 0;

    for (const filePath of filePaths) {
      assertReadableRegularFile(filePath);
      const normalized = path.normalize(filePath).toLowerCase();
      if (existingFiles.includes(normalized)) {
        continue;
      }

      const fileType = fileTypeForPath(filePath);
      const folder = projectFolderForStorage(folderOverride?.trim() || defaultFolderForType(fileType));
      validateFlatLogicalFolder(folder);
      const reference = createCviPathReference(projectDirectory, filePath);
      const sectionName = `File ${String(nextId).padStart(4, '0')}`;
      const section = new IniSection(sectionName, []);
      section.set('File Type', quote(fileType));
      section.set('Res Id', String(nextId));
      section.set('Path Is Rel', reference.isRelative ? 'True' : 'False');
      if (reference.isRelative && reference.relativePath) {
        section.set('Path Rel To', quote('Project'));
        section.set('Path Rel Path', quote(reference.relativePath));
      }
      setPossiblyLongValue(section, 'Path', reference.absolutePath);
      section.set('Exclude', 'False');
      if (fileType === 'CSource') {
        section.set('Compile Into Object File', 'False');
      }
      section.set('Project Flags', '0');
      section.set('Folder', quote(folder));
      const folderId = this.ensureProjectFolder(document, folder);
      if (useFolderIds && folderId !== undefined) {
        section.set('Folder Id', String(folderId));
      }
      section.lines.push('');
      addProjectFileSection(document, section);
      existingFiles.push(normalized);
      nextId += 1;
      added += 1;
    }

    header.set('Number of Files', String(document.sections.filter((section) => /^File \d{4}$/i.test(section.name)).length));
    writeText(projectPath, document.toString(), snapshot.buffer);
    return added;
  }

  removeFileFromProject(projectPath: string, sectionName: string): void {
    const snapshot = readTextForMutation(projectPath);
    const document = IniDocument.parse(snapshot.text);
    const header = document.getSection('Project Header');
    if (!header) {
      throw new Error('Invalid CVI project: missing [Project Header].');
    }
    if (!document.getSection(sectionName)) {
      return;
    }
    document.removeSection(sectionName);
    updateProjectFileCount(document);
    writeText(projectPath, document.toString(), snapshot.buffer);
  }


  addFolderToProject(projectPath: string, folder: string): void {
    const normalizedFolder = normalizeLogicalFolder(folder);
    if (!normalizedFolder) {
      throw new Error('A non-empty CVI logical folder name is required.');
    }
    validateFlatLogicalFolder(normalizedFolder);
    const snapshot = readTextForMutation(projectPath);
    const document = IniDocument.parse(snapshot.text);
    this.ensureProjectFolder(document, normalizedFolder);
    writeText(projectPath, document.toString(), snapshot.buffer);
  }

  renameFolderInProject(projectPath: string, oldFolder: string, newFolder: string): void {
    const oldNormalized = normalizeLogicalFolder(oldFolder);
    const newNormalized = normalizeLogicalFolder(newFolder);
    if (!oldNormalized || !newNormalized) {
      throw new Error('Both CVI logical folder names are required.');
    }
    if (oldNormalized.toLowerCase() === newNormalized.toLowerCase()) {
      return;
    }

    validateFlatLogicalFolder(newNormalized);
    const snapshot = readTextForMutation(projectPath);
    const document = IniDocument.parse(snapshot.text);
    const useFolderIds = projectUsesFolderIds(document);
    const folderId = this.ensureProjectFolder(document, newNormalized);
    for (const section of document.sections.filter((candidate) => /^File \d{4}$/i.test(candidate.name))) {
      const current = projectFolderForUi(unquote(section.get('Folder')) ?? '');
      if (current.toLowerCase() === oldNormalized.toLowerCase()) {
        section.set('Folder', quote(projectFolderForStorage(newNormalized)));
        if (useFolderIds && folderId !== undefined) section.set('Folder Id', String(folderId));
        else section.delete('Folder Id');
      }
    }

    this.rewriteDeclaredFolders(document, (folder) => folder.toLowerCase() === oldNormalized.toLowerCase() ? newNormalized : folder);
    writeText(projectPath, document.toString(), snapshot.buffer);
  }

  removeFolderFromProject(projectPath: string, folder: string, removeFileReferences: boolean): void {
    const normalized = normalizeLogicalFolder(folder);
    if (!normalized) {
      throw new Error('A CVI logical folder name is required.');
    }

    const snapshot = readTextForMutation(projectPath);
    const document = IniDocument.parse(snapshot.text);
    for (const section of [...document.sections].filter((candidate) => /^File \d{4}$/i.test(candidate.name))) {
      const current = projectFolderForUi(unquote(section.get('Folder')) ?? '');
      if (current.toLowerCase() !== normalized.toLowerCase()) {
        continue;
      }
      if (removeFileReferences) {
        document.removeSection(section.name);
      } else {
        section.set('Folder', quote(CVI_ROOT_FOLDER));
        section.delete('Folder Id');
      }
    }

    this.rewriteDeclaredFolders(document, (declared) => declared.toLowerCase() === normalized.toLowerCase() ? undefined : declared);

    updateProjectFileCount(document);
    writeText(projectPath, document.toString(), snapshot.buffer);
  }

  setFileExcluded(projectPath: string, sectionName: string, excluded: boolean): void {
    const section = this.requireProjectFileSection(projectPath, sectionName);
    const fileType = unquote(section.section.get('File Type')) ?? 'Unknown';
    const resolved = resolveProjectFilePath(projectPath, section.section);
    if (!excludeEligibleFileType(fileType, resolved.absolutePath)) {
      throw new Error(`Exclude File from Build is not applicable to ${fileType} files (${path.basename(resolved.absolutePath)}). CVI excludes build modules such as C sources, libraries, DLLs or object files; headers, function panels and UIR files remain project resources.`);
    }
    section.section.set('Exclude', excluded ? 'True' : 'False');
    writeText(projectPath, section.document.toString(), section.originalBuffer);
  }

  setCompileIntoObjectFile(projectPath: string, sectionName: string, enabled: boolean): void {
    const section = this.requireProjectFileSection(projectPath, sectionName);
    const fileType = unquote(section.section.get('File Type')) ?? 'Unknown';
    if (fileType !== 'CSource') {
      throw new Error('The .Obj option is available only for C source files.');
    }
    section.section.set('Compile Into Object File', enabled ? 'True' : 'False');
    writeText(projectPath, section.document.toString(), section.originalBuffer);
  }

  replaceFileInProject(projectPath: string, sectionName: string, replacementPath: string): void {
    assertReadableRegularFile(replacementPath);
    const { document, section, originalBuffer } = this.requireProjectFileSection(projectPath, sectionName);
    const projectDirectory = path.dirname(projectPath);
    const replacementComparable = normalizeComparablePath(replacementPath);
    const duplicate = document.sections.find((candidate) => /^File \d{4}$/i.test(candidate.name)
      && candidate.name.toLowerCase() !== section.name.toLowerCase()
      && normalizeComparablePath(resolveProjectFilePath(projectPath, candidate).absolutePath) === replacementComparable);
    if (duplicate) {
      throw new Error(`Cannot replace ${section.name}: ${replacementPath} is already referenced by ${duplicate.name}.`);
    }
    const fileType = fileTypeForPath(replacementPath);
    const reference = createCviPathReference(projectDirectory, replacementPath);
    section.set('File Type', quote(fileType));
    section.set('Path Is Rel', reference.isRelative ? 'True' : 'False');
    section.delete('Path Rel To');
    section.delete('Path Rel Path');
    if (reference.isRelative && reference.relativePath) {
      section.set('Path Rel To', quote('Project'));
      section.set('Path Rel Path', quote(reference.relativePath));
    }
    setPossiblyLongValue(section, 'Path', reference.absolutePath);
    if (fileType === 'CSource') {
      if (!section.has('Compile Into Object File')) {
        section.set('Compile Into Object File', 'False');
      }
    } else {
      section.delete('Compile Into Object File');
    }
    writeText(projectPath, document.toString(), originalBuffer);
  }

  moveFilesToFolderInProject(projectPath: string, sectionNames: string[], folder: string): number {
    const normalizedFolder = normalizeLogicalFolder(folder);
    validateFlatLogicalFolder(normalizedFolder);
    const storedFolder = projectFolderForStorage(normalizedFolder);
    const sectionNameSet = new Set(sectionNames.map((name) => name.trim()).filter(Boolean));
    if (sectionNameSet.size === 0) {
      return 0;
    }

    const snapshot = readTextForMutation(projectPath);
    const document = IniDocument.parse(snapshot.text);
    const useFolderIds = projectUsesFolderIds(document);
    let moved = 0;
    for (const section of document.sections.filter((candidate) => /^File \d{4}$/i.test(candidate.name))) {
      if (!sectionNameSet.has(section.name)) {
        continue;
      }
      const currentFolder = projectFolderForUi(unquote(section.get('Folder')) ?? '');
      if (currentFolder.toLowerCase() === normalizedFolder.toLowerCase()) {
        continue;
      }
      section.set('Folder', quote(storedFolder));
      const folderId = this.ensureProjectFolder(document, storedFolder);
      if (useFolderIds && folderId !== undefined) section.set('Folder Id', String(folderId));
      else section.delete('Folder Id');
      moved += 1;
    }

    if (moved > 0) {
      writeText(projectPath, document.toString(), snapshot.buffer);
    }
    return moved;
  }

  synchronizeWorkspaceBreakpoints(
    workspacePath: string,
    projectIndex: number,
    projectPath: string,
    requestedBreakpoints: CviWorkspaceBreakpoint[],
    previouslyTrackedBreakpoints: CviWorkspaceBreakpoint[] = [],
    preserveNativeBreakpoints = false
  ): CviWorkspaceBreakpointSyncResult {
    if (path.extname(workspacePath).toLowerCase() !== '.cws') {
      throw new Error('Native CVI breakpoint synchronization requires an opened .cws workspace.');
    }
    const snapshot = readTextForMutation(workspacePath);
    const document = IniDocument.parse(snapshot.text);
    const header = document.getSection('Workspace Header');
    if (!header) {
      throw new Error('Invalid CVI workspace: missing [Workspace Header].');
    }
    const projectCount = Number(header.get('Number of Projects') ?? '0');
    if (projectIndex < 1 || projectIndex > projectCount || !header.has(`Project ${workspaceProjectSuffix(projectIndex)}`)) {
      throw new Error(`Refusing to synchronize CVI breakpoints: project ${projectIndex} is not declared in the workspace.`);
    }

    const project = this.parseProject(projectPath);
    const projectFiles = new Map(project.files
      .filter(isBreakpointCompatibleProjectFile)
      .map((file) => [normalizeComparablePath(file.absolutePath), file]));
    const previousByFile = new Map<string, Set<number>>();
    for (const breakpoint of previouslyTrackedBreakpoints) {
      const key = normalizeComparablePath(breakpoint.filePath);
      if (!key || !projectFiles.has(key) || !Number.isInteger(breakpoint.line) || breakpoint.line < 1) {
        continue;
      }
      const lines = previousByFile.get(key) ?? new Set<number>();
      lines.add(breakpoint.line);
      previousByFile.set(key, lines);
    }

    const requestedByFile = new Map<string, Set<number>>();
    const ignoredBreakpoints: CviWorkspaceBreakpoint[] = [];
    for (const breakpoint of requestedBreakpoints) {
      const key = normalizeComparablePath(breakpoint.filePath);
      if (!key || !projectFiles.has(key) || !Number.isInteger(breakpoint.line) || breakpoint.line < 1) {
        ignoredBreakpoints.push(breakpoint);
        continue;
      }
      const lines = requestedByFile.get(key) ?? new Set<number>();
      lines.add(breakpoint.line);
      requestedByFile.set(key, lines);
    }

    const sectionsByPath = new Map<string, IniSection>();
    for (const section of document.sections.filter((candidate) => /^File \d{4}$/i.test(candidate.name))) {
      const sectionPath = readWorkspaceFilePath(section);
      if (sectionPath) {
        sectionsByPath.set(normalizeComparablePath(sectionPath), section);
      }
    }

    const changedSections = new Set<string>();
    const createdWorkspaceFileSections: string[] = [];
    const trackedBreakpoints: CviWorkspaceBreakpoint[] = [];
    let appliedCount = 0;
    let preservedNativeCount = 0;
    let removedTrackedCount = 0;
    let removedNativeCount = 0;

    for (const [fileKey, projectFile] of projectFiles) {
      const requestedLines = requestedByFile.get(fileKey) ?? new Set<number>();
      const previousLines = previousByFile.get(fileKey) ?? new Set<number>();
      let section = sectionsByPath.get(fileKey);
      if (!section && requestedLines.size === 0) {
        continue;
      }
      if (!section) {
        const ensured = ensureWorkspaceFileSection(document, header, projectIndex, projectFile);
        section = ensured.section;
        sectionsByPath.set(fileKey, section);
        if (ensured.created) {
          createdWorkspaceFileSections.push(section.name);
        }
      }

      const existing = readWorkspaceBreakpoints(section);
      const target = new Map<number, string>();
      if (preserveNativeBreakpoints) {
        for (const [line, value] of existing) {
          if (!previousLines.has(line)) {
            target.set(line, value);
            preservedNativeCount += 1;
          } else if (!requestedLines.has(line)) {
            removedTrackedCount += 1;
          }
        }
      } else {
        // Mirror mode is intentionally exact: native breakpoints for files in
        // the active project are replaced by the enabled standard VS Code
        // breakpoints. Tracepoints are stored separately and remain intact.
        for (const line of existing.keys()) {
          if (!requestedLines.has(line)) removedNativeCount += 1;
        }
        for (const line of previousLines) {
          if (!requestedLines.has(line)) removedTrackedCount += 1;
        }
      }

      for (const line of requestedLines) {
        appliedCount += 1;
        target.set(line, quote(`${line},0,enabled,`));
        trackedBreakpoints.push({ filePath: projectFile.absolutePath, line });
      }

      const before = section.lines.join('\n');
      replaceWorkspaceBreakpoints(section, target);
      if (section.lines.join('\n') !== before) {
        changedSections.add(section.name);
      }
    }

    if (createdWorkspaceFileSections.length > 0 || changedSections.size > 0) {
      writeText(workspacePath, document.toString(), snapshot.buffer);
    }
    return {
      changed: createdWorkspaceFileSections.length > 0 || changedSections.size > 0,
      requestedCount: requestedBreakpoints.length,
      appliedCount,
      preservedNativeCount,
      removedTrackedCount,
      removedNativeCount,
      createdWorkspaceFileSections,
      ignoredBreakpoints,
      trackedBreakpoints
    };
  }

  inspectProjectCompatibility(projectPath: string): string[] {
    if (!fs.existsSync(projectPath)) return [`Project file does not exist: ${projectPath}`];
    const document = IniDocument.parse(readText(projectPath));
    const issues: string[] = [];
    const header = document.getSection('Project Header');
    if (!header) return ['Missing [Project Header].'];

    // Keep this inspection deliberately conservative. Real CVI files (including files
    // produced by different CVI generations) legitimately contain stale
    // Number of Files values, gaps in File NNNN identifiers, arbitrary physical
    // section ordering, folders without Folder Id and unavailable external paths.
    // None of those conditions is a structural corruption by itself.
    const duplicateNames = duplicateSectionNames(document);
    for (const duplicate of duplicateNames) {
      if (/^File \d{4}$/i.test(duplicate)) {
        issues.push(`Duplicate file section name [${duplicate}] makes that project entry ambiguous.`);
      }
    }

    const fileSections = document.sections.filter((candidate) => /^File \d{4}$/i.test(candidate.name));
    for (const section of fileSections) {
      const sectionId = Number(section.name.match(/(\d{4})$/)?.[1] ?? '0');
      const resIdRaw = section.get('Res Id');
      if (resIdRaw !== undefined) {
        const resId = Number(resIdRaw);
        if (Number.isFinite(resId) && resId !== sectionId) {
          issues.push(`[${section.name}] Res Id=${resId}; expected ${sectionId} to match the native section identifier.`);
        }
      }
    }
    return [...new Set(issues)];
  }

  repairProjectCompatibility(projectPath: string): { changed: boolean; changes: string[] } {
    const snapshot = readTextForMutation(projectPath);
    const document = IniDocument.parse(snapshot.text);
    const header = document.getSection('Project Header');
    if (!header) throw new Error('Invalid CVI project: missing [Project Header].');
    const changes: string[] = [];

    // Repair only invariants for which the native meaning is unambiguous. Do not
    // normalize file numbering/order, Number of Files, paths, folder layout, Folder Id,
    // File Type, or duplicate physical references: CVI itself accepts several legacy
    // representations of those fields and rewriting them can damage a working project.
    for (const section of document.sections.filter((candidate) => /^File \d{4}$/i.test(candidate.name))) {
      const sectionId = Number(section.name.match(/(\d{4})$/)?.[1] ?? '0');
      const resIdRaw = section.get('Res Id');
      if (sectionId > 0 && resIdRaw !== undefined) {
        const resId = Number(resIdRaw);
        if (Number.isFinite(resId) && resId !== sectionId) {
          section.set('Res Id', String(sectionId));
          changes.push(`[${section.name}] Res Id ${resId} -> ${sectionId}.`);
        }
      }
    }

    if (changes.length > 0) writeText(projectPath, document.toString(), snapshot.buffer);
    return { changed: changes.length > 0, changes };
  }

  createWorkspace(rootDirectory: string, workspaceName: string, cviDir: string | undefined, formatVersion: number): string {
    fs.mkdirSync(rootDirectory, { recursive: true });
    const workspacePath = path.join(rootDirectory, `${workspaceName}.cws`);
    if (fs.existsSync(workspacePath)) {
      throw new Error(`The CVI workspace already exists: ${workspacePath}`);
    }
    writeText(workspacePath, this.createMinimalWorkspaceText(workspacePath, undefined, cviDir, formatVersion));
    return workspacePath;
  }

  createWorkspaceAndProject(rootDirectory: string, workspaceName: string, projectName: string, targetType: string, cviDir: string | undefined, formatVersion: number): { workspacePath: string; projectPath: string } {
    fs.mkdirSync(rootDirectory, { recursive: true });
    const projectPath = path.join(rootDirectory, `${projectName}.prj`);
    const workspacePath = path.join(rootDirectory, `${workspaceName}.cws`);
    if (fs.existsSync(projectPath) || fs.existsSync(workspacePath)) {
      throw new Error('The target workspace or project file already exists.');
    }

    writeText(projectPath, this.createMinimalProjectText(projectPath, projectName, targetType, cviDir, formatVersion));
    writeText(workspacePath, this.createMinimalWorkspaceText(workspacePath, path.basename(projectPath), cviDir, formatVersion));
    return { workspacePath, projectPath };
  }

  createProject(projectDirectory: string, projectName: string, targetType: string, cviDir: string | undefined, formatVersion: number): string {
    fs.mkdirSync(projectDirectory, { recursive: true });
    const projectPath = path.join(projectDirectory, `${projectName}.prj`);
    if (fs.existsSync(projectPath)) {
      throw new Error(`The CVI project already exists: ${projectPath}`);
    }
    writeText(projectPath, this.createMinimalProjectText(projectPath, projectName, targetType, cviDir, formatVersion));
    return projectPath;
  }

  private ensureProjectFolder(document: IniDocument, folder: string): number | undefined {
    const normalized = projectFolderForUi(folder);
    if (!normalized) {
      return undefined;
    }
    validateFlatLogicalFolder(normalized);
    const folders = document.ensureSection('Folders', 'Custom Build Configs');
    const entries = folders.entries().filter(({ key }) => /^Folder \d+$/i.test(key));
    const existing = entries.find(({ value }) => projectFolderForUi(unquote(value) ?? '').toLowerCase() === normalized.toLowerCase());
    if (existing) {
      const id = Number(existing.key.match(/\d+$/)?.[0] ?? '0');
      if (!folders.has(`FolderEx ${id}`)) folders.set(`FolderEx ${id}`, quote(normalized));
      return id;
    }
    const usedIds = entries.map(({ key }) => Number(key.match(/\d+$/)?.[0] ?? '0'));
    const id = usedIds.length > 0 ? Math.max(...usedIds) + 1 : 0;
    folders.set(`Folder ${id}`, quote(normalized));
    folders.set(`FolderEx ${id}`, quote(normalized));
    return id;
  }


  private requireProjectFileSection(projectPath: string, sectionName: string): { document: IniDocument; section: IniSection; originalBuffer: Buffer } {
    const snapshot = readTextForMutation(projectPath);
    const document = IniDocument.parse(snapshot.text);
    const section = document.getSection(sectionName);
    if (!section || !/^File \d{4}$/i.test(section.name)) {
      throw new Error(`CVI project file entry not found: ${sectionName}`);
    }
    return { document, section, originalBuffer: snapshot.buffer };
  }

  private rewriteDeclaredFolders(document: IniDocument, mapFolder: (folder: string) => string | undefined): void {
    const folders = document.ensureSection('Folders', 'Custom Build Configs');
    const preserved = folders.entries().filter(({ key }) => !/^Folder(?:Ex)? \d+$/i.test(key));
    const mapped = folders.entries()
      .filter(({ key }) => /^Folder \d+$/i.test(key))
      .map(({ value }) => mapFolder(projectFolderForUi(unquote(value) ?? '')))
      .filter((folder): folder is string => Boolean(folder))
      .map((folder) => normalizeLogicalFolder(folder))
      .filter((folder) => Boolean(folder) && folder.toLowerCase() !== CVI_ROOT_FOLDER.toLowerCase())
      .filter((folder, index, all) => all.findIndex((candidate) => candidate.toLowerCase() === folder.toLowerCase()) === index);
    folders.lines = preserved.map(({ key, value }) => `${key} = ${value}`);
    mapped.forEach((folder, index) => {
      folders.set(`Folder ${index}`, quote(folder));
      folders.set(`FolderEx ${index}`, quote(folder));
    });
    folders.lines.push('');
  }

  private createMinimalWorkspaceText(workspacePath: string, projectFileName: string | undefined, cviDir: string | undefined, version: number): string {
    const document = new IniDocument();
    const header = new IniSection('Workspace Header', []);
    header.set('Version', String(version));
    setPossiblyLongValue(header, 'Pathname', workspacePath);
    if (cviDir) {
      setPossiblyLongValue(header, 'CVI Dir', cviDir);
    }
    const hasProject = Boolean(projectFileName);
    header.set('Number of Projects', hasProject ? '1' : '0');
    header.set('Active Project', hasProject ? '1' : '0');
    if (projectFileName) {
      header.set('Project 0001', quote(projectFileName));
    }
    header.set('Save Changes Before Running', quote('Always'));
    header.set('Save Changes Before Compiling', quote('Always'));
    header.set('Sort Type', quote('File Name'));
    header.lines.push('');
    document.addSection(header);

    if (hasProject) {
      ensureWorkspaceProjectSections(document, 1, version);
    }
    return document.toString();
  }

  private createMinimalProjectText(projectPath: string, projectName: string, targetType: string, cviDir: string | undefined, version: number): string {
    const document = new IniDocument();
    const header = new IniSection('Project Header', []);
    header.set('Version', String(version));
    setPossiblyLongValue(header, 'Pathname', projectPath);
    if (cviDir) {
      setPossiblyLongValue(header, 'CVI Dir', cviDir);
    }
    header.set('Number of Files', '0');
    header.set('Target Type', quote(targetType));
    header.set('Flags', targetType === 'Executable' ? '2064' : '0');
    header.set('Copied From Locked InstrDrv Directory', 'False');
    header.set('Copied from VXIPNP Directory', 'False');
    header.set('Locked InstrDrv Name', quote(''));
    header.set("Don't Display Deploy InstrDrv Dialog", 'False');
    header.lines.push('');
    document.addSection(header);

    const folders = new IniSection('Folders', []);
    folders.set('Instrument Files Folder Not Added Yet', 'True');
    folders.set('Library Files Folder Not Added Yet', 'True');
    folders.lines.push('');
    document.addSection(folders);

    const custom = new IniSection('Custom Build Configs', []);
    custom.set('Num Custom Build Configs', '0');
    custom.lines.push('');
    document.addSection(custom);

    for (const mode of ['Debug', 'Release', 'Debug64', 'Release64']) {
      const config = new IniSection(`Default Build Config ${mode}`, []);
      config.set('Config Name', quote(mode));
      config.set('Is 64-Bit', mode.endsWith('64') ? 'True' : 'False');
      config.set('Is Release', mode.startsWith('Release') ? 'True' : 'False');
      config.set('Default Calling Convention', quote('cdecl'));
      config.set('Require Prototypes', 'True');
      config.set('Require Return Values', 'True');
      config.set('Enable C99 Extensions', 'True');
      config.set('Stack Size', '250000');
      config.set('Runtime Support', quote('Full Runtime Support'));
      config.set('Runtime Binding', quote('Shared'));
      config.lines.push('');
      document.addSection(config);
    }

    const createExecutable = new IniSection('Create Executable', []);
    const extension = targetType === 'Dynamic Link Library' ? '.dll' : targetType === 'Static Library' ? '.lib' : '.exe';
    for (const mode of ['Debug', 'Release', 'Debug64', 'Release64']) {
      createExecutable.set(`Executable File_${mode} Is Rel`, 'True');
      createExecutable.set(`Executable File_${mode} Rel To`, quote('Project'));
      createExecutable.set(`Executable File_${mode} Rel Path`, quote(`${projectName}${extension}`));
      setPossiblyLongValue(createExecutable, `Executable File_${mode}`, path.join(path.dirname(projectPath), `${projectName}${extension}`));
    }
    createExecutable.set('Runtime Support', quote('Full Runtime Support'));
    createExecutable.lines.push('');
    document.addSection(createExecutable);

    for (const name of ['Compiler Options', 'Run Options', 'Compiler Defines', 'External Compiler Support', 'ActiveX Server Options', 'Signing Info', 'Manifest Info', 'tpcSection']) {
      document.addSection(new IniSection(name, ['']));
    }
    return document.toString();
  }
}
