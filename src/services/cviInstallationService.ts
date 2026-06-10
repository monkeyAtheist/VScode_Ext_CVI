import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CviInstallation } from '../model/types';

const CONFIG_SECTION = 'labwindowsCvi';

function exists(filePath: string | undefined): filePath is string {
  return !!filePath && fs.existsSync(filePath);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = path.normalize(value);
    const key = normalized.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}

function findExecutable(root: string, names: string[]): string | undefined {
  const commonDirectories = [
    root,
    path.join(root, 'bin'),
    path.join(root, 'Bin'),
    path.join(root, 'bin', 'clang'),
    path.join(root, 'Bin', 'clang')
  ];
  for (const directory of commonDirectories) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (exists(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export class CviInstallationService {
  constructor(private readonly output: vscode.OutputChannel) {}

  get configuration(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(CONFIG_SECTION);
  }

  describe(root: string, source: CviInstallation['source']): CviInstallation {
    const normalizedRoot = path.normalize(root);
    return {
      root: normalizedRoot,
      label: path.basename(normalizedRoot),
      compileExe: findExecutable(normalizedRoot, ['compile.exe']),
      ideExe: findExecutable(normalizedRoot, ['cvi.exe', 'CVI.exe']),
      clangCcExe: findExecutable(normalizedRoot, ['clang-cc.exe']),
      source
    };
  }

  getConfiguredInstallations(): CviInstallation[] {
    const roots = this.configuration.get<string[]>('installations', []);
    return unique(roots).filter((root) => fs.existsSync(root)).map((root) => this.describe(root, 'configured'));
  }

  scanInstallations(): CviInstallation[] {
    const roots: string[] = [];
    const environmentCandidate = process.env.CVI_DIR;
    if (environmentCandidate) {
      roots.push(environmentCandidate);
    }

    const nationalInstrumentsRoots = [
      path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'National Instruments'),
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'National Instruments')
    ];

    for (const niRoot of nationalInstrumentsRoots) {
      if (!fs.existsSync(niRoot)) {
        continue;
      }
      for (const entry of fs.readdirSync(niRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && /^cvi/i.test(entry.name)) {
          roots.push(path.join(niRoot, entry.name));
        }
      }
    }

    return unique(roots)
      .filter((root) => fs.existsSync(root))
      .map((root) => this.describe(root, 'scan'))
      .filter((installation) => !!installation.compileExe || !!installation.ideExe);
  }

  getKnownInstallations(workspaceCviDir?: string): CviInstallation[] {
    const configured = this.getConfiguredInstallations();
    const scanned = this.scanInstallations();
    const workspace = workspaceCviDir && fs.existsSync(workspaceCviDir) ? [this.describe(workspaceCviDir, 'workspace')] : [];
    const merged = [...workspace, ...configured, ...scanned];
    const byRoot = new Map<string, CviInstallation>();
    for (const installation of merged) {
      const key = installation.root.toLowerCase();
      if (!byRoot.has(key)) {
        byRoot.set(key, installation);
      }
    }
    return [...byRoot.values()];
  }

  getActiveInstallation(workspaceCviDir?: string): CviInstallation | undefined {
    const selectedRoot = this.configuration.get<string>('activeInstallation', '').trim();
    if (selectedRoot) {
      const selected = this.describe(selectedRoot, 'configured');
      if (fs.existsSync(selected.root)) {
        return selected;
      }
    }

    if (workspaceCviDir && fs.existsSync(workspaceCviDir)) {
      return this.describe(workspaceCviDir, 'workspace');
    }

    return this.getKnownInstallations()[0];
  }

  async selectInstallation(workspaceCviDir?: string): Promise<CviInstallation | undefined> {
    const installations = this.getKnownInstallations(workspaceCviDir);
    const choices: Array<vscode.QuickPickItem & { installation?: CviInstallation; manual?: boolean }> = installations.map((installation) => ({
      label: installation.label,
      description: installation.root,
      detail: `${installation.compileExe ? 'compile.exe detected' : 'compile.exe missing'} · ${installation.ideExe ? 'CVI IDE detected' : 'CVI IDE missing'} · ${installation.source}`,
      installation
    }));
    choices.push({
      label: '$(folder-opened) Select another installation folder...',
      description: 'Choose the directory that contains the LabWindows/CVI installation',
      manual: true
    });

    const selected = await vscode.window.showQuickPick(choices, {
      title: 'Select the LabWindows/CVI installation',
      placeHolder: 'The selected root directory is stored in VS Code settings.'
    });
    if (!selected) {
      return undefined;
    }

    let installation = selected.installation;
    if (selected.manual) {
      const folder = await vscode.window.showOpenDialog({
        title: 'Select the LabWindows/CVI installation root directory',
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false
      });
      if (!folder?.[0]) {
        return undefined;
      }
      installation = this.describe(folder[0].fsPath, 'manual');
    }

    if (!installation) {
      return undefined;
    }

    await this.configuration.update('activeInstallation', installation.root, vscode.ConfigurationTarget.Global);
    const configured = this.configuration.get<string[]>('installations', []);
    if (!configured.some((root) => path.normalize(root).toLowerCase() === installation!.root.toLowerCase())) {
      await this.configuration.update('installations', [...configured, installation.root], vscode.ConfigurationTarget.Global);
    }

    this.output.appendLine(`[CVI] Selected installation: ${installation.root}`);
    if (!installation.compileExe) {
      vscode.window.showWarningMessage('The selected directory does not expose compile.exe in a known location. Build commands will remain unavailable until the correct installation root is selected.');
    }
    return installation;
  }
}
