import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CviWorkspaceService } from './cviWorkspaceService';

export interface CviSourceSymbol {
  name: string;
  signature: string;
  filePath: string;
  line: number;
  character: number;
  kind: vscode.SymbolKind;
  source: 'document' | 'fallback';
}

export interface CviCompletionSymbol {
  name: string;
  signature: string;
  description?: string;
  origin: 'project' | 'cvi';
}

const FUNCTION_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor
]);

export class CviSymbolService {
  private bundledCache?: CviCompletionSymbol[];
  private projectCache?: { key: string; symbols: CviCompletionSymbol[] };

  constructor(
    private readonly extensionPath: string,
    private readonly workspaces: CviWorkspaceService
  ) {}

  async symbolsForFile(filePath: string): Promise<CviSourceSymbol[]> {
    if (!isSourceOrHeader(filePath) || !fs.existsSync(filePath)) {
      return [];
    }

    const uri = vscode.Uri.file(filePath);
    try {
      const provided = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
        'vscode.executeDocumentSymbolProvider',
        uri
      );
      const flattened = flattenDocumentSymbols(provided ?? [], filePath);
      if (flattened.length > 0) {
        return dedupeSourceSymbols(flattened);
      }
    } catch {
      // The lightweight fallback below keeps the feature available without cpptools.
    }

    return scanCFunctions(fs.readFileSync(filePath, 'utf8'), filePath);
  }

  completionSymbols(): CviCompletionSymbol[] {
    return dedupeCompletionSymbols([
      ...this.projectCompletionSymbols(),
      ...this.bundledCviCompletionSymbols()
    ]);
  }

  isCviWorkspaceFile(filePath: string): boolean {
    const workspace = this.workspaces.currentWorkspace;
    if (!workspace || !filePath) {
      return false;
    }
    const candidate = path.resolve(filePath).toLowerCase();
    const workspaceDirectory = path.dirname(workspace.path).toLowerCase();
    if (isPathInside(candidate, workspaceDirectory)) {
      return true;
    }
    for (const projectRef of workspace.projects) {
      if (!projectRef.exists) continue;
      const projectDirectory = path.dirname(projectRef.absolutePath).toLowerCase();
      if (isPathInside(candidate, projectDirectory)) {
        return true;
      }
      const project = this.workspaces.getProject(projectRef);
      if (project?.files.some((entry) => path.resolve(entry.absolutePath).toLowerCase() === candidate)) {
        return true;
      }
    }
    return false;
  }

  invalidateProjectCache(): void {
    this.projectCache = undefined;
  }

  private projectCompletionSymbols(): CviCompletionSymbol[] {
    const ref = this.workspaces.activeProjectRef;
    const project = ref?.exists ? this.workspaces.getProject(ref) : undefined;
    if (!project) {
      return [];
    }

    const candidateFiles = project.files
      .map((file) => file.absolutePath)
      .filter((filePath) => isSourceOrHeader(filePath) && fs.existsSync(filePath));
    const key = candidateFiles
      .map((filePath) => `${filePath}:${safeMtime(filePath)}`)
      .join('|');
    if (this.projectCache?.key === key) {
      return this.projectCache.symbols;
    }

    const symbols: CviCompletionSymbol[] = [];
    for (const filePath of candidateFiles) {
      const parsed = scanCFunctions(fs.readFileSync(filePath, 'utf8'), filePath);
      for (const symbol of parsed) {
        symbols.push({
          name: symbol.name,
          signature: symbol.signature,
          description: `Project symbol · ${path.basename(filePath)}`,
          origin: 'project'
        });
      }
    }
    this.projectCache = { key, symbols: dedupeCompletionSymbols(symbols) };
    return this.projectCache.symbols;
  }

  private bundledCviCompletionSymbols(): CviCompletionSymbol[] {
    if (this.bundledCache) {
      return this.bundledCache;
    }
    const packPath = path.join(this.extensionPath, 'data', 'cvi_pack.json');
    if (!fs.existsSync(packPath)) {
      this.bundledCache = [];
      return this.bundledCache;
    }

    try {
      const raw = JSON.parse(fs.readFileSync(packPath, 'utf8')) as unknown;
      const collected: CviCompletionSymbol[] = [];
      collectPackFunctions(raw, collected);
      this.bundledCache = dedupeCompletionSymbols(collected);
    } catch {
      this.bundledCache = [];
    }
    return this.bundledCache;
  }
}

export class CviCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly symbols: CviSymbolService) {}

  provideCompletionItems(document: vscode.TextDocument): vscode.CompletionItem[] | undefined {
    const enabled = vscode.workspace.getConfiguration('labwindowsCvi').get<boolean>('enableSupplementalCompletionProvider', true);
    if (!enabled || document.uri.scheme !== 'file' || !this.symbols.isCviWorkspaceFile(document.uri.fsPath)) {
      return undefined;
    }
    return this.symbols.completionSymbols().map((symbol) => {
      const item = new vscode.CompletionItem(symbol.name, vscode.CompletionItemKind.Function);
      item.detail = symbol.signature;
      item.documentation = new vscode.MarkdownString(symbol.description || (symbol.origin === 'cvi' ? 'LabWindows/CVI API symbol.' : 'Project symbol.'));
      item.insertText = symbol.name;
      item.sortText = `${symbol.origin === 'project' ? '0' : '5'}_${symbol.name.toLowerCase()}`;
      return item;
    });
  }
}

function collectPackFunctions(value: unknown, result: CviCompletionSymbol[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectPackFunctions(entry, result));
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  const record = value as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const signature = typeof record.signature === 'string'
    ? record.signature.trim()
    : typeof record.declaration === 'string'
      ? record.declaration.trim()
      : '';
  const symbolKind = typeof record.symbolKind === 'string' ? record.symbolKind : '';
  if (name && signature.includes('(') && (!symbolKind || ['function', 'method', 'macro', 'metamethod'].includes(symbolKind))) {
    result.push({
      name,
      signature,
      description: typeof record.description === 'string' ? record.description : 'LabWindows/CVI API symbol.',
      origin: 'cvi'
    });
  }
  Object.values(record).forEach((entry) => collectPackFunctions(entry, result));
}

function flattenDocumentSymbols(entries: Array<vscode.DocumentSymbol | vscode.SymbolInformation>, fallbackPath: string): CviSourceSymbol[] {
  const result: CviSourceSymbol[] = [];
  const visit = (entry: vscode.DocumentSymbol | vscode.SymbolInformation): void => {
    if ('location' in entry) {
      if (FUNCTION_KINDS.has(entry.kind)) {
        result.push({
          name: entry.name,
          signature: entry.name,
          filePath: entry.location.uri.fsPath || fallbackPath,
          line: entry.location.range.start.line,
          character: entry.location.range.start.character,
          kind: entry.kind,
          source: 'document'
        });
      }
      return;
    }
    if (FUNCTION_KINDS.has(entry.kind)) {
      result.push({
        name: entry.name,
        signature: entry.detail ? `${entry.name} ${entry.detail}`.trim() : entry.name,
        filePath: fallbackPath,
        line: entry.selectionRange.start.line,
        character: entry.selectionRange.start.character,
        kind: entry.kind,
        source: 'document'
      });
    }
    entry.children.forEach(visit);
  };
  entries.forEach(visit);
  return result;
}

export function scanCFunctions(source: string, filePath: string): CviSourceSymbol[] {
  const masked = maskCommentsAndStrings(source);
  const pattern = /(^|\n)\s*((?:(?:extern|static|inline|const|volatile|unsigned|signed|long|short|struct|enum|union|__declspec\s*\([^)]*\)|__stdcall|__cdecl|CVIFUNC(?:_C)?|CVICALLBACK|[A-Za-z_]\w*)\s+|\*\s*)+)([A-Za-z_]\w*)\s*\(([^;{}]*)\)\s*(?=;|\{)/gm;
  const result: CviSourceSymbol[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked)) !== null) {
    const name = match[3];
    if (['if', 'for', 'while', 'switch', 'return', 'sizeof'].includes(name)) {
      continue;
    }
    const nameOffset = match.index + match[0].lastIndexOf(name);
    const before = source.slice(0, nameOffset);
    const line = before.split('\n').length - 1;
    const lineStart = before.lastIndexOf('\n') + 1;
    const character = nameOffset - lineStart;
    const raw = source.slice(match.index + match[1].length, pattern.lastIndex).trim();
    const signature = raw.replace(/\s+/g, ' ').replace(/\s*\{\s*$/, '').trim();
    result.push({ name, signature, filePath, line, character, kind: vscode.SymbolKind.Function, source: 'fallback' });
  }
  return dedupeSourceSymbols(result);
}

function maskCommentsAndStrings(source: string): string {
  let result = '';
  let state: 'code' | 'line-comment' | 'block-comment' | 'string' | 'char' = 'code';
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (state === 'code') {
      if (current === '/' && next === '/') {
        result += '  '; index += 1; state = 'line-comment'; continue;
      }
      if (current === '/' && next === '*') {
        result += '  '; index += 1; state = 'block-comment'; continue;
      }
      if (current === '"') { result += ' '; state = 'string'; escaped = false; continue; }
      if (current === "'") { result += ' '; state = 'char'; escaped = false; continue; }
      result += current;
      continue;
    }
    if (state === 'line-comment') {
      if (current === '\n') { result += '\n'; state = 'code'; } else { result += ' '; }
      continue;
    }
    if (state === 'block-comment') {
      if (current === '*' && next === '/') { result += '  '; index += 1; state = 'code'; }
      else { result += current === '\n' ? '\n' : ' '; }
      continue;
    }
    result += current === '\n' ? '\n' : ' ';
    if (escaped) { escaped = false; continue; }
    if (current === '\\') { escaped = true; continue; }
    if ((state === 'string' && current === '"') || (state === 'char' && current === "'")) { state = 'code'; }
  }
  return result;
}

function dedupeSourceSymbols(symbols: CviSourceSymbol[]): CviSourceSymbol[] {
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    const key = `${symbol.filePath.toLowerCase()}:${symbol.name.toLowerCase()}:${symbol.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => left.line - right.line || left.name.localeCompare(right.name));
}

function dedupeCompletionSymbols(symbols: CviCompletionSymbol[]): CviCompletionSymbol[] {
  const map = new Map<string, CviCompletionSymbol>();
  for (const symbol of symbols) {
    const key = symbol.name.toLowerCase();
    const current = map.get(key);
    if (!current || (symbol.origin === 'project' && current.origin !== 'project')) {
      map.set(key, symbol);
    }
  }
  return [...map.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function isPathInside(candidate: string, parent: string): boolean {
  const normalizedCandidate = path.resolve(candidate).toLowerCase();
  const normalizedParent = path.resolve(parent).toLowerCase();
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}${path.sep}`);
}

function safeMtime(filePath: string): number {
  try { return fs.statSync(filePath).mtimeMs; } catch { return 0; }
}

export function isSourceOrHeader(filePath: string): boolean {
  return ['.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.hh', '.hxx'].includes(path.extname(filePath).toLowerCase());
}
