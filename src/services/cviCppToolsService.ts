import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CviInstallation, CviWorkspace } from '../model/types';
import { CviInstallationService } from './cviInstallationService';

const MANAGED_CONFIGURATION_NAME = 'LabWindows/CVI (managed)';

interface CppPropertiesDocument {
  version?: number;
  configurations?: CppToolsConfiguration[];
  [key: string]: unknown;
}

interface CppToolsConfiguration {
  name?: string;
  compilerPath?: string;
  intelliSenseMode?: string;
  cStandard?: string;
  cppStandard?: string;
  includePath?: string[];
  browse?: {
    path?: string[];
    limitSymbolsToIncludedHeaders?: boolean;
    [key: string]: unknown;
  };
  defines?: string[];
  [key: string]: unknown;
}

export class CviCppToolsService implements vscode.Disposable {
  private syncTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly installations: CviInstallationService,
    private readonly output: vscode.OutputChannel
  ) {}

  dispose(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = undefined;
    }
  }

  requestSync(workspace: CviWorkspace | undefined): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      void this.sync(workspace);
    }, 120);
  }

  async sync(workspace: CviWorkspace | undefined, notify = false): Promise<string | undefined> {
    if (!workspace) {
      if (notify) {
        vscode.window.showErrorMessage('Open a LabWindows/CVI workspace or project before synchronizing IntelliSense.');
      }
      return undefined;
    }

    const enabled = vscode.workspace.getConfiguration('labwindowsCvi').get<boolean>('autoConfigureCppTools', true);
    if (!enabled && !notify) {
      return undefined;
    }

    const installation = this.installations.getActiveInstallation(workspace.cviDir);
    if (!installation) {
      if (notify) {
        vscode.window.showErrorMessage('No LabWindows/CVI installation is selected. Select an installation before synchronizing IntelliSense.');
      }
      return undefined;
    }

    const root = this.findConfigurationRoot(workspace.path);
    const configPath = path.join(root, '.vscode', 'c_cpp_properties.json');
    const configuration = this.createManagedConfiguration(installation);
    const document = this.readExistingDocument(configPath);
    if (!document) {
      return undefined;
    }

    const configurations = Array.isArray(document.configurations) ? [...document.configurations] : [];
    const previousIndex = configurations.findIndex((candidate) => candidate?.name === MANAGED_CONFIGURATION_NAME);
    if (previousIndex >= 0) {
      configurations[previousIndex] = configuration;
    } else {
      configurations.unshift(configuration);
    }

    const updated: CppPropertiesDocument = {
      ...document,
      version: 4,
      configurations
    };
    const rendered = `${JSON.stringify(updated, null, 2)}\n`;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });

    const previous = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : undefined;
    if (previous !== rendered) {
      fs.writeFileSync(configPath, rendered, 'utf8');
      this.output.appendLine(`[CVI] Synchronized C/C++ IntelliSense configuration: ${configPath}`);
    }

    const owningFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workspace.path));
    if (!owningFolder) {
      this.output.appendLine(`[CVI] IntelliSense configuration was written outside the currently opened VS Code folders: ${configPath}`);
      if (notify) {
        vscode.window.showWarningMessage(`IntelliSense configuration written to ${configPath}. Open ${root} as a VS Code folder so the C/C++ extension can apply it.`);
      }
      return configPath;
    }

    if (notify) {
      vscode.window.showInformationMessage(`LabWindows/CVI IntelliSense configuration synchronized in ${configPath}.`);
    }
    return configPath;
  }

  private findConfigurationRoot(workspacePath: string): string {
    const owner = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workspacePath));
    return owner?.uri.fsPath ?? path.dirname(workspacePath);
  }

  private readExistingDocument(configPath: string): CppPropertiesDocument | undefined {
    if (!fs.existsSync(configPath)) {
      return {};
    }

    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(raw))) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('the root value is not a JSON object');
      }
      return parsed as CppPropertiesDocument;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[CVI] Cannot update ${configPath}: ${message}`);
      vscode.window.showWarningMessage(`The existing .vscode/c_cpp_properties.json file is invalid and was not modified: ${message}`);
      return undefined;
    }
  }

  private createManagedConfiguration(installation: CviInstallation): CppToolsConfiguration {
    const includeDirectory = path.join(installation.root, 'include');
    const toolsLibraryDirectory = path.join(installation.root, 'toolslib');
    const toolboxDirectory = path.join(toolsLibraryDirectory, 'toolbox');
    const windowsKitIncludeDirectory = findWindowsKitIncludeDirectory();

    const includePath = unique([
      '${workspaceFolder}/**',
      existingPath(includeDirectory),
      existingPath(toolsLibraryDirectory) ? `${toolsLibraryDirectory}${path.sep}**` : undefined,
      existingPath(toolboxDirectory),
      windowsKitIncludeDirectory ? `${windowsKitIncludeDirectory}${path.sep}**` : undefined
    ].filter((value): value is string => !!value).map(toForwardSlashes));

    const browsePath = unique([
      '${workspaceFolder}',
      existingPath(includeDirectory),
      existingPath(toolsLibraryDirectory),
      existingPath(toolboxDirectory)
    ].filter((value): value is string => !!value).map(toForwardSlashes));

    const configuration: CppToolsConfiguration = {
      name: MANAGED_CONFIGURATION_NAME,
      intelliSenseMode: 'clang-x86',
      cStandard: 'c11',
      cppStandard: 'c++17',
      includePath,
      browse: {
        path: browsePath,
        limitSymbolsToIncludedHeaders: false
      },
      defines: [
        '_WINDOWS',
        '_CRT_SECURE_NO_WARNINGS'
      ]
    };

    if (installation.clangCcExe) {
      configuration.compilerPath = toForwardSlashes(installation.clangCcExe);
    }
    return configuration;
  }
}

function findWindowsKitIncludeDirectory(): string | undefined {
  const roots = [
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    process.env.ProgramFiles ?? 'C:\\Program Files'
  ];
  for (const root of roots) {
    const candidate = path.join(root, 'Windows Kits', '10', 'Include');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function existingPath(value: string): string | undefined {
  return fs.existsSync(value) ? value : undefined;
}

function toForwardSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function stripTrailingCommas(value: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    if (inString) {
      result += current;
      if (escaped) {
        escaped = false;
      } else if (current === '\\') {
        escaped = true;
      } else if (current === '"') {
        inString = false;
      }
      continue;
    }

    if (current === '"') {
      inString = true;
      result += current;
      continue;
    }

    if (current === ',') {
      let lookAhead = index + 1;
      while (lookAhead < value.length && /\s/.test(value[lookAhead])) {
        lookAhead += 1;
      }
      if (value[lookAhead] === '}' || value[lookAhead] === ']') {
        continue;
      }
    }
    result += current;
  }

  return result;
}

function stripJsonComments(value: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    const next = value[index + 1];

    if (lineComment) {
      if (current === '\n' || current === '\r') {
        lineComment = false;
        result += current;
      }
      continue;
    }

    if (blockComment) {
      if (current === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      result += current;
      if (escaped) {
        escaped = false;
      } else if (current === '\\') {
        escaped = true;
      } else if (current === '"') {
        inString = false;
      }
      continue;
    }

    if (current === '"') {
      inString = true;
      result += current;
      continue;
    }

    if (current === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }

    if (current === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }

    result += current;
  }

  return result;
}
