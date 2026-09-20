import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CviWorkspaceService } from './cviWorkspaceService';

export interface CviSourceSymbol {
  name: string;
  qualifiedName?: string;
  signature: string;
  declaration?: string;
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

    // Keep this view independent from cpptools/LSP document symbols. Some
    // providers report macros or call expressions as symbols. The local scanner
    // below only keeps top-level declarations/definitions and skips matches
    // located inside already-detected function bodies.
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

export function scanCFunctions(source: string, filePath: string): CviSourceSymbol[] {
  const masked = maskCommentsAndStrings(source);
  const functionBodyRanges = [...collectFunctionBodyRanges(masked), ...collectScopedConstructorBodyRanges(masked)];
  const result: CviSourceSymbol[] = [];
  const controlOrStatementPrefixes = /^(?:return|co_return|throw|emit|case|else|do|goto|break|continue|new|delete|using|typedef|static_assert)\b/;

  const pattern = /(^|\n)\s*((?:(?:extern|static|inline|constexpr|consteval|constinit|virtual|explicit|friend|const|volatile|unsigned|signed|long|short|struct|enum|union|typename|auto|CVIFUNC(?:_C)?|CVICALLBACK|__stdcall|__cdecl|__fastcall|WINAPI|CALLBACK|APIENTRY|NTAPI|__declspec\s*\([^)]*\)|[A-Za-z_]\w*)\s+|[*&]\s*)+)(((?:[A-Za-z_]\w*::)*)~?[A-Za-z_]\w*)\s*\(([^;{}]*)\)\s*((?:(?:const|override|final)\b\s*|noexcept(?:\s*\([^)]*\))?\s*|[&]{1,2}\s*)*)(?=;|\{|:|=\s*(?:default|delete))/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked)) !== null) {
    const prefix = match[2].trim();
    const qualifiedName = match[3].trim();
    const name = qualifiedName.split('::').pop() || qualifiedName;
    if (controlOrStatementPrefixes.test(prefix) || ['if', 'for', 'while', 'switch', 'return', 'sizeof', 'catch'].includes(name)) {
      continue;
    }
    const nameOffset = match.index + match[0].lastIndexOf(qualifiedName);
    if (isOffsetInsideRanges(nameOffset, functionBodyRanges)) {
      continue;
    }
    const before = source.slice(0, nameOffset);
    const line = before.split('\n').length - 1;
    const lineStart = before.lastIndexOf('\n') + 1;
    const character = nameOffset - lineStart;
    const raw = source.slice(match.index + match[1].length, pattern.lastIndex).trim();
    const signature = raw.replace(/\s+/g, ' ').replace(/\s*\{\s*$/, '').trim();
    const owner = qualifiedName.includes('::') ? qualifiedName.slice(0, qualifiedName.lastIndexOf('::')) : '';
    const ownerLeaf = owner ? owner.split('::').pop() || owner : '';
    const kind = owner && (name === ownerLeaf || name === `~${ownerLeaf}`)
      ? vscode.SymbolKind.Constructor
      : owner ? vscode.SymbolKind.Method : vscode.SymbolKind.Function;
    result.push({
      name,
      qualifiedName,
      signature,
      declaration: normalizeSourceSymbolDeclaration(signature),
      filePath,
      line,
      character,
      kind,
      source: 'fallback'
    });
  }

  const ctorStartPattern = /(^|\n)\s*((?:[A-Za-z_]\w*::)+~?[A-Za-z_]\w*)\s*\(/gm;
  while ((match = ctorStartPattern.exec(masked)) !== null) {
    const qualifiedName = match[2].trim();
    const parts = qualifiedName.split('::');
    const name = parts[parts.length - 1] || qualifiedName;
    const ownerLeaf = parts.length > 1 ? parts[parts.length - 2] : '';
    if (name.replace(/^~/, '') !== ownerLeaf) continue;
    const openParen = match.index + match[0].lastIndexOf('(');
    const closeParen = findMatchingCloseParen(masked, openParen);
    if (closeParen < 0) continue;
    const following = masked.slice(closeParen + 1, Math.min(masked.length, closeParen + 800));
    if (!/^\s*(?:(?:noexcept(?:\s*\([^)]*\))?|override|final)\s*)*(?:;|\{|:|=\s*(?:default|delete))/.test(following)) continue;
    const nameOffset = match.index + match[0].indexOf(qualifiedName);
    if (isOffsetInsideRanges(nameOffset, functionBodyRanges)) continue;
    const before = source.slice(0, nameOffset);
    const line = before.split('\n').length - 1;
    const lineStart = before.lastIndexOf('\n') + 1;
    const character = nameOffset - lineStart;
    const declarationStart = match.index + match[1].length;
    const raw = source.slice(declarationStart, closeParen + 1).trim();
    const signature = raw.replace(/\s+/g, ' ').trim();
    result.push({
      name,
      qualifiedName,
      signature,
      declaration: normalizeSourceSymbolDeclaration(signature),
      filePath,
      line,
      character,
      kind: vscode.SymbolKind.Constructor,
      source: 'fallback'
    });
  }

  return dedupeSourceSymbols(result);
}

interface SourceOffsetRange {
  start: number;
  end: number;
}

function collectFunctionBodyRanges(masked: string): SourceOffsetRange[] {
  const ranges: SourceOffsetRange[] = [];
  const controlNames = new Set(['if', 'for', 'while', 'switch', 'catch']);
  for (let brace = 0; brace < masked.length; brace += 1) {
    if (masked[brace] !== '{') continue;
    const contextStart = Math.max(
      masked.lastIndexOf(';', brace - 1),
      masked.lastIndexOf('{', brace - 1),
      masked.lastIndexOf('}', brace - 1)
    ) + 1;
    const context = masked.slice(contextStart, brace);
    const closeParenInContext = context.lastIndexOf(')');
    if (closeParenInContext < 0) continue;
    const closeParen = contextStart + closeParenInContext;
    const openParen = findMatchingOpenParen(masked, closeParen);
    if (openParen < 0) continue;
    const beforeParen = masked.slice(contextStart, openParen).trimEnd();
    const nameMatch = /((?:[A-Za-z_]\w*::)*~?[A-Za-z_]\w*)\s*$/.exec(beforeParen);
    if (!nameMatch) continue;
    const leaf = (nameMatch[1].split('::').pop() || nameMatch[1]).replace(/^~/, '');
    if (controlNames.has(leaf)) continue;
    const closingBrace = findMatchingBrace(masked, brace);
    if (closingBrace > brace) {
      ranges.push({ start: brace + 1, end: closingBrace });
    }
  }
  return ranges.sort((a, b) => a.start - b.start || a.end - b.end);
}

function collectScopedConstructorBodyRanges(masked: string): SourceOffsetRange[] {
  const ranges: SourceOffsetRange[] = [];
  const pattern = /(^|\n)\s*((?:[A-Za-z_]\w*::)+~?[A-Za-z_]\w*)\s*\(/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked)) !== null) {
    const qualifiedName = match[2];
    const parts = qualifiedName.split('::');
    const name = parts[parts.length - 1] || '';
    const ownerLeaf = parts.length > 1 ? parts[parts.length - 2] : '';
    if (name.replace(/^~/, '') !== ownerLeaf) continue;
    const openParen = match.index + match[0].lastIndexOf('(');
    const closeParen = findMatchingCloseParen(masked, openParen);
    if (closeParen < 0) continue;
    const bodyBrace = findDefinitionBodyBrace(masked, closeParen + 1);
    if (bodyBrace < 0) continue;
    const closingBrace = findMatchingBrace(masked, bodyBrace);
    if (closingBrace > bodyBrace) ranges.push({ start: bodyBrace + 1, end: closingBrace });
  }
  return ranges;
}

function findDefinitionBodyBrace(text: string, startIndex: number): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let index = startIndex; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === '(') parenDepth += 1;
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === '[') bracketDepth += 1;
    else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (parenDepth === 0 && bracketDepth === 0 && ch === ';') return -1;
    else if (parenDepth === 0 && bracketDepth === 0 && ch === '{') return index;
  }
  return -1;
}

function findMatchingCloseParen(text: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    else if (text[index] === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findMatchingOpenParen(text: string, closeIndex: number): number {
  let depth = 0;
  for (let index = closeIndex; index >= 0; index -= 1) {
    if (text[index] === ')') depth += 1;
    else if (text[index] === '(') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function isOffsetInsideRanges(offset: number, ranges: SourceOffsetRange[]): boolean {
  return ranges.some((range) => offset >= range.start && offset < range.end);
}

export function normalizeSourceSymbolDeclaration(signature: string): string {
  const compact = String(signature || '').replace(/\s+/g, ' ').trim().replace(/\s*\{\s*$/, '').trim();
  if (!compact) return '';
  return compact.endsWith(';') ? compact : `${compact};`;
}

export function formatSourceSymbolList(symbols: CviSourceSymbol[], filePath: string, format: 'text' | 'markdown' | 'json' = 'text'): string {
  const ordered = [...symbols].sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
  if (format === 'json') {
    return JSON.stringify({
      file: filePath,
      symbols: ordered.map((symbol) => ({
        name: symbol.name,
        qualifiedName: symbol.qualifiedName || symbol.name,
        line: symbol.line + 1,
        kind: vscode.SymbolKind[symbol.kind] || 'Function',
        signature: symbol.signature,
        declaration: symbol.declaration || normalizeSourceSymbolDeclaration(symbol.signature)
      }))
    }, null, 2) + '\n';
  }
  if (format === 'markdown') {
    const lines = [`# CVI File Symbols — ${path.basename(filePath)}`, '', `Source: \`${filePath}\``, '', '| Line | Symbol | Declaration |', '| ---: | --- | --- |'];
    for (const symbol of ordered) {
      const declaration = (symbol.declaration || normalizeSourceSymbolDeclaration(symbol.signature)).replace(/\|/g, '\\|');
      lines.push(`| ${symbol.line + 1} | \`${symbol.qualifiedName || symbol.name}\` | \`${declaration.replace(/`/g, '\\`')}\` |`);
    }
    lines.push('');
    return lines.join('\n');
  }
  return ordered.map((symbol) => `L${symbol.line + 1}\t${symbol.qualifiedName || symbol.name}\t${symbol.declaration || normalizeSourceSymbolDeclaration(symbol.signature)}`).join('\n') + (ordered.length ? '\n' : '');
}

export function buildHeaderFromSourceSymbols(symbols: CviSourceSymbol[], sourceFilePath: string): string {
  const isC = path.extname(sourceFilePath).toLowerCase() === '.c';
  const ordered = [...symbols].sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
  const publicDeclarations: string[] = [];
  const internalDeclarations: string[] = [];
  const memberDeclarations: string[] = [];
  const seen = new Set<string>();

  for (const symbol of ordered) {
    const declaration = symbol.declaration || normalizeSourceSymbolDeclaration(symbol.signature);
    if (!declaration || seen.has(declaration)) continue;
    seen.add(declaration);
    const qualified = symbol.qualifiedName || symbol.name;
    if (qualified.includes('::')) {
      memberDeclarations.push(declaration);
    } else if (/^static\b/.test(declaration)) {
      internalDeclarations.push(declaration);
    } else {
      publicDeclarations.push(declaration);
    }
  }

  const lines: string[] = [
    '#pragma once',
    '',
    `// Generated by LabWindows/CVI Project Manager from ${path.basename(sourceFilePath)}.`,
    '// Review generated declarations before using this header as a public API.',
    ''
  ];
  if (isC && publicDeclarations.length) {
    lines.push('#ifdef __cplusplus', 'extern "C" {', '#endif', '');
  }
  if (publicDeclarations.length) {
    lines.push('// Free/public function declarations', ...publicDeclarations, '');
  }
  if (isC && publicDeclarations.length) {
    lines.push('#ifdef __cplusplus', '}', '#endif', '');
  }
  if (internalDeclarations.length) {
    lines.push('// Internal source-file functions are intentionally not declared as active header API:', ...internalDeclarations.map((line) => `// ${line}`), '');
  }
  if (memberDeclarations.length) {
    lines.push('// Scoped member definitions must be copied into their owning class declaration:', ...memberDeclarations.map((line) => `// ${line}`), '');
  }
  if (!publicDeclarations.length && !internalDeclarations.length && !memberDeclarations.length) {
    lines.push('// No function declarations were detected.', '');
  }
  return lines.join('\n');
}

export function buildSourceFromSourceSymbols(symbols: CviSourceSymbol[], sourceFilePath: string): string {
  const sourceExt = path.extname(sourceFilePath).toLowerCase();
  const isC = sourceExt === '.c';
  const ordered = [...symbols].sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
  const seen = new Set<string>();
  const definitions: string[] = [];
  let needsAbort = false;

  for (const symbol of ordered) {
    const declaration = symbol.declaration || normalizeSourceSymbolDeclaration(symbol.signature);
    if (!declaration) continue;
    const definitionSignature = sourceDefinitionSignature(declaration, symbol);
    if (!definitionSignature || seen.has(definitionSignature)) continue;
    seen.add(definitionSignature);

    const bodyKind = sourceDefinitionBodyKind(definitionSignature, symbol);
    const body: string[] = ['{', '    // TODO: implement generated stub.'];
    if (bodyKind === 'abort') {
      needsAbort = true;
      body.push(isC ? '    abort();' : '    std::abort();');
    }
    body.push('}');
    definitions.push(`${definitionSignature}\n${body.join('\n')}`);
  }

  const lines: string[] = [
    `// Generated by LabWindows/CVI Project Manager from File Symbols in ${path.basename(sourceFilePath)}.`,
    '// Review generated stubs before adding them to a build.',
    ''
  ];

  const includes = sourceGeneratorIncludes(sourceFilePath);
  if (needsAbort) {
    const abortInclude = isC ? '#include <stdlib.h>' : '#include <cstdlib>';
    if (!includes.includes(abortInclude)) includes.push(abortInclude);
  }
  if (includes.length) {
    lines.push(...includes, '');
  }

  if (definitions.length) {
    lines.push(...definitions.flatMap((definition, index) => index === 0 ? [definition] : ['', definition]), '');
  } else {
    lines.push('// No function/method symbols were available for source generation.', '');
  }

  if (['.h', '.hh', '.hpp', '.hxx'].includes(sourceExt)) {
    lines.splice(2, 0, '// Note: class ownership may need review for unqualified declarations parsed from headers.');
  }
  return lines.join('\n');
}

function sourceGeneratorIncludes(sourceFilePath: string): string[] {
  const ext = path.extname(sourceFilePath).toLowerCase();
  const headerExtensions = new Set(['.h', '.hh', '.hpp', '.hxx']);
  if (headerExtensions.has(ext)) {
    return [`#include "${path.basename(sourceFilePath)}"`];
  }
  try {
    const source = fs.readFileSync(sourceFilePath, 'utf8');
    const includes: string[] = source.match(/^\s*#\s*include\s*[<"][^>"\r\n]+[>"]\s*$/gm) || [];
    return [...new Set<string>(includes.map((line: string) => line.trim()))];
  } catch {
    return [];
  }
}

function sourceDefinitionSignature(declaration: string, symbol: CviSourceSymbol): string {
  let signature = String(declaration || '').trim().replace(/;\s*$/, '').trim();
  if (!signature) return '';

  signature = signature.replace(/^(?:(?:virtual|explicit|friend)\s+)+/, '');
  if ((symbol.qualifiedName || symbol.name).includes('::')) {
    signature = signature.replace(/^static\s+/, '');
  }

  const qualifiedName = symbol.qualifiedName || symbol.name;
  const nameIndex = signature.lastIndexOf(qualifiedName);
  if (nameIndex < 0) return signature.replace(/\s+(?:override|final)(?=\s|$)/g, '').trim();
  const openParen = signature.indexOf('(', nameIndex + qualifiedName.length);
  if (openParen < 0) return signature.replace(/\s+(?:override|final)(?=\s|$)/g, '').trim();
  const closeParen = findMatchingCloseParen(signature, openParen);
  if (closeParen < 0) return signature.replace(/\s+(?:override|final)(?=\s|$)/g, '').trim();

  const parameters = signature.slice(openParen + 1, closeParen);
  const withoutDefaults = stripParameterDefaultArguments(parameters);
  const suffix = signature.slice(closeParen + 1).replace(/\b(?:override|final)\b/g, '').replace(/\s+/g, ' ').trim();
  const prefix = signature.slice(0, openParen + 1);
  return `${prefix}${withoutDefaults})${suffix ? ` ${suffix}` : ''}`.replace(/\s+$/g, '').trim();
}

function stripParameterDefaultArguments(parameters: string): string {
  const result: string[] = [];
  let current = '';
  let skippingDefault = false;
  let paren = 0, bracket = 0, brace = 0, angle = 0;
  let quote: string | undefined;
  let escaped = false;
  const flush = () => {
    result.push(current.trim());
    current = '';
    skippingDefault = false;
  };
  for (let index = 0; index < parameters.length; index += 1) {
    const ch = parameters[index];
    if (quote) {
      if (!skippingDefault) current += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; if (!skippingDefault) current += ch; continue; }
    if (ch === '(') paren += 1;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '[') bracket += 1;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    else if (ch === '{') brace += 1;
    else if (ch === '}') brace = Math.max(0, brace - 1);
    else if (ch === '<') angle += 1;
    else if (ch === '>' && angle > 0) angle -= 1;

    const topLevel = paren === 0 && bracket === 0 && brace === 0 && angle === 0;
    if (topLevel && ch === '=' && !skippingDefault) { skippingDefault = true; continue; }
    if (topLevel && ch === ',') { flush(); continue; }
    if (!skippingDefault) current += ch;
  }
  if (current.trim() || parameters.trim()) flush();
  return result.join(', ');
}

function sourceDefinitionBodyKind(signature: string, symbol: CviSourceSymbol): 'empty' | 'abort' {
  const qualifiedName = symbol.qualifiedName || symbol.name;
  const leaf = symbol.name.replace(/^~/, '');
  const ownerLeaf = qualifiedName.includes('::')
    ? qualifiedName.slice(0, qualifiedName.lastIndexOf('::')).split('::').pop() || ''
    : '';
  if (symbol.kind === vscode.SymbolKind.Constructor || leaf === ownerLeaf || symbol.name.startsWith('~')) return 'empty';

  const nameIndex = signature.lastIndexOf(qualifiedName);
  if (nameIndex < 0) return 'abort';
  const prefix = signature.slice(0, nameIndex).trim();
  if (/(?:^|\s)void$/.test(prefix)) return 'empty';
  return 'abort';
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
    const key = `${symbol.filePath.toLowerCase()}:${(symbol.qualifiedName || symbol.name).toLowerCase()}:${symbol.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => left.line - right.line || (left.qualifiedName || left.name).localeCompare(right.qualifiedName || right.name));
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
