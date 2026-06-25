import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CviInstallationService } from './cviInstallationService';

interface StoredFileTemplate {
  id: string;
  label: string;
  description?: string;
  extension: string;
  content: string;
}

interface StoredSnippet {
  id: string;
  label: string;
  description?: string;
  body: string;
}

interface StoredCollection<T> {
  version: number;
  items: T[];
}

interface PendingFile {
  absolutePath: string;
  contents: string | Buffer;
  binary?: boolean;
}

export interface NewFileGenerationResult {
  files: string[];
  createdFiles: string[];
  primaryPath?: string;
  uirPath?: string;
}

export interface TemplateVariables {
  baseName: string;
  fileName: string;
  headerFile: string;
  guard: string;
  prefix: string;
  uirFile: string;
  date: string;
  year: string;
}

export interface BuiltInSnippet {
  id: string;
  label: string;
  description: string;
  body: string;
}

const FILE_TEMPLATE_STORE = 'file-templates.json';
const SNIPPET_STORE = 'snippets.json';
const TEXT_TEMPLATE_EXTENSIONS = new Set(['.c', '.h', '.cpp', '.hpp', '.txt', '.ini', '.json', '.xml', '.md', '.lua', '.js', '.ts', '.bat', '.cmd', '.ps1']);

function normalizeExtension(extension: string): string {
  const trimmed = String(extension || '').trim();
  if (!trimmed) {
    return '.txt';
  }
  return trimmed.startsWith('.') ? trimmed.toLowerCase() : `.${trimmed.toLowerCase()}`;
}

function sanitizeId(value: string): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'custom';
}

function sanitizePrefix(value: string): string {
  let prefix = String(value || '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  if (!prefix) {
    prefix = 'CVI_MODULE';
  }
  if (/^[0-9]/.test(prefix)) {
    prefix = `_${prefix}`;
  }
  return prefix;
}

function toCrlf(value: string): string {
  return String(value || '').replace(/\r?\n/g, '\r\n');
}

export function headerGuardForPath(filePath: string): string {
  const withoutExtension = path.basename(filePath, path.extname(filePath));
  return `${sanitizePrefix(withoutExtension)}_H`;
}

export function renderTemplateText(template: string, variables: TemplateVariables): string {
  return String(template || '').replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_match, key: string) => {
    const value = variables[key as keyof TemplateVariables];
    return value === undefined ? `{{${key}}}` : String(value);
  });
}

export function resolveUirTemplateVersion(preference: string, installationRoot?: string): 'cvi2012' | 'cvi2020' {
  const normalizedPreference = String(preference || 'auto').toLowerCase();
  if (normalizedPreference === 'cvi2020') {
    return 'cvi2020';
  }
  if (normalizedPreference === 'cvi2012') {
    return 'cvi2012';
  }
  const root = String(installationRoot || '');
  const year = root.match(/(?:CVI|LabWindows[^0-9]*)(20\d{2})/i)?.[1];
  return year && Number(year) >= 2020 ? 'cvi2020' : 'cvi2012';
}

const GUARDED_HEADER_TEMPLATE = `#ifndef {{guard}}
#define {{guard}}

#ifdef __cplusplus
extern "C" {
#endif

/* Public declarations for {{baseName}}. */

#ifdef __cplusplus
}
#endif

#endif /* {{guard}} */
`;

const MODULE_SOURCE_TEMPLATE = `#include "{{headerFile}}"

/* Add the implementation of {{baseName}} here. */
`;

const MAIN_TEMPLATE = `#include <cvirte.h>

int main (int argc, char *argv[])
{
    if (InitCVIRTE (0, argv, 0) == 0)
        return -1;    /* out of memory */

    /* application code */

    CloseCVIRTE ();
    return 0;
}
`;

const WINMAIN_TEMPLATE = `#include <windows.h>
#include <cvirte.h>

int __stdcall WinMain (HINSTANCE hInstance, HINSTANCE hPrevInstance,
                       LPSTR lpszCmdLine, int nCmdShow)
{
    (void)hPrevInstance;
    (void)lpszCmdLine;
    (void)nCmdShow;

    if (InitCVIRTE (hInstance, 0, 0) == 0)
        return -1;    /* out of memory */

    /* application code */

    CloseCVIRTE ();
    return 0;
}
`;

const RTMAIN_TEMPLATE = `#include <windows.h>
#include <cvirte.h>
#include <rtutil.h>

void CVIFUNC_C RTmain (void)
{
    if (InitCVIRTE (0, 0, 0) == 0)
        return;    /* out of memory */

    /* initialization code */

    while (!RTIsShuttingDown ())
    {
        /* periodic code */
        Sleep (100);
    }

    /* cleanup code */
    CloseCVIRTE ();
}
`;

const DLL_HEADER_TEMPLATE = `#ifndef {{guard}}
#define {{guard}}

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32)
#  if defined({{prefix}}_EXPORTS)
#    define {{prefix}}_API __declspec(dllexport)
#  else
#    define {{prefix}}_API __declspec(dllimport)
#  endif
#else
#  define {{prefix}}_API
#endif

/* Add exported declarations here. Example:
 * {{prefix}}_API int {{baseName}}_Initialize (void);
 */

#ifdef __cplusplus
}
#endif

#endif /* {{guard}} */
`;

const DLL_SOURCE_TEMPLATE = `#include <windows.h>
#include <cvirte.h>
#include "{{headerFile}}"

BOOL WINAPI DllMain (HINSTANCE hinstDLL, DWORD fdwReason, LPVOID lpvReserved)
{
    (void)lpvReserved;

    switch (fdwReason)
    {
        case DLL_PROCESS_ATTACH:
            if (InitCVIRTE (hinstDLL, 0, 0) == 0)
                return FALSE;    /* out of memory */
            break;

        case DLL_PROCESS_DETACH:
            if (!CVIRTEHasBeenDetached ())
                CloseCVIRTE ();
            break;
    }

    return TRUE;
}
`;

const UI_APP_SOURCE_TEMPLATE = `//==============================================================================
//
// Title:       {{baseName}}
// Purpose:     CVI user-interface application starter.
//
// Generated on: {{date}}
//
//==============================================================================

#include <cvirte.h>
#include <userint.h>
#include "{{headerFile}}"

static int panelHandle = 0;

int CVICALLBACK panelCB (int panel, int event, void *callbackData,
                         int eventData1, int eventData2);

int main (int argc, char *argv[])
{
    int status = 0;

    if (InitCVIRTE (0, argv, 0) == 0)
        return -1;

    panelHandle = LoadPanel (0, "{{uirFile}}", PANEL);
    if (panelHandle < 0)
    {
        status = -2;
        goto Cleanup;
    }

    DisplayPanel (panelHandle);
    RunUserInterface ();

Cleanup:
    if (panelHandle > 0)
        DiscardPanel (panelHandle);
    CloseCVIRTE ();
    return status;
}

int CVICALLBACK panelCB (int panel, int event, void *callbackData,
                         int eventData1, int eventData2)
{
    (void)panel;
    (void)callbackData;
    (void)eventData1;
    (void)eventData2;

    if (event == EVENT_CLOSE)
        QuitUserInterface (0);

    return 0;
}
`;

const ERROR_HEADER_TEMPLATE = `#ifndef {{guard}}
#define {{guard}}

#ifdef __cplusplus
extern "C" {
#endif

#include <stddef.h>

#define CVI_ERROR_LOG_PATH_SIZE 1024
#define CVI_ERROR_MAX_LOG_LINES 1000

extern int g_cviErrorCode;

void CviError_SetLogFile (const char *filePath);
void CviError_Log (const char *format, ...);
void CviError_Report (int code, const char *message, const char *file,
                      int line, const char *functionName);

#if defined(_MSC_VER) || defined(__CVI__)
#  define CVI_ERROR_FUNCTION __FUNCTION__
#else
#  define CVI_ERROR_FUNCTION __func__
#endif

#define CVI_ERROR_GOTO(code, message, label) \\
    do { \\
        int cviErrorCodeLocal = (code); \\
        if (cviErrorCodeLocal < 0) { \\
            g_cviErrorCode = cviErrorCodeLocal; \\
            CviError_Report (cviErrorCodeLocal, (message), __FILE__, __LINE__, CVI_ERROR_FUNCTION); \\
            goto label; \\
        } \\
    } while (0)

#define CVI_CHECK_GOTO(expression, label) \\
    CVI_ERROR_GOTO ((expression), #expression, label)

#define CVI_CHECK_PTR_GOTO(pointer, label) \\
    do { \\
        if ((pointer) == NULL) { \\
            g_cviErrorCode = -999; \\
            CviError_Report (g_cviErrorCode, "NULL pointer: " #pointer, __FILE__, __LINE__, CVI_ERROR_FUNCTION); \\
            goto label; \\
        } \\
    } while (0)

#ifdef __cplusplus
}
#endif

#endif /* {{guard}} */
`;

const ERROR_SOURCE_TEMPLATE = `#include "{{headerFile}}"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

static char cviErrorLogPath[CVI_ERROR_LOG_PATH_SIZE] = "";
int g_cviErrorCode = 0;

static void CviError_TrimLogIfNeeded (void)
{
    FILE *file;
    char line[512];
    int lineCount = 0;

    if (cviErrorLogPath[0] == '\\0')
        return;

    file = fopen (cviErrorLogPath, "r");
    if (file == NULL)
        return;

    while (fgets (line, sizeof (line), file) != NULL)
        ++lineCount;
    fclose (file);

    if (lineCount > CVI_ERROR_MAX_LOG_LINES)
    {
        file = fopen (cviErrorLogPath, "w");
        if (file != NULL)
            fclose (file);
    }
}

void CviError_SetLogFile (const char *filePath)
{
    if (filePath == NULL)
    {
        cviErrorLogPath[0] = '\\0';
        return;
    }

    strncpy (cviErrorLogPath, filePath, sizeof (cviErrorLogPath) - 1);
    cviErrorLogPath[sizeof (cviErrorLogPath) - 1] = '\\0';
}

void CviError_Log (const char *format, ...)
{
    char message[2048];
    FILE *file;
    va_list args;

    va_start (args, format);
    vsnprintf (message, sizeof (message), format, args);
    va_end (args);
    message[sizeof (message) - 1] = '\\0';

    if (cviErrorLogPath[0] != '\\0')
    {
        CviError_TrimLogIfNeeded ();
        file = fopen (cviErrorLogPath, "a");
        if (file != NULL)
        {
            fputs (message, file);
            fflush (file);
            fclose (file);
        }
    }

    fputs (message, stdout);
}

void CviError_Report (int code, const char *message, const char *file,
                      int line, const char *functionName)
{
    time_t now = time (NULL);
    const char *timestamp = ctime (&now);

    CviError_Log ("*** CVI ERROR ***\\n"
                  "Code: %d\\n"
                  "Message: %s\\n"
                  "File: %s\\n"
                  "Line: %d\\n"
                  "Function: %s\\n"
                  "Time: %s\\n",
                  code,
                  message != NULL ? message : "(none)",
                  file != NULL ? file : "(unknown)",
                  line,
                  functionName != NULL ? functionName : "(unknown)",
                  timestamp != NULL ? timestamp : "(unknown)\\n");
}
`;

function buildBlankUirHeader(): string {
  return `/**************************************************************************/
/* LabWindows/CVI User Interface Resource (UIR) Include File              */
/*                                                                        */
/* WARNING: Do not add to, delete from, or otherwise modify the contents  */
/*          of this include file.                                         */
/**************************************************************************/

#include <userint.h>

#ifdef __cplusplus
    extern "C" {
#endif

     /* Panels and Controls: */

#define  PANEL                            1


     /* Control Arrays: */

          /* (no control arrays in the resource file) */


     /* Menu Bars, Menus, and Menu Items: */

          /* (no menu bars in the resource file) */


     /* (no callbacks specified in the resource file) */


#ifdef __cplusplus
    }
#endif
`;
}

export function getBuiltInSnippets(): BuiltInSnippet[] {
  return [
    {
      id: 'cvi-main',
      label: 'CVI main entry point',
      description: 'Initialize and close the CVI Run-Time Engine from main().',
      body: MAIN_TEMPLATE
    },
    {
      id: 'cvi-winmain',
      label: 'CVI WinMain entry point',
      description: 'Windows GUI application entry point with InitCVIRTE().',
      body: WINMAIN_TEMPLATE
    },
    {
      id: 'cvi-rtmain',
      label: 'CVI RTmain entry point',
      description: 'Real-Time loop starter with RTIsShuttingDown().',
      body: RTMAIN_TEMPLATE
    },
    {
      id: 'cvi-dllmain',
      label: 'CVI DllMain lifecycle',
      description: 'Initialize CVIRTE on DLL attach and close it on detach.',
      body: DLL_SOURCE_TEMPLATE.replace('#include "{{headerFile}}"\n', '')
    },
    {
      id: 'cvi-panel-callback',
      label: 'Panel callback',
      description: 'Panel callback skeleton handling EVENT_CLOSE.',
      body: `int CVICALLBACK \${1:panelCB} (int panel, int event, void *callbackData,\n                         int eventData1, int eventData2)\n{\n    (void)panel;\n    (void)callbackData;\n    (void)eventData1;\n    (void)eventData2;\n\n    if (event == EVENT_CLOSE)\n        QuitUserInterface (0);\n\n    return 0;\n}\n`
    },
    {
      id: 'cvi-control-callback',
      label: 'Control callback',
      description: 'Control callback skeleton handling EVENT_COMMIT.',
      body: `int CVICALLBACK \${1:controlCB} (int panel, int control, int event,\n                           void *callbackData, int eventData1, int eventData2)\n{\n    (void)panel;\n    (void)control;\n    (void)callbackData;\n    (void)eventData1;\n    (void)eventData2;\n\n    if (event == EVENT_COMMIT)\n    {\n        \${0:/* handle commit */}\n    }\n\n    return 0;\n}\n`
    },
    {
      id: 'cvi-load-panel-run-ui',
      label: 'Load panel and run UI',
      description: 'Load, display, run and discard a CVI panel.',
      body: `panelHandle = LoadPanel (0, "\${1:interface.uir}", \${2:PANEL});\nif (panelHandle < 0)\n    goto Cleanup;\n\nDisplayPanel (panelHandle);\nRunUserInterface ();\n\nCleanup:\nif (panelHandle > 0)\n    DiscardPanel (panelHandle);\n`
    },
    {
      id: 'cvi-error-check-goto',
      label: 'Error check with cleanup label',
      description: 'Check a negative CVI status and branch to cleanup.',
      body: `status = \${1:CviFunctionCall ()};\nif (status < 0)\n    goto Cleanup;\n`
    },
    {
      id: 'cvi-set-control-attribute',
      label: 'SetCtrlAttribute call',
      description: 'Parameterized control attribute update.',
      body: `SetCtrlAttribute (\${1:panel}, \${2:control}, \${3:ATTR_VISIBLE}, \${4:1});`
    }
  ];
}

export class CviTemplateService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly installations: CviInstallationService,
    private readonly output: vscode.OutputChannel
  ) {}

  async generateNewFiles(projectDirectory: string): Promise<NewFileGenerationResult | undefined> {
    const userTemplates = this.loadFileTemplates();
    const choices: Array<vscode.QuickPickItem & { value: string }> = [
      { label: 'C source file', description: 'Create an empty source or choose a CVI entry-point template', value: 'c-source' },
      { label: 'C header file', description: 'Create an empty guarded header or use a saved template', value: 'c-header' },
      { label: 'C module (.c + .h)', description: 'Create a paired implementation file and guarded header', value: 'c-module' },
      { label: 'CVI user-interface resource (.uir + .h)', description: 'Create a blank panel resource and its generated-style include file', value: 'uir' },
      { label: 'CVI UI application starter (.c + .uir + .h)', description: 'Create a panel resource and a complete LoadPanel / RunUserInterface baseline', value: 'ui-app' },
      { label: 'CVI DLL starter (.c + .h)', description: 'Create DllMain with the CVIRTE attach / detach lifecycle', value: 'dll' },
      { label: 'CVI error-management module (.c + .h)', description: 'Create a cleaned generic logger and goto-based error-check helpers', value: 'error-module' },
      { label: 'Text file', description: 'Create an empty .txt file', value: 'text' }
    ];
    if (userTemplates.length > 0) {
      choices.push({ label: 'Saved user template...', description: 'Create a file from one of your reusable examples', value: 'user-template' });
    }

    const selected = await vscode.window.showQuickPick(choices, { title: 'Create a new LabWindows/CVI file or starter module' });
    if (!selected) {
      return undefined;
    }

    switch (selected.value) {
      case 'c-source': return this.generateCSource(projectDirectory);
      case 'c-header': return this.generateHeader(projectDirectory);
      case 'c-module': return this.generateModulePair(projectDirectory);
      case 'uir': return this.generateUir(projectDirectory, false);
      case 'ui-app': return this.generateUir(projectDirectory, true);
      case 'dll': return this.generateDll(projectDirectory);
      case 'error-module': return this.generateErrorModule(projectDirectory);
      case 'text': return this.generateSingleTextFile(projectDirectory, '.txt', 'new_file', '', 'Text file');
      case 'user-template': return this.generateUserTemplate(projectDirectory, userTemplates);
      default: return undefined;
    }
  }

  async insertSnippet(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('Open a source file before inserting a CVI snippet.');
      return;
    }

    const builtIns = getBuiltInSnippets();
    const userSnippets = this.loadSnippets();
    const items: Array<vscode.QuickPickItem & { body: string }> = [
      ...builtIns.map((snippet) => ({ label: snippet.label, description: snippet.description, detail: 'Built-in CVI snippet', body: snippet.body })),
      ...userSnippets.map((snippet) => ({ label: snippet.label, description: snippet.description || '', detail: 'Saved user snippet', body: snippet.body }))
    ];
    const selected = await vscode.window.showQuickPick(items, {
      title: 'Insert CVI snippet',
      placeHolder: 'Select a reusable code fragment to insert at the current cursor position',
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (!selected) {
      return;
    }
    await editor.insertSnippet(new vscode.SnippetString(selected.body));
  }

  async saveSelectionAsSnippet(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('Open a source file before saving a snippet.');
      return;
    }
    const selectedText = editor.document.getText(editor.selection);
    const body = selectedText || editor.document.getText();
    if (!body.trim()) {
      vscode.window.showErrorMessage('The current selection or document is empty.');
      return;
    }
    const label = await vscode.window.showInputBox({
      title: 'Save CVI snippet',
      prompt: 'Name displayed in the snippet picker',
      validateInput: validateRequiredName
    });
    if (!label) {
      return;
    }
    const description = await vscode.window.showInputBox({
      title: 'Save CVI snippet',
      prompt: 'Optional description',
      value: ''
    });
    if (description === undefined) {
      return;
    }
    const snippets = this.loadSnippets();
    snippets.push({ id: `${sanitizeId(label)}-${Date.now()}`, label, description, body });
    this.saveSnippets(snippets);
    vscode.window.showInformationMessage(`Saved CVI snippet: ${label}`);
  }

  async manageSnippets(): Promise<void> {
    const snippets = this.loadSnippets();
    const selected = await vscode.window.showQuickPick([
      { label: 'Save current selection as snippet...', value: 'save' },
      { label: 'Import snippet from text file...', value: 'import' },
      { label: 'Delete a saved snippet...', value: 'delete', description: `${snippets.length} saved snippet(s)` },
      { label: 'Open saved snippets JSON', value: 'open' }
    ], { title: 'Manage CVI snippets' });
    if (!selected) {
      return;
    }
    if (selected.value === 'save') {
      await this.saveSelectionAsSnippet();
      return;
    }
    if (selected.value === 'import') {
      const files = await vscode.window.showOpenDialog({ title: 'Import a snippet text file', canSelectFiles: true, canSelectFolders: false, canSelectMany: false });
      if (!files?.[0]) {
        return;
      }
      await this.saveTextAsSnippet(path.basename(files[0].fsPath, path.extname(files[0].fsPath)), fs.readFileSync(files[0].fsPath, 'utf8'));
      return;
    }
    if (selected.value === 'delete') {
      const item = await vscode.window.showQuickPick(snippets.map((snippet) => ({ label: snippet.label, description: snippet.description, snippet })), { title: 'Delete a saved CVI snippet' });
      if (!item) {
        return;
      }
      this.saveSnippets(snippets.filter((snippet) => snippet.id !== item.snippet.id));
      vscode.window.showInformationMessage(`Deleted CVI snippet: ${item.snippet.label}`);
      return;
    }
    await this.openJsonStore(this.getSnippetStorePath(), { version: 1, items: snippets });
  }

  async saveCurrentFileAsTemplate(filePath?: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const resolvedPath = filePath || editor?.document.uri.fsPath;
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
      vscode.window.showErrorMessage('Open or select a text file before saving a creation template.');
      return;
    }
    const activeContents = editor && path.normalize(editor.document.uri.fsPath) === path.normalize(resolvedPath)
      ? editor.document.getText()
      : undefined;
    await this.saveTemplateFromPath(resolvedPath, activeContents);
  }

  async importFileTemplate(): Promise<void> {
    const files = await vscode.window.showOpenDialog({ title: 'Import a reusable file template', canSelectFiles: true, canSelectFolders: false, canSelectMany: false });
    if (!files?.[0]) {
      return;
    }
    await this.saveTemplateFromPath(files[0].fsPath);
  }

  async manageFileTemplates(): Promise<void> {
    const templates = this.loadFileTemplates();
    const selected = await vscode.window.showQuickPick([
      { label: 'Save current file as template...', value: 'save' },
      { label: 'Import template from file...', value: 'import' },
      { label: 'Delete a saved template...', value: 'delete', description: `${templates.length} saved template(s)` },
      { label: 'Open saved templates JSON', value: 'open' }
    ], { title: 'Manage CVI creation templates' });
    if (!selected) {
      return;
    }
    if (selected.value === 'save') {
      await this.saveCurrentFileAsTemplate();
      return;
    }
    if (selected.value === 'import') {
      await this.importFileTemplate();
      return;
    }
    if (selected.value === 'delete') {
      const item = await vscode.window.showQuickPick(templates.map((template) => ({ label: template.label, description: `${template.extension} · ${template.description || ''}`, template })), { title: 'Delete a saved creation template' });
      if (!item) {
        return;
      }
      this.saveFileTemplates(templates.filter((template) => template.id !== item.template.id));
      vscode.window.showInformationMessage(`Deleted creation template: ${item.template.label}`);
      return;
    }
    await this.openJsonStore(this.getFileTemplateStorePath(), { version: 1, items: templates });
  }

  private async generateCSource(projectDirectory: string): Promise<NewFileGenerationResult | undefined> {
    const choice = await vscode.window.showQuickPick([
      { label: 'Empty C source', value: 'empty', description: 'Create a blank .c file' },
      { label: 'main()', value: 'main', description: 'CVI Run-Time Engine lifecycle for a standard executable' },
      { label: 'WinMain()', value: 'winmain', description: 'Windows GUI executable entry point' },
      { label: 'RTmain()', value: 'rtmain', description: 'LabWindows/CVI Real-Time entry point' }
    ], { title: 'Select a C source template' });
    if (!choice) {
      return undefined;
    }
    const content = choice.value === 'main' ? MAIN_TEMPLATE : choice.value === 'winmain' ? WINMAIN_TEMPLATE : choice.value === 'rtmain' ? RTMAIN_TEMPLATE : '';
    const suggested = choice.value === 'main' ? 'main' : choice.value === 'winmain' ? 'winmain' : choice.value === 'rtmain' ? 'rtmain' : 'new_file';
    return this.generateSingleTextFile(projectDirectory, '.c', suggested, content, 'C source file');
  }

  private async generateHeader(projectDirectory: string): Promise<NewFileGenerationResult | undefined> {
    const target = await this.askTargetPath(projectDirectory, '.h', 'new_header', 'C header file');
    if (!target) {
      return undefined;
    }
    const variables = this.createVariables(target, target, undefined);
    return this.writeFiles([{ absolutePath: target, contents: toCrlf(renderTemplateText(GUARDED_HEADER_TEMPLATE, variables)) }], target);
  }

  private async generateModulePair(projectDirectory: string): Promise<NewFileGenerationResult | undefined> {
    const sourcePath = await this.askTargetPath(projectDirectory, '.c', 'new_module', 'C module implementation');
    if (!sourcePath) {
      return undefined;
    }
    const base = sourcePath.slice(0, -path.extname(sourcePath).length);
    const headerPath = `${base}.h`;
    const variables = this.createVariables(sourcePath, headerPath, undefined);
    return this.writeFiles([
      { absolutePath: sourcePath, contents: toCrlf(renderTemplateText(MODULE_SOURCE_TEMPLATE, variables)) },
      { absolutePath: headerPath, contents: toCrlf(renderTemplateText(GUARDED_HEADER_TEMPLATE, variables)) }
    ], sourcePath);
  }

  private async generateUir(projectDirectory: string, includeApplicationSource: boolean): Promise<NewFileGenerationResult | undefined> {
    const uirPath = await this.askTargetPath(projectDirectory, '.uir', includeApplicationSource ? 'interface' : 'new_panel', 'CVI user-interface resource');
    if (!uirPath) {
      return undefined;
    }
    const base = uirPath.slice(0, -path.extname(uirPath).length);
    const headerPath = `${base}.h`;
    const sourcePath = `${base}.c`;
    const variables = this.createVariables(sourcePath, headerPath, uirPath);
    const binary = this.readBundledUirTemplate();
    const files: PendingFile[] = [
      { absolutePath: uirPath, contents: binary, binary: true },
      { absolutePath: headerPath, contents: toCrlf(buildBlankUirHeader()) }
    ];
    if (includeApplicationSource) {
      files.unshift({ absolutePath: sourcePath, contents: toCrlf(renderTemplateText(UI_APP_SOURCE_TEMPLATE, variables)) });
    }
    return this.writeFiles(files, includeApplicationSource ? sourcePath : headerPath, uirPath);
  }

  private async generateDll(projectDirectory: string): Promise<NewFileGenerationResult | undefined> {
    const sourcePath = await this.askTargetPath(projectDirectory, '.c', 'my_dll', 'CVI DLL source file');
    if (!sourcePath) {
      return undefined;
    }
    const base = sourcePath.slice(0, -path.extname(sourcePath).length);
    const headerPath = `${base}.h`;
    const variables = this.createVariables(sourcePath, headerPath, undefined);
    return this.writeFiles([
      { absolutePath: sourcePath, contents: toCrlf(renderTemplateText(DLL_SOURCE_TEMPLATE, variables)) },
      { absolutePath: headerPath, contents: toCrlf(renderTemplateText(DLL_HEADER_TEMPLATE, variables)) }
    ], sourcePath);
  }

  private async generateErrorModule(projectDirectory: string): Promise<NewFileGenerationResult | undefined> {
    const sourcePath = await this.askTargetPath(projectDirectory, '.c', 'cvi_error', 'CVI error-management source file');
    if (!sourcePath) {
      return undefined;
    }
    const base = sourcePath.slice(0, -path.extname(sourcePath).length);
    const headerPath = `${base}.h`;
    const variables = this.createVariables(sourcePath, headerPath, undefined);
    return this.writeFiles([
      { absolutePath: sourcePath, contents: toCrlf(renderTemplateText(ERROR_SOURCE_TEMPLATE, variables)) },
      { absolutePath: headerPath, contents: toCrlf(renderTemplateText(ERROR_HEADER_TEMPLATE, variables)) }
    ], sourcePath);
  }

  private async generateSingleTextFile(projectDirectory: string, extension: string, suggestedBaseName: string, template: string, title: string): Promise<NewFileGenerationResult | undefined> {
    const target = await this.askTargetPath(projectDirectory, extension, suggestedBaseName, title);
    if (!target) {
      return undefined;
    }
    const variables = this.createVariables(target, target, undefined);
    return this.writeFiles([{ absolutePath: target, contents: toCrlf(renderTemplateText(template, variables)) }], target);
  }

  private async generateUserTemplate(projectDirectory: string, templates: StoredFileTemplate[]): Promise<NewFileGenerationResult | undefined> {
    const selected = await vscode.window.showQuickPick(templates.map((template) => ({
      label: template.label,
      description: `${template.extension} · ${template.description || ''}`,
      template
    })), { title: 'Select a saved creation template' });
    if (!selected) {
      return undefined;
    }
    const target = await this.askTargetPath(projectDirectory, selected.template.extension, `new_${sanitizeId(selected.template.label).replace(/-/g, '_')}`, selected.template.label);
    if (!target) {
      return undefined;
    }
    const variables = this.createVariables(target, target, undefined);
    return this.writeFiles([{ absolutePath: target, contents: toCrlf(renderTemplateText(selected.template.content, variables)) }], target);
  }

  private async askTargetPath(projectDirectory: string, extension: string, suggestedBaseName: string, title: string): Promise<string | undefined> {
    const normalizedExtension = normalizeExtension(extension);
    const uri = await vscode.window.showSaveDialog({
      title: `Create ${title}`,
      defaultUri: vscode.Uri.file(path.join(projectDirectory, `${suggestedBaseName}${normalizedExtension}`)),
      filters: { [title]: [normalizedExtension.slice(1)] }
    });
    if (!uri) {
      return undefined;
    }
    return path.extname(uri.fsPath) ? uri.fsPath : `${uri.fsPath}${normalizedExtension}`;
  }

  private async writeFiles(files: PendingFile[], primaryPath?: string, uirPath?: string): Promise<NewFileGenerationResult | undefined> {
    const existing = files.filter((file) => fs.existsSync(file.absolutePath));
    let overwrite = false;
    if (existing.length > 0) {
      const names = existing.map((file) => path.basename(file.absolutePath)).join(', ');
      const action = await vscode.window.showWarningMessage(
        `${names} already exist. Choose whether to preserve them or overwrite them with the selected CVI template.`,
        { modal: true },
        'Keep existing and add references',
        'Overwrite generated files'
      );
      if (!action) {
        return undefined;
      }
      overwrite = action === 'Overwrite generated files';
    }

    const createdFiles: string[] = [];
    for (const file of files) {
      if (fs.existsSync(file.absolutePath) && !overwrite) {
        continue;
      }
      fs.mkdirSync(path.dirname(file.absolutePath), { recursive: true });
      fs.writeFileSync(file.absolutePath, file.contents, file.binary ? undefined : 'utf8');
      createdFiles.push(file.absolutePath);
      this.output.appendLine(`[CVI Templates] Wrote ${file.absolutePath}`);
    }
    return { files: files.map((file) => file.absolutePath), createdFiles, primaryPath, uirPath };
  }

  private readBundledUirTemplate(): Buffer {
    const preference = vscode.workspace.getConfiguration('labwindowsCvi').get<string>('uirTemplateVersion', 'auto');
    const installation = this.installations.getActiveInstallation();
    const version = resolveUirTemplateVersion(preference, installation?.root);
    const filePath = path.join(this.context.extensionPath, 'data', 'templates', `blank-${version}.uir`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Bundled ${version} UIR template not found: ${filePath}`);
    }
    this.output.appendLine(`[CVI Templates] Using ${version} blank UIR template.`);
    return fs.readFileSync(filePath);
  }

  private createVariables(filePath: string, headerPath: string, uirPath?: string): TemplateVariables {
    const baseName = path.basename(filePath, path.extname(filePath));
    const now = new Date();
    return {
      baseName,
      fileName: path.basename(filePath),
      headerFile: path.basename(headerPath),
      guard: headerGuardForPath(headerPath),
      prefix: sanitizePrefix(baseName),
      uirFile: path.basename(uirPath || `${baseName}.uir`),
      date: now.toISOString().slice(0, 10),
      year: String(now.getFullYear())
    };
  }

  private getStorageDirectory(): string {
    const directory = path.join(this.context.globalStorageUri.fsPath, 'templates');
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  }

  private getFileTemplateStorePath(): string {
    return path.join(this.getStorageDirectory(), FILE_TEMPLATE_STORE);
  }

  private getSnippetStorePath(): string {
    return path.join(this.getStorageDirectory(), SNIPPET_STORE);
  }

  private loadFileTemplates(): StoredFileTemplate[] {
    return this.readCollection<StoredFileTemplate>(this.getFileTemplateStorePath());
  }

  private saveFileTemplates(items: StoredFileTemplate[]): void {
    this.writeCollection(this.getFileTemplateStorePath(), items);
  }

  private loadSnippets(): StoredSnippet[] {
    return this.readCollection<StoredSnippet>(this.getSnippetStorePath());
  }

  private saveSnippets(items: StoredSnippet[]): void {
    this.writeCollection(this.getSnippetStorePath(), items);
  }

  private readCollection<T>(filePath: string): T[] {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as StoredCollection<T> | T[];
      return Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [];
    } catch (error) {
      this.output.appendLine(`[CVI Templates] Cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private writeCollection<T>(filePath: string, items: T[]): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify({ version: 1, items }, null, 2)}\n`, 'utf8');
  }

  private async saveTemplateFromPath(filePath: string, suppliedContents?: string): Promise<void> {
    const extension = normalizeExtension(path.extname(filePath));
    if (!TEXT_TEMPLATE_EXTENSIONS.has(extension)) {
      vscode.window.showErrorMessage(`The ${extension} file type is not handled as a text creation template.`);
      return;
    }
    const label = await vscode.window.showInputBox({
      title: 'Save creation template',
      prompt: 'Name displayed when creating a new CVI file',
      value: path.basename(filePath),
      validateInput: validateRequiredName
    });
    if (!label) {
      return;
    }
    const description = await vscode.window.showInputBox({ title: 'Save creation template', prompt: 'Optional description', value: '' });
    if (description === undefined) {
      return;
    }
    const templates = this.loadFileTemplates();
    templates.push({ id: `${sanitizeId(label)}-${Date.now()}`, label, description, extension, content: suppliedContents ?? fs.readFileSync(filePath, 'utf8') });
    this.saveFileTemplates(templates);
    vscode.window.showInformationMessage(`Saved creation template: ${label}`);
  }

  private async saveTextAsSnippet(defaultLabel: string, body: string): Promise<void> {
    const label = await vscode.window.showInputBox({ title: 'Import CVI snippet', prompt: 'Name displayed in the snippet picker', value: defaultLabel, validateInput: validateRequiredName });
    if (!label) {
      return;
    }
    const snippets = this.loadSnippets();
    snippets.push({ id: `${sanitizeId(label)}-${Date.now()}`, label, body });
    this.saveSnippets(snippets);
    vscode.window.showInformationMessage(`Imported CVI snippet: ${label}`);
  }

  private async openJsonStore<T>(filePath: string, initial: StoredCollection<T>): Promise<void> {
    if (!fs.existsSync(filePath)) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(initial, null, 2)}\n`, 'utf8');
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(document, { preview: false });
  }
}

function validateRequiredName(value: string): string | undefined {
  return value.trim() ? undefined : 'A name is required.';
}
