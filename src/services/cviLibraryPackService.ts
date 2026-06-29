import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

interface PackIdentity {
  id?: string;
  name?: string;
  version?: string;
}

function readPackIdentity(filePath: string): PackIdentity | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as PackIdentity;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeVersion(version: string | undefined): string {
  return String(version || 'unknown').replace(/[^A-Za-z0-9._-]+/g, '_');
}

function createBackupPath(target: string, previousVersion: string | undefined): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = sanitizeVersion(previousVersion);
  const packStem = path.basename(target, path.extname(target)).replace(/[^A-Za-z0-9._-]+/g, '_') || 'library_pack';
  return path.join(path.dirname(target), `${packStem}.backup-${suffix}-${timestamp}.json`);
}

/**
 * Seed or upgrade the writable CVI library pack used by the embedded explorer.
 *
 * The explorer edits a global-storage copy rather than the packaged JSON. When
 * the bundled pack version changes, the previous writable copy is backed up and
 * replaced so that newly shipped CVI metadata becomes visible immediately.
 * User modifications remain recoverable from the timestamped backup.
 */
function seedOrUpgradeBundledPack(context: vscode.ExtensionContext, output: vscode.OutputChannel, fileName: string, label: string): void {
  const source = vscode.Uri.joinPath(context.extensionUri, 'data', fileName).fsPath;
  const targetDirectory = path.join(context.globalStorageUri.fsPath, 'packs');
  const target = path.join(targetDirectory, fileName);

  if (!fs.existsSync(source)) {
    output.appendLine(`[CVI Libraries] Bundled ${label} not found: ${source}`);
    return;
  }

  fs.mkdirSync(targetDirectory, { recursive: true });
  if (!fs.existsSync(target)) {
    fs.copyFileSync(source, target);
    output.appendLine(`[CVI Libraries] Seeded ${label}: ${target}`);
    return;
  }

  const bundled = readPackIdentity(source);
  const installed = readPackIdentity(target);
  const bundledVersion = String(bundled?.version || '');
  const installedVersion = String(installed?.version || '');
  const samePack = !installed?.id || !bundled?.id || installed.id === bundled.id;

  if (samePack && bundledVersion && bundledVersion !== installedVersion) {
    const backup = createBackupPath(target, installedVersion);
    fs.copyFileSync(target, backup);
    fs.copyFileSync(source, target);
    output.appendLine(`[CVI Libraries] Upgraded ${label} ${installedVersion || 'unknown'} -> ${bundledVersion}.`);
    output.appendLine(`[CVI Libraries] Previous writable pack backed up to: ${backup}`);
    return;
  }

  if (!samePack) {
    output.appendLine(`[CVI Libraries] Existing writable pack has a different id; kept unchanged: ${target}`);
  }
}


function backupAndRemoveObsoleteBundledPack(context: vscode.ExtensionContext, output: vscode.OutputChannel, fileName: string, expectedId: string, label: string): void {
  const targetDirectory = path.join(context.globalStorageUri.fsPath, 'packs');
  const target = path.join(targetDirectory, fileName);

  if (!fs.existsSync(target)) {
    return;
  }

  const installed = readPackIdentity(target);
  if (installed?.id && installed.id !== expectedId) {
    output.appendLine(`[CVI Libraries] Obsolete ${label} was not removed because the installed pack id differs: ${target}`);
    return;
  }

  const backup = createBackupPath(target, installed?.version || 'obsolete');
  fs.copyFileSync(target, backup);
  fs.rmSync(target, { force: true });
  output.appendLine(`[CVI Libraries] Removed obsolete bundled ${label}; backup written to: ${backup}`);
}

export function ensureBundledCviLibraryPack(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  seedOrUpgradeBundledPack(context, output, 'cvi_pack.json', 'CVI library pack');
  seedOrUpgradeBundledPack(context, output, 'c_language_pack.json', 'C language and C DLL library pack');
  seedOrUpgradeBundledPack(context, output, 'tnt_exec_pack.json', 'TNT_EXEC/HNF sequencer library pack');
  backupAndRemoveObsoleteBundledPack(context, output, 'my_util_c_pack.json', 'my-util-c-pack', 'MY Util C library pack');
}
