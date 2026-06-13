import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

interface FpParameter {
  name: string;
  type: string;
  description?: string;
  defaultValue?: string;
}

interface FpFunction {
  name: string;
  returnType: string;
  signature: string;
  insertText: string;
  header?: string;
  environment: string;
  library: string;
  category: string;
  description?: string;
  longDescription?: string;
  parameters: FpParameter[];
  symbolKind: 'function';
}

interface FpQuickPickItem extends vscode.QuickPickItem {
  fn: FpFunction;
}

/**
 * Opens CVI .fp function-panel files without starting the CVI IDE.
 *
 * CVI function-panel resources are binary containers, but current CVI files
 * embed the generated HTML reference pages for their functions. The service
 * extracts function names, prototypes and help text conservatively. When the
 * embedded JC Lib catalog already knows a function, the richer catalog card is
 * used. Otherwise the parsed .fp prototype is passed as a fallback card.
 */
export class CviFunctionPanelService {
  async open(functionPanelPath: string): Promise<void> {
    if (!fs.existsSync(functionPanelPath)) {
      throw new Error(`Function-panel file not found: ${functionPanelPath}`);
    }
    const functions = parseFunctionPanel(functionPanelPath);
    if (!functions.length) {
      void vscode.window.showWarningMessage(`No function prototype could be extracted from ${path.basename(functionPanelPath)}.`);
      return;
    }

    const selected = await vscode.window.showQuickPick<FpQuickPickItem>(
      functions.map((fn) => ({
        label: `$(symbol-method) ${fn.name}`,
        description: fn.returnType,
        detail: fn.signature,
        fn
      })),
      {
        title: `CVI Function Panel — ${path.basename(functionPanelPath)}`,
        placeHolder: 'Select a function to open its prototype and parameters',
        matchOnDescription: true,
        matchOnDetail: true
      }
    );
    if (!selected) {
      return;
    }
    await vscode.commands.executeCommand('labwindowsCvi.library.showFunctionDetailsByName', selected.fn.name, selected.fn);
  }
}

export function parseFunctionPanel(functionPanelPath: string): FpFunction[] {
  const binaryText = fs.readFileSync(functionPanelPath).toString('latin1');
  const panelTitle = firstDecodedMatch(binaryText, /\x00{0,4}([A-Za-z][A-Za-z0-9 _\-\/]+)\x00{2,}/) || path.basename(functionPanelPath, path.extname(functionPanelPath));
  const functions: FpFunction[] = [];
  const seen = new Set<string>();
  const functionPattern = /<h1\s+class=["']function["']>([\s\S]*?)<\/h1>\s*<p\s+class=["']syntax["']>([\s\S]*?)<\/p>([\s\S]*?)(?=<h1\s+class=["']function["']>|$)/gi;
  for (const match of binaryText.matchAll(functionPattern)) {
    const name = cleanHtml(match[1]);
    const signature = cleanHtml(match[2]).replace(/\s+/g, ' ').trim();
    if (!name || !signature || seen.has(name.toLowerCase())) {
      continue;
    }
    seen.add(name.toLowerCase());
    const page = match[3] ?? '';
    const purpose = cleanHtml(firstRawMatch(page, /<h2\s+class=["']purpose["']>Purpose<\/h2>\s*<p[^>]*>([\s\S]*?)<\/p>/i));
    const header = cleanHtml(firstRawMatch(page, /<strong>Include file:<\/strong>\s*<span\s+class=["']Monospace["']>([\s\S]*?)<\/span>/i));
    const parsed = parseSignature(signature, name);
    functions.push({
      name,
      returnType: parsed.returnType,
      signature,
      insertText: `${name}(${parsed.parameters.map((parameter) => parameter.name).join(', ')})`,
      header: header || undefined,
      environment: 'CVI',
      library: panelTitle,
      category: 'Function panel',
      description: purpose || `Function declared by ${path.basename(functionPanelPath)}.`,
      longDescription: purpose || undefined,
      parameters: parsed.parameters,
      symbolKind: 'function'
    });
  }
  return functions;
}

function parseSignature(signature: string, name: string): { returnType: string; parameters: FpParameter[] } {
  const cleaned = signature.replace(/;\s*$/, '').trim();
  const nameIndex = cleaned.indexOf(name);
  const returnType = nameIndex > 0 ? cleaned.slice(0, nameIndex).trim() : 'int';
  const open = cleaned.indexOf('(', nameIndex + name.length);
  const close = cleaned.lastIndexOf(')');
  if (open < 0 || close < open) {
    return { returnType, parameters: [] };
  }
  const parameterText = cleaned.slice(open + 1, close).trim();
  if (!parameterText || parameterText === 'void') {
    return { returnType, parameters: [] };
  }
  const parameters = splitParameters(parameterText).map((raw, index) => parseParameter(raw, index));
  return { returnType, parameters };
}

function splitParameters(value: string): string[] {
  const result: string[] = [];
  let current = '';
  let depth = 0;
  for (const char of value) {
    if (char === '(' || char === '[') depth += 1;
    if (char === ')' || char === ']') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function parseParameter(rawValue: string, index: number): FpParameter {
  const normalized = rawValue.replace(/\.\s*\.\s*\./g, '...').trim();
  if (normalized === '...') {
    return { name: `arg${index + 1}`, type: '...' };
  }
  const match = normalized.match(/([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?$/);
  if (!match) {
    return { name: `arg${index + 1}`, type: normalized || 'int' };
  }
  const name = match[1];
  const type = normalized.slice(0, match.index).trim() || 'int';
  return { name, type };
}

function firstRawMatch(value: string, pattern: RegExp): string {
  return value.match(pattern)?.[1] ?? '';
}

function firstDecodedMatch(value: string, pattern: RegExp): string {
  return decodeEntities(value.match(pattern)?.[1] ?? '').trim();
}

function cleanHtml(value: string): string {
  return decodeEntities(String(value ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' '))
    .trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#8211;|&ndash;/gi, '–')
    .replace(/&#8212;|&mdash;/gi, '—')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCharCode(Number(digits)));
}
