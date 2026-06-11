import * as path from 'path';
import * as vscode from 'vscode';
import { CviSourceSymbol, CviSymbolService, isSourceOrHeader } from '../services/cviSymbolService';

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

  async reveal(symbol: CviSourceSymbol): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(symbol.filePath));
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const position = new vscode.Position(symbol.line, symbol.character);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  getTreeItem(node: FileSymbolNode): vscode.TreeItem {
    if ('label' in node) {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('info');
      return item;
    }
    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
    item.description = `L${node.line + 1}`;
    item.tooltip = `${node.signature}\n${node.filePath}:${node.line + 1}`;
    item.iconPath = new vscode.ThemeIcon('symbol-function');
    item.command = { command: 'labwindowsCvi.revealFileSymbol', title: 'Reveal CVI file symbol', arguments: [node] };
    return item;
  }

  async getChildren(): Promise<FileSymbolNode[]> {
    if (!this.selectedFile) {
      return [{ kind: 'placeholder', label: 'Select a C or header file in CVI Workspace.' }];
    }
    const symbols = await this.symbols.symbolsForFile(this.selectedFile);
    return symbols.length > 0 ? symbols : [{ kind: 'placeholder', label: 'No function found in the selected file.' }];
  }

  private updateDescription(): void {
    if (this.view) {
      this.view.description = this.selectedFile ? path.basename(this.selectedFile) : 'No file selected';
    }
  }
}
