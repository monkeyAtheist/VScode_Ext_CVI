import * as fs from 'fs';
import * as path from 'path';
import { IniDocument, IniSection } from './iniDocument';
import { CviBuildMode, CviProject, CviProjectFile, CviWorkspace, CviWorkspaceProjectRef } from './types';
import { fromCviPath, normalizeRelativePath, quote, splitCviLongValue, toCviPath, unquote } from '../utils/pathUtils';

function readText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function writeText(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, 'utf8');
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

  addProjectToWorkspace(workspacePath: string, projectPath: string): void {
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
    const existing = header.entries().some(({ key, value }) => /^Project \d{4}$/i.test(key) && (unquote(value) ?? '').toLowerCase() === relativePath.toLowerCase());
    if (existing) {
      return;
    }

    const nextIndex = Number(header.get('Number of Projects') ?? '0') + 1;
    header.set('Number of Projects', String(nextIndex));
    header.set(`Project ${String(nextIndex).padStart(4, '0')}`, quote(relativePath));
    if (!header.has('Active Project')) {
      header.set('Active Project', '1');
    }
    writeText(workspacePath, document.toString());
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

    const projectHeader = new IniSection('Project Header 0001', []);
    projectHeader.set('Version', String(version));
    projectHeader.set("Don't Update DistKit", 'False');
    projectHeader.set('Platform Code', '4');
    projectHeader.set('Build Configuration', quote('Debug'));
    projectHeader.set('Warn User If Debugging Release', '1');
    projectHeader.set('Batch Build Release', 'False');
    projectHeader.set('Batch Build Debug', 'False');
    projectHeader.set('Force Rebuild', 'False');
    projectHeader.lines.push('');
    document.addSection(projectHeader);
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
