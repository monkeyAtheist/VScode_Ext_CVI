import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { CviBuildMode, CviWorkspaceProjectRef } from '../model/types';
import { CviParser } from '../model/cviParser';
import { CviInstallation, CviWorkspace } from '../model/types';
import { CviInstallationService } from './cviInstallationService';
import { CviWorkspaceService } from './cviWorkspaceService';

export class CviBuildService {
  constructor(
    private readonly parser: CviParser,
    private readonly workspaces: CviWorkspaceService,
    private readonly installations: CviInstallationService,
    private readonly output: vscode.OutputChannel
  ) {}

  get buildMode(): CviBuildMode {
    return vscode.workspace.getConfiguration('labwindowsCvi').get<CviBuildMode>('buildMode', 'debug');
  }

  async selectBuildMode(): Promise<void> {
    const selected = await vscode.window.showQuickPick([
      { label: 'Debug x86', value: 'debug' as CviBuildMode, description: 'compile.exe -debug' },
      { label: 'Release x86', value: 'release' as CviBuildMode, description: 'compile.exe -release' },
      { label: 'Debug x64', value: 'debug64' as CviBuildMode, description: 'compile.exe -debug64' },
      { label: 'Release x64', value: 'release64' as CviBuildMode, description: 'compile.exe -release64' }
    ], { title: 'Select the LabWindows/CVI build mode' });
    if (!selected) {
      return;
    }
    await vscode.workspace.getConfiguration('labwindowsCvi').update('buildMode', selected.value, vscode.ConfigurationTarget.Workspace);
    vscode.window.showInformationMessage(`LabWindows/CVI build mode: ${selected.label}.`);
  }

  async build(rebuild = false, projectRef?: CviWorkspaceProjectRef): Promise<boolean> {
    const ref = projectRef ?? this.workspaces.activeProjectRef;
    if (!ref?.exists) {
      vscode.window.showErrorMessage('No existing active CVI project is available for build.');
      return false;
    }

    const installation = await this.requireCompiler();
    if (!installation?.compileExe) {
      return false;
    }

    const args: string[] = [ref.absolutePath, ...this.commonCompilerArguments(rebuild)];
    return this.spawnCompile(installation.compileExe, args, path.dirname(ref.absolutePath), `${rebuild ? 'Rebuild' : 'Build'} ${ref.name}`);
  }

  async compileFile(filePath: string, projectRef?: CviWorkspaceProjectRef): Promise<boolean> {
    const ref = projectRef ?? this.workspaces.activeProjectRef;
    if (!ref?.exists) {
      vscode.window.showErrorMessage('No existing CVI project is available to provide compiler options.');
      return false;
    }
    if (path.extname(filePath).toLowerCase() !== '.c') {
      vscode.window.showErrorMessage('Compile File is available only for C source files.');
      return false;
    }
    if (!fs.existsSync(filePath)) {
      vscode.window.showErrorMessage(`Source file not found: ${filePath}`);
      return false;
    }

    const installation = await this.requireCompiler();
    if (!installation?.compileExe) {
      return false;
    }

    // NI compile.exe accepts source files followed by one project file. The project supplies the build options.
    const args = [filePath, ref.absolutePath, ...this.commonCompilerArguments(false)];
    return this.spawnCompile(installation.compileExe, args, path.dirname(ref.absolutePath), `Compile ${path.basename(filePath)}`);
  }

  async run(projectRef?: CviWorkspaceProjectRef): Promise<void> {
    const ref = projectRef ?? this.workspaces.activeProjectRef;
    if (!ref?.exists) {
      vscode.window.showErrorMessage('No existing CVI project is available to run.');
      return;
    }

    const targetPath = this.parser.getTargetPath(ref.absolutePath, this.buildMode);
    if (!targetPath) {
      vscode.window.showErrorMessage(`The output target for ${ref.name} could not be resolved from the CVI project.`);
      return;
    }
    if (path.extname(targetPath).toLowerCase() !== '.exe') {
      vscode.window.showErrorMessage(`The selected target is ${path.basename(targetPath)}, not an executable.`);
      return;
    }
    if (!fs.existsSync(targetPath)) {
      const answer = await vscode.window.showWarningMessage(
        `${path.basename(targetPath)} does not exist. Build ${ref.name} now?`,
        'Build and run'
      );
      if (answer !== 'Build and run') {
        return;
      }
      const success = await this.build(false, ref);
      if (!success || !fs.existsSync(targetPath)) {
        return;
      }
    }

    const args = vscode.workspace.getConfiguration('labwindowsCvi').get<string[]>('runArguments', []);
    const child = spawn(targetPath, args, {
      cwd: path.dirname(targetPath),
      detached: true,
      shell: false,
      stdio: 'ignore'
    });
    child.unref();
    this.output.appendLine(`[CVI] Started ${targetPath} ${args.map(renderArgument).join(' ')}`);
  }

  async openWorkspaceInCvi(): Promise<void> {
    const workspace = this.workspaces.currentWorkspace;
    if (!workspace) {
      vscode.window.showErrorMessage('No CVI workspace is loaded.');
      return;
    }
    await this.openInCvi(workspace.path, workspace);
  }

  async openProjectInCvi(projectPath: string): Promise<void> {
    await this.openInCvi(projectPath, this.workspaces.currentWorkspace);
  }

  async openPanelInCvi(panelPath: string): Promise<void> {
    if (!fs.existsSync(panelPath)) {
      vscode.window.showErrorMessage(`Panel not found: ${panelPath}`);
      return;
    }
    await this.openInCvi(panelPath, this.workspaces.currentWorkspace, true);
  }

  private async requireCompiler(): Promise<CviInstallation | undefined> {
    let installation = this.installations.getActiveInstallation(this.workspaces.currentWorkspace?.cviDir);
    if (!installation?.compileExe) {
      installation = await this.installations.selectInstallation(this.workspaces.currentWorkspace?.cviDir);
    }
    if (!installation?.compileExe) {
      vscode.window.showErrorMessage('compile.exe was not found. Select the correct LabWindows/CVI installation directory.');
      return undefined;
    }
    return installation;
  }

  private commonCompilerArguments(rebuild: boolean): string[] {
    const config = vscode.workspace.getConfiguration('labwindowsCvi');
    const customConfig = config.get<string>('customBuildConfiguration', '').trim();
    const extraArguments = config.get<string[]>('extraCompilerArguments', []);
    const args: string[] = [`-${this.buildMode}`];
    if (rebuild) {
      args.push('-rebuild');
    }
    if (customConfig) {
      args.push(`-config=${customConfig}`);
    }
    args.push(...extraArguments);
    return args;
  }

  private async spawnCompile(compileExe: string, args: string[], cwd: string, label: string): Promise<boolean> {
    this.output.clear();
    this.output.show(true);
    this.output.appendLine(`[CVI] ${label} started`);
    this.output.appendLine(`[CVI] Compiler: ${compileExe}`);
    this.output.appendLine(`[CVI] Arguments: ${args.map(renderArgument).join(' ')}`);
    this.output.appendLine('');

    return await new Promise<boolean>((resolve) => {
      const child = spawn(compileExe, args, { cwd, windowsHide: true, shell: false });
      let finished = false;
      const finish = (success: boolean): void => {
        if (!finished) {
          finished = true;
          resolve(success);
        }
      };
      child.stdout.on('data', (data: Buffer) => this.output.append(data.toString()));
      child.stderr.on('data', (data: Buffer) => this.output.append(data.toString()));
      child.on('error', (error) => {
        this.output.appendLine(`\n[CVI] Unable to start compile.exe: ${error.message}`);
        vscode.window.showErrorMessage(`Unable to start LabWindows/CVI compiler: ${error.message}`);
        finish(false);
      });
      child.on('close', (code) => {
        this.output.appendLine('');
        this.output.appendLine(`[CVI] compile.exe exited with code ${String(code)}.`);
        if (code === 0) {
          vscode.window.showInformationMessage(`${label} completed successfully.`);
          finish(true);
        } else {
          vscode.window.showErrorMessage(`${label} failed. Open the LabWindows/CVI output channel for details.`);
          finish(false);
        }
      });
    });
  }

  private async openInCvi(filePath: string, workspace?: CviWorkspace, allowExternalFallback = false): Promise<void> {
    let installation = this.installations.getActiveInstallation(workspace?.cviDir);
    if (!installation?.ideExe) {
      installation = await this.installations.selectInstallation(workspace?.cviDir);
    }
    if (installation?.ideExe) {
      const child = spawn(installation.ideExe, [filePath], {
        cwd: path.dirname(filePath),
        detached: true,
        shell: false,
        stdio: 'ignore'
      });
      child.unref();
      return;
    }

    if (allowExternalFallback) {
      const opened = await vscode.env.openExternal(vscode.Uri.file(filePath));
      if (opened) {
        return;
      }
    }
    vscode.window.showErrorMessage('cvi.exe was not found. Select the correct LabWindows/CVI installation directory.');
  }
}

function renderArgument(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}
