import * as path from 'path';

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

export function toCviPath(inputPath: string): string {
  const normalized = inputPath.replace(/\\/g, '/');
  const driveMatch = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (driveMatch) {
    return `/${driveMatch[1].toLowerCase()}/${driveMatch[2]}`;
  }
  return normalized;
}

export function fromCviPath(inputPath: string): string {
  const value = unquote(inputPath) ?? '';
  const driveMatch = value.match(/^\/([A-Za-z])\/(.*)$/);
  if (driveMatch) {
    return `${driveMatch[1].toUpperCase()}:\\${driveMatch[2].replace(/\//g, '\\')}`;
  }
  return value.replace(/\//g, path.sep);
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

export function normalizeRelativePath(fromDirectory: string, targetPath: string): string {
  const relative = path.relative(fromDirectory, targetPath).replace(/\\/g, '/');
  return relative === '' ? path.basename(targetPath) : relative;
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
