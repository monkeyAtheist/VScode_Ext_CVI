import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

interface PackIdentity {
  id?: string;
  name?: string;
  language?: string;
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

function isRootBackupFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.includes('.backup-') || lower.endsWith('.bak') || lower.endsWith('.backup.json');
}

function createBackupPath(target: string, previousVersion: string | undefined): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = sanitizeVersion(previousVersion);
  const packStem = path.basename(target, path.extname(target)).replace(/[^A-Za-z0-9._-]+/g, '_') || 'library_pack';
  const backupDirectory = path.join(path.dirname(target), '_backups');
  fs.mkdirSync(backupDirectory, { recursive: true });
  return path.join(backupDirectory, `${packStem}.backup-${suffix}-${timestamp}.json`);
}

function backupFile(target: string, previousVersion: string | undefined): string {
  const backup = createBackupPath(target, previousVersion);
  fs.copyFileSync(target, backup);
  return backup;
}

function moveLegacyRootBackups(targetDirectory: string, output: vscode.OutputChannel): void {
  if (!fs.existsSync(targetDirectory)) {
    return;
  }

  for (const entry of fs.readdirSync(targetDirectory)) {
    if (!entry.toLowerCase().endsWith('.json') || !isRootBackupFileName(entry)) {
      continue;
    }

    const source = path.join(targetDirectory, entry);
    if (!fs.statSync(source).isFile()) {
      continue;
    }

    const destination = createBackupPath(source, readPackIdentity(source)?.version || 'legacy-root-backup');
    try {
      fs.renameSync(source, destination);
      output.appendLine(`[CVI Libraries] Moved old pack backup out of the active pack directory: ${destination}`);
    } catch {
      try {
        fs.copyFileSync(source, destination);
        fs.rmSync(source, { force: true });
        output.appendLine(`[CVI Libraries] Copied old pack backup out of the active pack directory: ${destination}`);
      } catch (error) {
        output.appendLine(`[CVI Libraries] Failed to move old pack backup ${source}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

/**
 * Seed or upgrade the writable CVI library pack used by the embedded explorer.
 *
 * The explorer edits a global-storage copy rather than the packaged JSON. When
 * the bundled pack version changes, the previous writable copy is backed up and
 * replaced so that newly shipped CVI metadata becomes visible immediately.
 * User modifications remain recoverable from the timestamped backup folder.
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
    const backup = backupFile(target, installedVersion);
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

  const backup = backupFile(target, installed?.version || 'obsolete');
  fs.rmSync(target, { force: true });
  output.appendLine(`[CVI Libraries] Removed obsolete bundled ${label}; backup written to: ${backup}`);
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function hasLegacyPrivateMarker(raw: string): boolean {
  const normalized = normalizeSearchText(raw);
  return [
    'tnt_exec',
    'tnt exec',
    'tnt-exec',
    'tnt_exec / hnf sequencer',
    'hnf sequencer',
    'hnf sequenceur',
    'hnf_sequenceur',
    'mptlua',
    'mpt lua',
    'mpt studio',
    'api_mpt'
  ].some((marker) => normalized.includes(marker)) || /\bmpt\b/.test(normalized);
}

function hasStrongLegacyPrivateIdentity(fileName: string, identity: PackIdentity | undefined, raw: string): boolean {
  const identityText = `${fileName}\n${identity?.id || ''}\n${identity?.name || ''}\n${identity?.language || ''}`;
  const normalizedIdentity = normalizeSearchText(identityText);
  if ([
    'tnt_exec_pack',
    'tnt-exec-hnf-sequencer-pack',
    'tnt exec / hnf sequencer pack',
    'hnf sequencer pack',
    'hnf sequenceur pack',
    'mptlua',
    'mpt lua pack',
    'mpt studio pack'
  ].some((marker) => normalizedIdentity.includes(marker))) {
    return true;
  }

  // Fallback for older user copies that were renamed but still contain the private pack metadata.
  return hasLegacyPrivateMarker(raw) && (
    normalizedIdentity.includes('tnt') ||
    normalizedIdentity.includes('hnf') ||
    normalizedIdentity.includes('sequencer') ||
    normalizedIdentity.includes('sequenceur') ||
    /\bmpt\b/.test(normalizedIdentity)
  );
}

function replaceWritablePackWithBundledCleanCopy(context: vscode.ExtensionContext, output: vscode.OutputChannel, target: string, fileName: string, label: string, installed: PackIdentity | undefined): void {
  const source = vscode.Uri.joinPath(context.extensionUri, 'data', fileName).fsPath;
  if (!fs.existsSync(source)) {
    output.appendLine(`[CVI Libraries] Clean bundled ${label} not found; obsolete writable pack was kept: ${source}`);
    return;
  }

  const backup = backupFile(target, installed?.version || 'legacy');
  fs.copyFileSync(source, target);
  output.appendLine(`[CVI Libraries] Replaced obsolete writable ${label} with the clean bundled copy; backup written to: ${backup}`);
}

function backupAndRemoveLegacyPrivatePacks(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  const targetDirectory = path.join(context.globalStorageUri.fsPath, 'packs');
  if (!fs.existsSync(targetDirectory)) {
    return;
  }

  moveLegacyRootBackups(targetDirectory, output);

  for (const entry of fs.readdirSync(targetDirectory)) {
    const lowerName = entry.toLowerCase();
    if (!lowerName.endsWith('.json') || isRootBackupFileName(entry)) {
      continue;
    }

    const target = path.join(targetDirectory, entry);
    if (!fs.statSync(target).isFile()) {
      continue;
    }

    let raw = '';
    try {
      raw = fs.readFileSync(target, 'utf8');
    } catch {
      continue;
    }

    const installed = readPackIdentity(target);

    if (hasLegacyPrivateMarker(raw) && ['lua_pack.json', 'default_pack.json', 'c_language_pack.json', 'cvi_pack.json'].includes(lowerName)) {
      replaceWritablePackWithBundledCleanCopy(context, output, target, lowerName, lowerName.replace(/_/g, ' ').replace(/\.json$/i, ''), installed);
      continue;
    }

    if (!hasStrongLegacyPrivateIdentity(entry, installed, raw)) {
      continue;
    }

    const backup = backupFile(target, installed?.version || 'legacy');
    fs.rmSync(target, { force: true });
    output.appendLine(`[CVI Libraries] Removed obsolete private pack from user storage; backup written to: ${backup}`);
  }
}

export function ensureBundledCviLibraryPack(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  seedOrUpgradeBundledPack(context, output, 'cvi_pack.json', 'CVI library pack');
  seedOrUpgradeBundledPack(context, output, 'c_language_pack.json', 'C language and C DLL library pack');
  backupAndRemoveObsoleteBundledPack(context, output, 'my_util_c_pack.json', 'my-util-c-pack', 'MY Util C library pack');
  backupAndRemoveLegacyPrivatePacks(context, output);
}
