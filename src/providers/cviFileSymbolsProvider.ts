import * as path from 'path';
import * as vscode from 'vscode';
import {
  CviSourceSymbol,
  CviSymbolService,
  buildHeaderFromSourceSymbols,
  buildSourceFromSourceSymbols,
  formatSourceSymbolList,
  isSourceOrHeader,
  normalizeSourceSymbolDeclaration
} from '../services/cviSymbolService';

type FileSymbolNode = CviSourceSymbol | { kind: 'placeholder'; label: string };

export class CviFileSymbolsProvider implements vscode.TreeDataProvider<FileSymbolNode> {
  private readonly changeEmitter = new vscode.EventEmitter<FileSymbolNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private selectedFile?: string;
  private view?: vscode.TreeView<FileSymbolNode>;

  constructor(private readonly symbols: CviSymbolService) {}

  attachView(view: vscode.TreeView<FileSymbolNode>): void {
    this.view = view;
    this.updateDescription();
  }

  setSelectedFile(filePath: string | undefined): void {
    const normalized = filePath && isSourceOrHeader(filePath) ? path.normalize(filePath) : undefined;
    if (normalized === this.selectedFile) {
      return;
    }
    this.selectedFile = normalized;
    this.updateDescription();
    this.refresh();
  }

  refresh(): void {
    this.changeEmitter.fire();
  }

  getSelectedFile(): string | undefined {
    return this.selectedFile;
  }

  async currentSymbols(): Promise<CviSourceSymbol[]> {
    return this.selectedFile ? this.symbols.symbolsForFile(this.selectedFile) : [];
  }

  async reveal(symbol: CviSourceSymbol): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(symbol.filePath));
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const position = new vscode.Position(symbol.line, symbol.character);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  async copySymbol(symbol?: CviSourceSymbol): Promise<void> {
    if (!symbol || 'label' in symbol) return;
    await vscode.env.clipboard.writeText(symbol.signature);
    void vscode.window.setStatusBarMessage(`CVI: copied ${symbol.qualifiedName || symbol.name}`, 1800);
  }

  async copySymbolDeclaration(symbol?: CviSourceSymbol): Promise<void> {
    if (!symbol || 'label' in symbol) return;
    const declaration = symbol.declaration || normalizeSourceSymbolDeclaration(symbol.signature);
    await vscode.env.clipboard.writeText(declaration);
    void vscode.window.setStatusBarMessage(`CVI: copied declaration for ${symbol.qualifiedName || symbol.name}`, 1800);
  }

  async copyAllSymbols(asDeclarations = false): Promise<void> {
    if (!this.selectedFile) {
      void vscode.window.showWarningMessage('Select a C/C++ source/header file first.');
      return;
    }
    const symbols = await this.currentSymbols();
    if (!symbols.length) {
      void vscode.window.showWarningMessage('No function/method declaration or definition was detected in the selected file.');
      return;
    }
    const text = asDeclarations
      ? symbols.map((symbol) => symbol.declaration || normalizeSourceSymbolDeclaration(symbol.signature)).join('\n') + '\n'
      : formatSourceSymbolList(symbols, this.selectedFile, 'text');
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage(`Copied ${symbols.length} File Symbol${symbols.length === 1 ? '' : 's'} to the clipboard.`);
  }

  async exportSymbols(): Promise<void> {
    if (!this.selectedFile) {
      void vscode.window.showWarningMessage('Select a C/C++ source/header file first.');
      return;
    }
    const symbols = await this.currentSymbols();
    if (!symbols.length) {
      void vscode.window.showWarningMessage('No function/method declaration or definition was detected in the selected file.');
      return;
    }
    const choice = await vscode.window.showQuickPick([
      { label: 'Markdown report (.md)', value: 'markdown' as const, extension: '.symbols.md' },
      { label: 'Plain text (.txt)', value: 'text' as const, extension: '.symbols.txt' },
      { label: 'JSON (.json)', value: 'json' as const, extension: '.symbols.json' }
    ], { title: 'Export File Symbols' });
    if (!choice) return;
    const source = path.parse(this.selectedFile);
    const target = await vscode.window.showSaveDialog({
      title: 'Export File Symbols',
      defaultUri: vscode.Uri.file(path.join(source.dir, `${source.name}${choice.extension}`)),
      filters: choice.value === 'markdown'
        ? { Markdown: ['md'] }
        : choice.value === 'json' ? { JSON: ['json'] } : { Text: ['txt'] }
    });
    if (!target) return;
    const content = formatSourceSymbolList(symbols, this.selectedFile, choice.value);
    await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
    const action = await vscode.window.showInformationMessage(`Exported ${symbols.length} symbol(s) to ${target.fsPath}.`, 'Open');
    if (action === 'Open') {
      const document = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(document, { preview: false });
    }
  }

  async generateHeader(): Promise<void> {
    if (!this.selectedFile) {
      void vscode.window.showWarningMessage('Select a C/C++ source/header file first.');
      return;
    }
    const symbols = await this.currentSymbols();
    if (!symbols.length) {
      void vscode.window.showWarningMessage('No function/method declaration or definition was detected in the selected file.');
      return;
    }
    const source = path.parse(this.selectedFile);
    const isCpp = ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'].includes(source.ext.toLowerCase());
    const headerExtension = isCpp ? '.hpp' : '.h';
    const target = await vscode.window.showSaveDialog({
      title: 'Generate Header From File Symbols',
      defaultUri: vscode.Uri.file(path.join(source.dir, `${source.name}${headerExtension}`)),
      filters: isCpp ? { 'C++ Header': ['hpp', 'h'] } : { 'C Header': ['h'] }
    });
    if (!target) return;
    const content = buildHeaderFromSourceSymbols(symbols, this.selectedFile);
    await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
    const action = await vscode.window.showInformationMessage(`Generated header from ${symbols.length} detected symbol(s): ${target.fsPath}`, 'Open');
    if (action === 'Open') {
      const document = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(document, { preview: false });
    }
  }

  async generateSource(): Promise<void> {
    if (!this.selectedFile) {
      void vscode.window.showWarningMessage('Select a C/C++ source/header file first.');
      return;
    }
    const symbols = await this.currentSymbols();
    if (!symbols.length) {
      void vscode.window.showWarningMessage('No function/method declaration or definition was detected in the selected file.');
      return;
    }
    const source = path.parse(this.selectedFile);
    const selectedExt = source.ext.toLowerCase();
    const isC = selectedExt === '.c';
    const isHeader = ['.h', '.hh', '.hpp', '.hxx'].includes(selectedExt);
    const sourceExtension = isC ? '.c' : '.cpp';
    const defaultName = isHeader ? `${source.name}${sourceExtension}` : `${source.name}_generated${sourceExtension}`;
    const target = await vscode.window.showSaveDialog({
      title: 'Generate Source From File Symbols',
      defaultUri: vscode.Uri.file(path.join(source.dir, defaultName)),
      filters: isC ? { 'C Source': ['c'] } : { 'C++ Source': ['cpp', 'cc', 'cxx'] }
    });
    if (!target) return;
    const content = buildSourceFromSourceSymbols(symbols, this.selectedFile);
    await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
    const action = await vscode.window.showInformationMessage(`Generated source stubs from ${symbols.length} detected symbol(s): ${target.fsPath}`, 'Open');
    if (action === 'Open') {
      const document = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(document, { preview: false });
    }
  }

  getTreeItem(node: FileSymbolNode): vscode.TreeItem {
    if ('label' in node) {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('info');
      return item;
    }
    const displayName = node.qualifiedName || node.name;
    const item = new vscode.TreeItem(displayName, vscode.TreeItemCollapsibleState.None);
    item.description = `L${node.line + 1}`;
    item.tooltip = `${node.signature}\n${node.filePath}:${node.line + 1}`;
    item.contextValue = 'cviFileSymbol';
    item.iconPath = new vscode.ThemeIcon(
      node.kind === vscode.SymbolKind.Method
        ? 'symbol-method'
        : node.kind === vscode.SymbolKind.Constructor ? 'symbol-constructor' : 'symbol-function'
    );
    item.command = { command: 'labwindowsCvi.revealFileSymbol', title: 'Reveal CVI file symbol', arguments: [node] };
    return item;
  }

  async getChildren(): Promise<FileSymbolNode[]> {
    if (!this.selectedFile) {
      return [{ kind: 'placeholder', label: 'Select a C/C++ source or header file in CVI Workspace.' }];
    }
    const symbols = await this.symbols.symbolsForFile(this.selectedFile);
    return symbols.length > 0 ? symbols : [{ kind: 'placeholder', label: 'No function or method declaration found in the selected file.' }];
  }

  private updateDescription(): void {
    if (this.view) {
      this.view.description = this.selectedFile ? path.basename(this.selectedFile) : 'No file selected';
    }
  }
}
