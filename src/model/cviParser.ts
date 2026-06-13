import * as fs from 'fs';
import * as path from 'path';
import { IniDocument, IniSection } from './iniDocument';
import { CviBuildMode, CviProject, CviProjectFile, CviRunOptions, CviWorkspace, CviWorkspaceProjectRef } from './types';
import { fromCviPath, normalizeRelativePath, quote, splitCviLongValue, toCviPath, toCviRuntimeStoragePath, unquote } from '../utils/pathUtils';


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

function readText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function writeText(filePath: string, content: string): void {
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined;
  if (current === content) {
    return;
  }
  validateNativeDocument(filePath, content);
  if (current !== undefined && isNativeCviDocument(filePath)) {
    createNativeBackup(filePath, current);
  }
  const temporaryPath = `${filePath}.vscode-cvi-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, content, 'utf8');
  try {
    fs.copyFileSync(temporaryPath, filePath);
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
  const requiredSection = path.extname(filePath).toLowerCase() === '.cws' ? 'Workspace Header' : 'Project Header';
  if (!document.getSection(requiredSection)) {
    throw new Error(`Refusing to overwrite ${path.basename(filePath)}: generated content is missing [${requiredSection}].`);
  }
}

function createNativeBackup(filePath: string, content: string): string {
  const backupDirectory = path.join(path.dirname(filePath), '.vscode', 'cvi-native-backups');
  fs.mkdirSync(backupDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDirectory, `${path.basename(filePath)}.${stamp}.bak`);
  fs.writeFileSync(backupPath, content, 'utf8');
  const prefix = `${path.basename(filePath)}.`;
  const backups = fs.readdirSync(backupDirectory)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.bak'))
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
  const absolutePath = path.isAbsolute(trimmed) ? trimmed : path.resolve(projectDirectory, trimmed);
  const relativePath = normalizeRelativePath(projectDirectory, absolutePath);
  section.set(`${key} Is Rel`, 'True');
  section.set(`${key} Rel To`, quote('Project'));
  setPossiblyLongStringValue(section, `${key} Rel Path`, relativePath);
  setPossiblyLongValue(section, key, absolutePath);
}

function setOutputPath(section: IniSection, mode: CviBuildMode, projectPath: string, value: string): void {
  const suffix = modeSuffix(mode);
  const key = `Executable File_${suffix}`;
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('The target output path cannot be empty.');
  }
  const projectDirectory = path.dirname(projectPath);
  const absolutePath = path.isAbsolute(trimmed) ? trimmed : path.resolve(projectDirectory, trimmed);
  section.set(`${key} Is Rel`, 'True');
  section.set(`${key} Rel To`, quote('Project'));
  setPossiblyLongStringValue(section, `${key} Rel Path`, normalizeRelativePath(projectDirectory, absolutePath));
  setPossiblyLongValue(section, key, absolutePath);
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
    default: return 'Other';
  }
}

export function defaultFolderForType(fileType: string): string {
  switch (fileType) {
    case 'CSource': return 'Source Files';
    case 'Include': return 'Include Files';
    case 'User Interface Resource': return 'User Interface Files';
    case 'Function Panel': return 'Instrument Files';
    case 'Library': return 'Library Files';
    default: return 'Other Files';
  }
}

function resolveProjectFilePath(projectPath: string, section: IniSection): { absolutePath: string; relativePath?: string } {
  const projectDirectory = path.dirname(projectPath);
  const relativePath = unquote(section.get('Path Rel Path'));
  const isRelative = parseBoolean(section.get('Path Is Rel'), relativePath !== undefined);
  const relativeTo = unquote(section.get('Path Rel To'))?.toLowerCase();

  if (relativePath && isRelative && (!relativeTo || relativeTo === 'project')) {
    return { absolutePath: path.resolve(projectDirectory, relativePath), relativePath };
  }

  const absoluteValue = reconstructValue(section, 'Path');
  if (absoluteValue) {
    return { absolutePath: fromCviPath(absoluteValue), relativePath };
  }

  if (relativePath) {
    return { absolutePath: path.resolve(projectDirectory, relativePath), relativePath };
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



function replaceExtension(filePath: string, extension: string): string {
  return path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}${extension}`);
}

function normalizeLogicalFolder(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/').trim();
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
  return projectFileType || 'Other';
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
  header.set('Number of Opened Files', String(document.sections.filter((candidate) => /^File \d{4}$/i.test(candidate.name)).length));
  return { section, created: true };
}

export class CviParser {
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
      const relativePath = unquote(header.get(key));
      if (!relativePath) {
        continue;
      }
      const absolutePath = path.resolve(workspaceDirectory, relativePath);
      projects.push({
        index,
        relativePath,
        absolutePath,
        name: path.basename(absolutePath, path.extname(absolutePath)),
        exists: fs.existsSync(absolutePath)
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
        return {
          sectionName: section.name,
          id,
          type: unquote(section.get('File Type')) ?? 'Other',
          folder: unquote(section.get('Folder')) ?? defaultFolderForType(unquote(section.get('File Type')) ?? 'Other'),
          relativePath: resolved.relativePath,
          absolutePath: resolved.absolutePath,
          excluded: parseBoolean(section.get('Exclude')),
          compileIntoObjectFile: parseBoolean(section.get('Compile Into Object File')),
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


  getNativeTargetSettings(projectPath: string, mode: CviBuildMode): CviNativeTargetSettings {
    const document = IniDocument.parse(readText(projectPath));
    const header = document.getSection('Project Header');
    if (!header) {
      throw new Error('Invalid CVI project: missing [Project Header].');
    }
    const config = getProjectModeSection(document, mode);
    const createExecutable = document.getSection('Create Executable') ?? new IniSection('Create Executable', []);
    const modules = document.getSection('Modules Forced Into Executable');
    const signing = document.getSection('Signing Info') ?? new IniSection('Signing Info', []);
    const versionValue = (key: string): string => unquote(config.get(`${key} Ex`)) ?? unquote(config.get(key)) ?? '';
    const outputKey = `Executable File_${modeSuffix(mode)}`;
    return {
      targetType: unquote(header.get('Target Type')) ?? 'Executable',
      outputPath: resolveStoredPath(createExecutable, outputKey),
      applicationTitle: unquote(config.get('Application Title')) ?? '',
      iconFile: resolveStoredPath(config, 'Icon File'),
      runtimeSupport: unquote(config.get('Runtime Support')) ?? 'Full Runtime Support',
      runtimeBinding: unquote(config.get('Runtime Binding')) ?? 'Shared',
      generateSourceDocumentation: unquote(config.get('Generate Source Documentation')) ?? 'None',
      manifestEmbed: parseBoolean(config.get('Manifest Embed')),
      manifestPath: resolveStoredPath(config, 'Manifest Path'),
      embedProjectUirs: parseBoolean(config.get('Embed Project .UIRs')),
      generateMapFile: parseBoolean(config.get('Generate Map File')),
      createConsoleApplication: parseBoolean(config.get('Create Console Application')),
      embedTimestamp: parseBoolean(config.get('Embed Timestamp'), true),
      usingLoadExternalModule: parseBoolean(config.get('Using LoadExternalModule')),
      forcedModules: parseStringList(modules, /^Module \d{4}$/i),
      useDefaultImportLibBaseName: parseBoolean(config.get('Use Dflt Import Lib Base Name'), true),
      importLibBaseName: unquote(config.get('Import Lib Base Name')) ?? '',
      whereToCopyDll: unquote(config.get('Where to Copy DLL')) ?? 'Do not copy',
      customDirectoryToCopyDll: resolveStoredPath(config, 'Custom Directory to Copy DLL'),
      useIviSubdirectoriesForImportLibraries: parseBoolean(config.get('Use IVI Subdirectories for Import Libraries')),
      useVxiPnpSubdirectoriesForImportLibraries: parseBoolean(config.get('Use VXIPNP Subdirectories for Import Libraries')),
      dllExports: unquote(config.get('DLL Exports')) ?? 'Include File Symbols',
      exportFiles: parseStringList(config, /^Export File\d+$/i),
      addTypeLibToDll: parseBoolean(config.get('Add Type Lib To DLL')),
      includeTypeLibHelpLinks: parseBoolean(config.get('Include Type Lib Help Links')),
      tlbHelpStyle: unquote(config.get('TLB Help Style')) ?? 'HLP',
      typeLibFpFile: resolveStoredPath(config, 'Type Lib FP File'),
      addNiTypeInfoToDll: parseBoolean(config.get('Add NI Type Info To DLL')),
      useSingleHeaderForNiTypeInfo: parseBoolean(config.get('Use Single Header for NI Type Info')),
      singleHeaderNiTypeInfoFile: resolveStoredPath(config, 'Single Header NI Type Info File'),
      versionInfo: {
        numericFileVersion: unquote(config.get('Numeric File Version')) ?? '1,0,0,0',
        numericProductVersion: unquote(config.get('Numeric Prod Version')) ?? '1,0,0,0',
        comments: versionValue('Comments'),
        companyName: versionValue('Company Name'),
        fileDescription: versionValue('File Description'),
        fileVersion: versionValue('File Version'),
        internalName: versionValue('Internal Name'),
        legalCopyright: versionValue('Legal Copyright'),
        legalTrademarks: versionValue('Legal Trademarks'),
        originalFilename: versionValue('Original Filename'),
        privateBuild: versionValue('Private Build'),
        productName: versionValue('Product Name'),
        productVersion: versionValue('Product Version'),
        specialBuild: versionValue('Special Build')
      },
      signing: {
        enabled: parseBoolean(config.get('Sign')),
        store: unquote(config.get('Sign Store')) ?? '',
        certificate: unquote(config.get('Sign Certificate')) ?? '',
        timestampUrl: unquote(config.get('Sign Timestamp URL')) ?? '',
        descriptionUrl: unquote(config.get('Sign URL')) ?? '',
        signDebugBuild: parseBoolean(signing.get('Sign Debug Build'))
      }
    };
  }

  setNativeTargetSettings(projectPath: string, mode: CviBuildMode, settings: CviNativeTargetSettings): void {
    const document = IniDocument.parse(readText(projectPath));
    const header = document.getSection('Project Header');
    if (!header) {
      throw new Error('Invalid CVI project: missing [Project Header].');
    }
    const config = getProjectModeSection(document, mode);
    const createExecutable = document.ensureSection('Create Executable');
    const signing = document.ensureSection('Signing Info');
    setOutputPath(createExecutable, mode, projectPath, settings.outputPath);
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
    if (settings.forcedModules.filter((value) => value.trim()).length === 0) {
      document.removeSection('Modules Forced Into Executable');
    }
    setBoolean(config, 'Use Dflt Import Lib Base Name', settings.useDefaultImportLibBaseName);
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
      ['Comments', settings.versionInfo.comments],
      ['Company Name', settings.versionInfo.companyName],
      ['File Description', settings.versionInfo.fileDescription],
      ['File Version', settings.versionInfo.fileVersion],
      ['Internal Name', settings.versionInfo.internalName],
      ['Legal Copyright', settings.versionInfo.legalCopyright],
      ['Legal Trademarks', settings.versionInfo.legalTrademarks],
      ['Original Filename', settings.versionInfo.originalFilename],
      ['Private Build', settings.versionInfo.privateBuild],
      ['Product Name', settings.versionInfo.productName],
      ['Product Version', settings.versionInfo.productVersion],
      ['Special Build', settings.versionInfo.specialBuild]
    ];
    config.set('Numeric File Version', quote(settings.versionInfo.numericFileVersion));
    config.set('Numeric Prod Version', quote(settings.versionInfo.numericProductVersion));
    versionPairs.forEach(([key, value]) => {
      config.set(key, quote(value));
      config.set(`${key} Ex`, quote(value));
    });
    setBoolean(config, 'Sign', settings.signing.enabled);
    config.set('Sign Store', quote(settings.signing.store));
    config.set('Sign Certificate', quote(settings.signing.certificate));
    config.set('Sign Timestamp URL', quote(settings.signing.timestampUrl));
    config.set('Sign URL', quote(settings.signing.descriptionUrl));
    setBoolean(signing, 'Sign Debug Build', settings.signing.signDebugBuild);
    writeText(projectPath, document.toString());
  }

  getTargetPath(projectPath: string, mode: CviBuildMode): string | undefined {
    const document = IniDocument.parse(readText(projectPath));
    const section = document.getSection('Create Executable');
    if (!section) {
      return undefined;
    }

    const suffix = modeSuffix(mode);
    const relativePath = unquote(section.get(`Executable File_${suffix} Rel Path`));
    if (relativePath) {
      return path.resolve(path.dirname(projectPath), relativePath);
    }

    const absolute = reconstructValue(section, `Executable File_${suffix}`);
    return absolute ? fromCviPath(absolute) : undefined;
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
    const document = IniDocument.parse(readText(workspacePath));
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
    writeText(workspacePath, document.toString());
  }

  inspectWorkspaceCompatibility(workspacePath: string): string[] {
    if (path.extname(workspacePath).toLowerCase() !== '.cws' || !fs.existsSync(workspacePath)) {
      return [];
    }
    const document = IniDocument.parse(readText(workspacePath));
    const issues: string[] = [];
    const header = document.getSection('Workspace Header');
    const version = Number(header?.get('Version') ?? '1200');
    const projectCount = Number(header?.get('Number of Projects') ?? '0');
    for (let projectIndex = 1; projectIndex <= projectCount; projectIndex += 1) {
      for (const sectionName of requiredWorkspaceProjectSectionNames(document, projectIndex, version)) {
        if (!document.getSection(sectionName)) {
          issues.push(`[${sectionName}] is missing for workspace project ${workspaceProjectSuffix(projectIndex)}.`);
        }
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
    return issues;
  }

  repairWorkspaceCompatibility(workspacePath: string): { changed: boolean; changes: string[] } {
    if (path.extname(workspacePath).toLowerCase() !== '.cws') {
      throw new Error('Native workspace compatibility repair requires a .cws workspace.');
    }
    const document = IniDocument.parse(readText(workspacePath));
    const changes: string[] = [];
    const normalizePathKey = (section: IniSection, key: string): void => {
      const current = reconstructValue(section, key);
      if (current === undefined) {
        return;
      }
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
    const header = document.getSection('Workspace Header');
    const version = Number(header?.get('Version') ?? '1200');
    const projectCount = Number(header?.get('Number of Projects') ?? '0');
    for (let projectIndex = 1; projectIndex <= projectCount; projectIndex += 1) {
      changes.push(...ensureWorkspaceProjectSections(document, projectIndex, version));
    }
    if (changes.length > 0) {
      writeText(workspacePath, document.toString());
    }
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
    const document = IniDocument.parse(readText(projectPath));
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
    writeText(projectPath, document.toString());
  }

  setTargetType(projectPath: string, targetType: string): void {
    if (!['Executable', 'Dynamic Link Library', 'Static Library'].includes(targetType)) {
      throw new Error(`Unsupported CVI target type: ${targetType}`);
    }
    const document = IniDocument.parse(readText(projectPath));
    const header = document.getSection('Project Header');
    if (!header) {
      throw new Error('Invalid CVI project: missing [Project Header].');
    }
    header.set('Target Type', quote(targetType));
    const target = document.ensureSection('Create Executable');
    const extension = targetType === 'Dynamic Link Library' ? '.dll' : targetType === 'Static Library' ? '.lib' : '.exe';
    for (const mode of ['Debug', 'Release', 'Debug64', 'Release64']) {
      const relKey = `Executable File_${mode} Rel Path`;
      const absoluteKey = `Executable File_${mode}`;
      const currentRelative = unquote(target.get(relKey));
      const currentAbsolute = reconstructValue(target, absoluteKey);
      if (currentRelative) {
        target.set(relKey, quote(replaceExtension(currentRelative, extension)));
      } else {
        target.set(`Executable File_${mode} Is Rel`, 'True');
        target.set(`Executable File_${mode} Rel To`, quote('Project'));
        target.set(relKey, quote(`${path.basename(projectPath, path.extname(projectPath))}${extension}`));
      }
      if (currentAbsolute) {
        setPossiblyLongValue(target, absoluteKey, replaceExtension(currentAbsolute, extension));
      } else {
        setPossiblyLongValue(target, absoluteKey, path.join(path.dirname(projectPath), `${path.basename(projectPath, path.extname(projectPath))}${extension}`));
      }
    }
    writeText(projectPath, document.toString());
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
    const relativePath = normalizeRelativePath(workspaceDirectory, projectPath);
    const existing = header.entries().find(({ key, value }) => /^Project \d{4}$/i.test(key) && (unquote(value) ?? '').toLowerCase() === relativePath.toLowerCase());
    if (existing) {
      return Number(existing.key.match(/\d{4}/)?.[0] ?? '1');
    }

    const nextIndex = Number(header.get('Number of Projects') ?? '0') + 1;
    header.set('Number of Projects', String(nextIndex));
    header.set(`Project ${workspaceProjectSuffix(nextIndex)}`, quote(relativePath));
    if (!header.has('Active Project')) {
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
    const entries: string[] = [];
    for (let index = 1; index <= count; index += 1) {
      const value = header.get(`Project ${String(index).padStart(4, '0')}`);
      if (value && index !== projectIndex) {
        entries.push(value);
      }
    }

    header.deleteMatching(/^\s*Project \d{4}(?:\s+.*)?\s*=/i);
    header.set('Number of Projects', String(entries.length));
    entries.forEach((value, index) => header.set(`Project ${String(index + 1).padStart(4, '0')}`, value));

    const currentActive = Number(header.get('Active Project') ?? '1');
    const nextActive = entries.length === 0 ? 0 : Math.min(currentActive === projectIndex ? 1 : currentActive > projectIndex ? currentActive - 1 : currentActive, entries.length);
    header.set('Active Project', String(nextActive));
    writeText(workspacePath, document.toString());
  }

  addFilesToProject(projectPath: string, filePaths: string[], folderOverride?: string): number {
    const document = IniDocument.parse(readText(projectPath));
    const header = document.getSection('Project Header');
    if (!header) {
      throw new Error('Invalid CVI project: missing [Project Header].');
    }

    const projectDirectory = path.dirname(projectPath);
    const existingFiles = this.parseProject(projectPath).files.map((file) => path.normalize(file.absolutePath).toLowerCase());
    let nextId = document.sections
      .filter((section) => /^File \d{4}$/i.test(section.name))
      .map((section) => Number(section.name.match(/\d{4}/)?.[0] ?? '0'))
      .reduce((max, value) => Math.max(max, value), 0) + 1;
    let added = 0;

    for (const filePath of filePaths) {
      const normalized = path.normalize(filePath).toLowerCase();
      if (existingFiles.includes(normalized)) {
        continue;
      }

      const fileType = fileTypeForPath(filePath);
      const folder = folderOverride?.trim() || defaultFolderForType(fileType);
      const relativePath = normalizeRelativePath(projectDirectory, filePath);
      const sectionName = `File ${String(nextId).padStart(4, '0')}`;
      const section = new IniSection(sectionName, []);
      section.set('File Type', quote(fileType));
      section.set('Res Id', String(nextId));
      section.set('Path Is Rel', 'True');
      section.set('Path Rel To', quote('Project'));
      section.set('Path Rel Path', quote(relativePath));
      setPossiblyLongValue(section, 'Path', filePath);
      section.set('Exclude', 'False');
      if (fileType === 'CSource') {
        section.set('Compile Into Object File', 'False');
      }
      section.set('Project Flags', '0');
      section.set('Folder', quote(folder));
      section.lines.push('');
      document.addSection(section, 'Folders');
      this.ensureProjectFolder(document, folder);
      existingFiles.push(normalized);
      nextId += 1;
      added += 1;
    }

    header.set('Number of Files', String(Number(header.get('Number of Files') ?? '0') + added));
    writeText(projectPath, document.toString());
    return added;
  }

  removeFileFromProject(projectPath: string, sectionName: string): void {
    const document = IniDocument.parse(readText(projectPath));
    const header = document.getSection('Project Header');
    if (!header) {
      throw new Error('Invalid CVI project: missing [Project Header].');
    }
    if (!document.getSection(sectionName)) {
      return;
    }
    document.removeSection(sectionName);
    const remaining = document.sections.filter((section) => /^File \d{4}$/i.test(section.name));
    header.set('Number of Files', String(remaining.length));
    writeText(projectPath, document.toString());
  }


  addFolderToProject(projectPath: string, folder: string): void {
    const normalizedFolder = normalizeLogicalFolder(folder);
    if (!normalizedFolder) {
      throw new Error('A non-empty CVI logical folder name is required.');
    }
    const document = IniDocument.parse(readText(projectPath));
    this.ensureProjectFolder(document, normalizedFolder);
    writeText(projectPath, document.toString());
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

    const document = IniDocument.parse(readText(projectPath));
    for (const section of document.sections.filter((candidate) => /^File \d{4}$/i.test(candidate.name))) {
      const current = normalizeLogicalFolder(unquote(section.get('Folder')) ?? '');
      if (isSameOrDescendantFolder(current, oldNormalized)) {
        section.set('Folder', quote(replaceFolderPrefix(current, oldNormalized, newNormalized)));
      }
    }

    this.rewriteDeclaredFolders(document, (folder) => isSameOrDescendantFolder(folder, oldNormalized)
      ? replaceFolderPrefix(folder, oldNormalized, newNormalized)
      : folder);
    this.ensureProjectFolder(document, newNormalized);
    writeText(projectPath, document.toString());
  }

  removeFolderFromProject(projectPath: string, folder: string, removeFileReferences: boolean): void {
    const normalized = normalizeLogicalFolder(folder);
    if (!normalized) {
      throw new Error('A CVI logical folder name is required.');
    }

    const document = IniDocument.parse(readText(projectPath));
    const parentFolder = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
    for (const section of [...document.sections].filter((candidate) => /^File \d{4}$/i.test(candidate.name))) {
      const current = normalizeLogicalFolder(unquote(section.get('Folder')) ?? '');
      if (!isSameOrDescendantFolder(current, normalized)) {
        continue;
      }
      if (removeFileReferences) {
        document.removeSection(section.name);
      } else {
        const suffix = current.slice(normalized.length).replace(/^\/+/, '');
        section.set('Folder', quote([parentFolder, suffix].filter(Boolean).join('/')));
      }
    }

    this.rewriteDeclaredFolders(document, (declared) => {
      if (!isSameOrDescendantFolder(declared, normalized)) {
        return declared;
      }
      if (removeFileReferences) {
        return undefined;
      }
      const suffix = declared.slice(normalized.length).replace(/^\/+/, '');
      return [parentFolder, suffix].filter(Boolean).join('/') || undefined;
    });

    const header = document.getSection('Project Header');
    if (header) {
      header.set('Number of Files', String(document.sections.filter((section) => /^File \d{4}$/i.test(section.name)).length));
    }
    writeText(projectPath, document.toString());
  }

  setFileExcluded(projectPath: string, sectionName: string, excluded: boolean): void {
    const section = this.requireProjectFileSection(projectPath, sectionName);
    section.section.set('Exclude', excluded ? 'True' : 'False');
    writeText(projectPath, section.document.toString());
  }

  setCompileIntoObjectFile(projectPath: string, sectionName: string, enabled: boolean): void {
    const section = this.requireProjectFileSection(projectPath, sectionName);
    const fileType = unquote(section.section.get('File Type')) ?? 'Other';
    if (fileType !== 'CSource') {
      throw new Error('The .Obj option is available only for C source files.');
    }
    section.section.set('Compile Into Object File', enabled ? 'True' : 'False');
    writeText(projectPath, section.document.toString());
  }

  replaceFileInProject(projectPath: string, sectionName: string, replacementPath: string): void {
    const { document, section } = this.requireProjectFileSection(projectPath, sectionName);
    const projectDirectory = path.dirname(projectPath);
    const fileType = fileTypeForPath(replacementPath);
    section.set('File Type', quote(fileType));
    section.set('Path Is Rel', 'True');
    section.set('Path Rel To', quote('Project'));
    section.set('Path Rel Path', quote(normalizeRelativePath(projectDirectory, replacementPath)));
    setPossiblyLongValue(section, 'Path', replacementPath);
    if (fileType === 'CSource') {
      if (!section.has('Compile Into Object File')) {
        section.set('Compile Into Object File', 'False');
      }
    } else {
      section.delete('Compile Into Object File');
    }
    writeText(projectPath, document.toString());
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
    const document = IniDocument.parse(readText(workspacePath));
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
      writeText(workspacePath, document.toString());
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

  private ensureProjectFolder(document: IniDocument, folder: string): void {
    const folders = document.ensureSection('Folders', 'Custom Build Configs');
    const entries = folders.entries().filter(({ key }) => /^Folder \d+$/i.test(key));
    if (entries.some(({ value }) => (unquote(value) ?? '').toLowerCase() === folder.toLowerCase())) {
      return;
    }
    folders.set(`Folder ${entries.length}`, quote(folder));
  }


  private requireProjectFileSection(projectPath: string, sectionName: string): { document: IniDocument; section: IniSection } {
    const document = IniDocument.parse(readText(projectPath));
    const section = document.getSection(sectionName);
    if (!section || !/^File \d{4}$/i.test(section.name)) {
      throw new Error(`CVI project file entry not found: ${sectionName}`);
    }
    return { document, section };
  }

  private rewriteDeclaredFolders(document: IniDocument, mapFolder: (folder: string) => string | undefined): void {
    const folders = document.ensureSection('Folders', 'Custom Build Configs');
    const preserved = folders.entries().filter(({ key }) => !/^Folder \d+$/i.test(key));
    const mapped = folders.entries()
      .filter(({ key }) => /^Folder \d+$/i.test(key))
      .map(({ value }) => mapFolder(normalizeLogicalFolder(unquote(value) ?? '')))
      .filter((folder): folder is string => Boolean(folder))
      .filter((folder, index, all) => all.findIndex((candidate) => candidate.toLowerCase() === folder.toLowerCase()) === index);
    folders.lines = preserved.map(({ key, value }) => `${key} = ${value}`);
    mapped.forEach((folder, index) => folders.set(`Folder ${index}`, quote(folder)));
    folders.lines.push('');
  }

  private createMinimalWorkspaceText(workspacePath: string, projectFileName: string, cviDir: string | undefined, version: number): string {
    const document = new IniDocument();
    const header = new IniSection('Workspace Header', []);
    header.set('Version', String(version));
    setPossiblyLongValue(header, 'Pathname', workspacePath);
    if (cviDir) {
      setPossiblyLongValue(header, 'CVI Dir', cviDir);
    }
    header.set('Number of Projects', '1');
    header.set('Active Project', '1');
    header.set('Project 0001', quote(projectFileName));
    header.set('Save Changes Before Running', quote('Always'));
    header.set('Save Changes Before Compiling', quote('Always'));
    header.set('Sort Type', quote('File Name'));
    header.lines.push('');
    document.addSection(header);

    ensureWorkspaceProjectSections(document, 1, version);
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
