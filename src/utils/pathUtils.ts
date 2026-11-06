import * as path from 'path';

export interface CviPathReference {
  absolutePath: string;
  isRelative: boolean;
  relativePath?: string;
  storedPath: string;
}

export function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function unquote(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"');
  }
  return trimmed;
}

function isWindowsDriveAbsolute(inputPath: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(inputPath);
}

function isWindowsUncAbsolute(inputPath: string): boolean {
  return /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(inputPath);
}

export function isCviAbsolutePath(inputPath: string): boolean {
  const value = (unquote(inputPath) ?? '').trim();
  return /^\/[A-Za-z](?:\/|$)/.test(value) || /^\/\/[^/]+\/[^/]+/.test(value);
}

function isWindowsAbsolute(inputPath: string): boolean {
  return isWindowsDriveAbsolute(inputPath) || isWindowsUncAbsolute(inputPath);
}

function windowsRoot(inputPath: string): string {
  return path.win32.parse(path.win32.normalize(inputPath.replace(/\//g, '\\'))).root.toLowerCase();
}

function usesWindowsSemantics(inputPath: string): boolean {
  return isWindowsAbsolute(inputPath) || isCviAbsolutePath(inputPath);
}

export function toCviPath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed) {
    return '';
  }

  // Preserve already-normalized CVI absolute paths.
  if (isCviAbsolutePath(trimmed)) {
    if (/^\/\/[^/]+\/[^/]+/.test(trimmed)) {
      return trimmed.replace(/\\/g, '/');
    }
    const driveMatch = trimmed.match(/^\/([A-Za-z])\/(.*)$/);
    return driveMatch ? `/${driveMatch[1].toLowerCase()}/${driveMatch[2].replace(/\\/g, '/')}` : trimmed;
  }

  const normalized = trimmed.replace(/\\/g, '/');
  const driveMatch = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (driveMatch) {
    return `/${driveMatch[1].toLowerCase()}/${driveMatch[2]}`;
  }

  // CVI accepts UNC paths using forward slashes. Keep the leading double slash.
  if (/^\/\/[^/]+\/[^/]+/.test(normalized)) {
    return normalized;
  }
  return normalized;
}

export function fromCviPath(inputPath: string): string {
  const value = unquote(inputPath) ?? '';
  const driveMatch = value.match(/^\/([A-Za-z])\/(.*)$/);
  if (driveMatch) {
    return path.win32.normalize(`${driveMatch[1].toUpperCase()}:\\${driveMatch[2].replace(/\//g, '\\')}`);
  }
  const uncMatch = value.match(/^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (uncMatch) {
    const suffix = uncMatch[3] ? `\\${uncMatch[3].replace(/\//g, '\\')}` : '';
    return path.win32.normalize(`\\\\${uncMatch[1]}\\${uncMatch[2]}${suffix}`);
  }
  if (isWindowsAbsolute(value)) {
    return path.win32.normalize(value.replace(/\//g, '\\'));
  }
  return value.replace(/\//g, path.sep);
}

/**
 * Resolve a path stored by CVI against a base directory. The stored value may be:
 * - a project/workspace relative path (src/main.c),
 * - a native Windows absolute path (C:\\...),
 * - a CVI absolute drive path (/c/...),
 * - a CVI/UNC absolute path (//server/share/...).
 *
 * Windows semantics are used whenever the base or target is Windows-like, even when
 * tests execute on Linux/macOS. This is important for validating multi-drive projects.
 */
export function resolveCviReferencePath(baseDirectory: string, storedPath: string): string {
  const trimmed = (unquote(storedPath) ?? '').trim();
  if (!trimmed) {
    return '';
  }
  if (isCviAbsolutePath(trimmed)) {
    return fromCviPath(trimmed);
  }
  if (isWindowsAbsolute(trimmed)) {
    return path.win32.normalize(trimmed.replace(/\//g, '\\'));
  }

  if (usesWindowsSemantics(baseDirectory)) {
    const nativeBase = isCviAbsolutePath(baseDirectory) ? fromCviPath(baseDirectory) : path.win32.normalize(baseDirectory.replace(/\//g, '\\'));
    return path.win32.resolve(nativeBase, trimmed.replace(/\//g, '\\'));
  }
  if (path.isAbsolute(trimmed)) {
    return path.normalize(trimmed);
  }
  return path.resolve(baseDirectory, trimmed);
}

/**
 * Build the canonical representation of a CVI reference.
 * A relative path is emitted only when base and target belong to the same filesystem root
 * (same Windows drive or same UNC share). Otherwise CVI gets an absolute /c/... or //server/... path.
 */
export function createCviPathReference(baseDirectory: string, targetPath: string): CviPathReference {
  const trimmedTarget = (unquote(targetPath) ?? '').trim();
  if (!trimmedTarget) {
    return { absolutePath: '', isRelative: false, storedPath: '' };
  }

  const windowsMode = usesWindowsSemantics(baseDirectory) || usesWindowsSemantics(trimmedTarget) || isWindowsAbsolute(trimmedTarget);
  if (windowsMode) {
    const baseNative = isCviAbsolutePath(baseDirectory)
      ? fromCviPath(baseDirectory)
      : path.win32.normalize(baseDirectory.replace(/\//g, '\\'));
    const targetNative = isCviAbsolutePath(trimmedTarget)
      ? fromCviPath(trimmedTarget)
      : isWindowsAbsolute(trimmedTarget)
        ? path.win32.normalize(trimmedTarget.replace(/\//g, '\\'))
        : path.win32.resolve(baseNative, trimmedTarget.replace(/\//g, '\\'));

    const baseRoot = windowsRoot(baseNative);
    const targetRoot = windowsRoot(targetNative);
    if (baseRoot && targetRoot && baseRoot === targetRoot) {
      const relative = path.win32.relative(baseNative, targetNative).replace(/\\/g, '/');
      const relativePath = relative || path.win32.basename(targetNative);
      return {
        absolutePath: targetNative,
        isRelative: true,
        relativePath,
        storedPath: relativePath
      };
    }

    return {
      absolutePath: targetNative,
      isRelative: false,
      storedPath: toCviPath(targetNative)
    };
  }

  const baseNative = path.resolve(baseDirectory);
  const targetNative = path.isAbsolute(trimmedTarget) ? path.normalize(trimmedTarget) : path.resolve(baseNative, trimmedTarget);
  const baseRoot = path.parse(baseNative).root;
  const targetRoot = path.parse(targetNative).root;
  if (baseRoot && targetRoot && baseRoot === targetRoot) {
    const relative = path.relative(baseNative, targetNative).replace(/\\/g, '/');
    const relativePath = relative || path.basename(targetNative);
    return {
      absolutePath: targetNative,
      isRelative: true,
      relativePath,
      storedPath: relativePath
    };
  }

  return {
    absolutePath: targetNative,
    isRelative: false,
    storedPath: toCviPath(targetNative)
  };
}

export function splitCviLongValue(value: string, maxLength = 96): string[] {
  if (value.length <= maxLength) {
    return [value];
  }

  const parts: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    parts.push(value.slice(offset, offset + maxLength));
    offset += maxLength;
  }
  return parts;
}

/** @deprecated Prefer createCviPathReference() so cross-volume paths cannot be emitted as relative. */
export function normalizeRelativePath(fromDirectory: string, targetPath: string): string {
  const reference = createCviPathReference(fromDirectory, targetPath);
  if (!reference.isRelative || !reference.relativePath) {
    throw new Error(`Cannot create a relative path from ${fromDirectory} to ${targetPath}: paths are on different roots.`);
  }
  return reference.relativePath;
}

export function fileNameWithoutExtension(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

export function toCviRuntimeStoragePath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed) {
    return '';
  }
  const cygdrive = trimmed.match(/^\/cygdrive\/([A-Za-z])\/(.*)$/);
  if (cygdrive) {
    return `/${cygdrive[1].toLowerCase()}/${cygdrive[2].replace(/\\/g, '/')}`;
  }
  const cviDrive = trimmed.match(/^\/([A-Za-z])\/(.*)$/);
  if (cviDrive) {
    return `/${cviDrive[1].toLowerCase()}/${cviDrive[2].replace(/\\/g, '/')}`;
  }
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return toCviPath(trimmed);
  }
  return trimmed;
}

export function normalizeRuntimePath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed) {
    return '';
  }
  const expanded = trimmed.replace(/%([^%]+)%/g, (_match, name: string) => process.env[name] ?? `%${name}%`);
  const cygdrive = expanded.match(/^\/cygdrive\/([A-Za-z])\/(.*)$/);
  if (cygdrive) {
    return path.win32.normalize(`${cygdrive[1].toUpperCase()}:\\${cygdrive[2].replace(/\//g, '\\')}`);
  }
  const cviDrive = expanded.match(/^\/([A-Za-z])\/(.*)$/);
  if (cviDrive) {
    return path.win32.normalize(`${cviDrive[1].toUpperCase()}:\\${cviDrive[2].replace(/\//g, '\\')}`);
  }
  if (/^[A-Za-z]:[\\/]/.test(expanded)) {
    return path.win32.normalize(expanded.replace(/\//g, '\\'));
  }
  return path.normalize(expanded);
}
