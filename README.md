# LabWindows/CVI Project Manager

Visual Studio Code extension for managing NI LabWindows/CVI workspaces and projects without maintaining project-specific `tasks.json` or `launch.json` files.

Version `0.6.13` initializes the native `.cws` blocks required by projects created or added directly from VS Code and retains the native project build-settings editor with file-browser buttons, per-configuration editing scopes and target-aware drop-down lists. It retains guarded native `.prj` / `.cws` writes, automatic backups, the file-creation wizard, blank `.uir` generation, reusable user templates, insertable CVI snippets and the embedded JC Lib `0.7.96` CVI catalog.

## Main views

The **LabWindows/CVI** activity-bar container exposes a compact persistent action strip followed by two vertically stacked native VS Code views:

```text
LabWindows/CVI
├── CVI Actions
├── CVI Workspace
└── CVI Libraries
```

The **CVI Workspace** title bar keeps the most common commands visible without requiring mouse hover. The separate **CVI Actions** view is a collapsible dashboard summarizing the active target type, build mode, launch settings, native build steps, dependencies and missing files. The dividers between the views remain resizable. **CVI Workspace** manages `.cws` and `.prj` content. **CVI Libraries** embeds the CVI API explorer derived from JC Lib.

## Workspace and project operations

The extension can:

- open an existing `.cws` workspace or standalone `.prj` project;
- create a minimal CVI-compatible workspace and project;
- create an additional EXE, DLL or static-library project directly inside the loaded `.cws` workspace;
- display the hierarchy `workspace -> project -> logical CVI folder -> file`;
- select the active project stored by a workspace;
- add existing project references or create new projects in the current workspace without deleting files from disk;
- create, rename and safely remove logical CVI folders;
- add, replace, include, exclude or remove project files;
- toggle the CVI `.Obj` option on C sources;
- build, rebuild, compile an individual `.c` file and execute the active target;
- open workspaces, projects and `.uir` panels in the native CVI IDE;
- discover common CVI installations and store a manually selected installation.


## CVI-native build settings

The project build-settings editor synchronizes the verified CVI-native fields instead of keeping a parallel copy whenever the native format is known.

The following `.prj` sections are read and written for the active configuration:

```text
[Debug Pre-build Actions]
[Debug Custom Build Actions]
[Debug Post-build Actions]
```

The following `.cws` section is read and written per project and per build mode:

```text
[Default Build Config 0001 Debug]
Command Line Args = "..."
Working Directory = "..."
Environment Options = "..."
External Process Path = "..."
```

Native CVI build steps are not executed twice: when these `.prj` sections are present, `compile.exe` is allowed to run them. The extension-side dependency graph remains stored under `.vscode/labwindows-cvi-build.json` until an example workspace containing a non-empty CVI-native dependency graph is available for exact compatibility validation.

## Build-settings editor ergonomics

The **Project Build Settings...** page exposes a configuration selector before saving changes:

```text
Debug
Release
Debug64
Release64
All Configurations
```

`All Configurations` applies the entered values to the four CVI build configurations while keeping the guarded native backup mechanism.

Path fields provide a folder button for native VS Code browsing. This covers the target output file, application icon, manifest, DLL copy directory, function-panel file, NI type-information header, working directory and DLL-debugging host executable.

The most common CVI enumerations are displayed as target-aware lists rather than free-form text, including run-time support, run-time binding, generated source documentation, DLL copy destination and DLL export mode. Existing project values that are not yet part of the verified catalog remain selectable and are preserved.

## Create New File or Starter

Right-click a project or logical folder and select **Create New File or Starter...**. The same command is available from the Command Palette and the Home page.

The wizard provides:

| Choice | Generated files |
|---|---|
| C source file | `.c`, empty or based on `main`, `WinMain` or `RTmain` |
| C header file | `.h` with an include guard |
| C module | paired `.c + .h` |
| CVI user-interface resource | blank `.uir + .h` |
| CVI UI application starter | `.c + .uir + .h` with `LoadPanel`, `DisplayPanel`, `RunUserInterface` and cleanup |
| CVI DLL starter | `.c + .h` with `DllMain`, `InitCVIRTE` and `CloseCVIRTE` |
| CVI error-management module | cleaned generic logger and goto-based error-check macros in `.c + .h` |
| Text file | empty `.txt` |
| Saved user template | one reusable text file created from a user-defined example |

When a paired starter is generated, each file is added to the CVI project. Without a selected logical folder, `.c`, `.h` and `.uir` files are routed to their standard CVI folders. When the command is invoked on a logical folder, the generated references are inserted into that folder.

### Blank UIR templates

A `.uir` resource is binary. The extension therefore embeds two blank resources derived from CVI-generated examples:

```text
data/templates/blank-cvi2012.uir
data/templates/blank-cvi2020.uir
```

The generated `.uir` is accompanied by a generated-style `.h` file exposing `PANEL`. After creation, the extension can open the panel in the native CVI graphical editor.

The setting `labwindowsCvi.uirTemplateVersion` controls resource selection:

- `auto`: select CVI 2020 for a CVI2020 installation and otherwise use the CVI 2012-compatible resource;
- `cvi2012`: force the CVI 2012-compatible blank resource;
- `cvi2020`: force the CVI 2020 blank resource.

## Reusable user templates

Use **LabWindows/CVI: Manage Creation Templates...** to save the active text file as a reusable creation template, import a text file, delete a template or open the JSON store.

User templates are saved in extension global storage and remain available across workspaces. A saved template may use these placeholders:

```text
{{baseName}}   {{fileName}}   {{headerFile}}
{{guard}}      {{prefix}}     {{uirFile}}
{{date}}       {{year}}
```

## CVI snippets

Use **LabWindows/CVI: Insert CVI Snippet...** to insert a reusable fragment at the current cursor position.

Default shortcut:

```text
Ctrl+Alt+I          Windows and Linux
Cmd+Alt+I           macOS
```

The shortcut can be changed from **Preferences: Open Keyboard Shortcuts**.

Built-in snippets include:

- standard `main`, `WinMain`, `RTmain` and `DllMain` CVIRTE lifecycle entries;
- panel and control callback skeletons;
- `LoadPanel` / `DisplayPanel` / `RunUserInterface` cleanup flow;
- negative-status cleanup branch;
- parameterized `SetCtrlAttribute` call.

Use **LabWindows/CVI: Save Selection as CVI Snippet...** and **LabWindows/CVI: Manage CVI Snippets...** to add or remove personal snippets. User snippets are stored as JSON in extension global storage.

## Cleaned error-management starter

The supplied legacy error-management files contained application-specific dependencies and obsolete constructs. The new generic starter removes project-specific globals and UI hooks, moves implementations out of the header, adds the required standard headers, checks log-path emptiness correctly and exposes reusable helpers:

```c
CviError_SetLogFile(...);
CviError_Log(...);
CviError_Report(...);
CVI_ERROR_GOTO(...);
CVI_CHECK_GOTO(...);
CVI_CHECK_PTR_GOTO(...);
```

## CVI Libraries explorer

The embedded library explorer now uses the JC Lib `0.7.96` runtime and the LabWindows/CVI Structured API Pack `1.5.0`.

The CVI catalog contains 19 top-level libraries. `CVI Patterns & References` has been folded into **CVI Basics**, which now exposes:

- CVIRTE lifecycle functions and recipes;
- editable callback typedef forms;
- parameterized callback skeletons;
- grouped `EVENT_*` and event-data selectors;
- callback installation and dispatch recipes;
- `CVICALLBACK`, `CVIFUNC`, workflows and notes.

The explorer retains the structured `Set*Attribute` helpers introduced earlier. It loads both:

```text
data/metadata/cvi_ui_attribute_catalog.json
data/metadata/cvi_callback_event_catalog.json
```

Find Symbol shortcut:

```text
Ctrl+Alt+P          Windows and Linux
Cmd+Alt+P           macOS
```

## IntelliSense configuration

When a workspace is opened or the selected CVI installation changes, the extension creates or updates a managed entry in:

```text
.vscode/c_cpp_properties.json
```

The entry is named `LabWindows/CVI (managed)`. Existing user configurations are preserved.

Version `0.5.1` also registers a dynamic configuration provider for the Microsoft C/C++ extension. This provider supplies CVI paths directly for `.c`, `.h`, `.cpp` and `.hpp` files opened from the CVI project explorer, including files located outside the VS Code folder that was initially opened.

The managed configuration includes:

```text
<CVI>/include
<CVI>/include/ansi
<CVI>/include/clang/**
<CVI>/toolslib
<CVI>/toolslib/**
<CVI>/toolslib/toolbox
<Windows Kits>/10/Include/**
<Windows Kits>/8.1/Include/**
<Microsoft SDKs>/Windows/v7.1A/Include/**
project source and include directories
```

The dynamic provider enumerates concrete header directories under `include` and `toolslib`. This avoids relying only on recursive glob expansion when resolving headers such as:

```c
#include "toolbox.h"
```

CVI 2020 installations may expose their internal Clang executable below a nested directory such as `bin/clang/<version>/`. The installation scanner now searches these nested locations and accepts `clang-cc.exe`, `clang.exe` and `clang-cl.exe`.

Useful commands:

```text
LabWindows/CVI: Synchronize C/C++ IntelliSense Configuration
LabWindows/CVI: Diagnose C/C++ IntelliSense Configuration
LabWindows/CVI: Add CVI Folder to VS Code Workspace for IntelliSense
```

The diagnostic command reports whether `toolslib/toolbox/toolbox.h` exists, whether the Microsoft C/C++ extension is installed, whether the dynamic provider was registered, which compiler path was detected and whether the current CVI workspace folder is active in VS Code.

## Standard VS Code Explorer synchronization

When a `.cws` or `.prj` file is opened, the extension adds its containing directory to the standard VS Code Explorer by default. This activates the generated `.vscode/c_cpp_properties.json` file in the normal VS Code workspace context and complements the dynamic Microsoft C/C++ provider. Disable this behavior with `labwindowsCvi.autoAddCviFolderToWorkspace` when required.

The IntelliSense generator detects CVI ANSI include directories and Windows SDK include directories from Windows Kits 10, Windows Kits 8.1 and the historical Windows v7.1A SDK.

## Build and debug behavior

Build commands invoke CVI `compile.exe` directly. Typical calls are equivalent to:

```text
compile.exe <project.prj> -debug
compile.exe <project.prj> -release
compile.exe <project.prj> -debug64
compile.exe <project.prj> -release64
compile.exe <file.c> <project.prj> -debug
```

**Build Debug and Open Native Debugger** prepares a debug build and opens the workspace in `cvi.exe`. Breakpoints, stepping, watches, call-stack navigation and variable inspection remain delegated to the native CVI debugger. A VS Code-native debugger requires a dedicated Debug Adapter Protocol bridge.

## Settings

- `labwindowsCvi.installations`
- `labwindowsCvi.activeInstallation`
- `labwindowsCvi.buildMode`
- `labwindowsCvi.customBuildConfiguration`
- `labwindowsCvi.extraCompilerArguments`
- `labwindowsCvi.runArguments`
- `labwindowsCvi.projectFormatVersion`
- `labwindowsCvi.autoLoadWorkspace`
- `labwindowsCvi.autoConfigureCppTools`
- `labwindowsCvi.autoAddCviFolderToWorkspace`
- `labwindowsCvi.useCppToolsConfigurationProvider`
- `labwindowsCvi.intelliSenseCompilerPath`
- `labwindowsCvi.additionalIncludePaths`
- `labwindowsCvi.uirTemplateVersion`

## Installation

1. Open **Extensions** in VS Code.
2. Select `...` then **Install from VSIX...**.
3. Choose `labwindows-cvi-project-manager-0.5.9.vsix`.
4. Execute **Developer: Reload Window**.

## Source build

```text
npm install
npm run compile
npm run package
```
## Home page layout and UIR editing

The CVI home page is organized vertically so full workspace and project paths remain readable. When no project is loaded, the page exposes primary actions to open or create a workspace and select a CVI installation.

`.uir` files open directly in the LabWindows/CVI User Interface Editor. The editor is part of the native CVI IDE; NI does not provide a standalone UIR editor executable.


## Advanced build workflow

The project explorer toolbar exposes a compact **Build / Rebuild / Clean** picker. Build and rebuild invoke the selected CVI installation `compile.exe` directly and stream the compiler log into the **LabWindows/CVI** output channel. Timestamped log files are retained under:

```text
.vscode/cvi-build-logs
```

The current target type can be selected from the Home page or the project context menu:

```text
Executable
Dynamic Link Library
Static Library
```

**Project Build Settings...** edits the current target workflow. Native CVI build-step sections are written directly into the `.prj`, while executable command-line settings are written into the `.cws`. Project-dependency metadata is temporarily mirrored in:

```text
.vscode/labwindows-cvi-build.json
```

The settings cover:

- dependency projects and dependency build order;
- pre-build shell actions;
- custom build shell actions executed before the native CVI compilation;
- post-build shell actions executed after a successful native build;
- executable command-line arguments;
- working directory;
- environment options;
- external host executable for DLL runs.

When a `.cws` workspace is loaded, executable command-line settings are also mirrored into the corresponding CVI workspace sections. Target type is written into the native `.prj` metadata.

The **Clean Generated Target** action deliberately removes only generated target artifacts for the active configuration. It does not delete source files or referenced third-party libraries.

## Prototype header generation

A C source file context menu exposes:

```text
Generate Prototypes Header...
```

This creates an editable `<source-name>.h` baseline containing detected non-static function declarations, adds it to the CVI project and opens it in VS Code. The built-in generator is conservative and should be reviewed before use in a public API. For an exact CVI-native result, compile the source and use the native **Generate Prototypes** command in LabWindows/CVI.

## CVI runtime paths, completions and file symbols

Version 0.5.8 normalizes CVI/MSYS-style DLL host paths such as `/c/PROG_CVI/EXE/Test.exe` before launching them on Windows while preserving the native `.cws` value. Version 0.5.9 moves the persistent toolbar to the **CVI Workspace** title bar so collapsing the **CVI Actions** dashboard no longer hides the main commands. The toolbar exposes direct **Build + Run**, advanced run options, the compact build-mode labels `D32`, `R32`, `D64`, `R64`, and the compact target labels `EXE`, `DLL`, `LIB`.

The extension also contributes supplemental C/C++ completions from the active project and the embedded CVI API pack. A dedicated `CVI File Symbols` view lists functions found in the selected `.c` or `.h` file and navigates to them on click.

## Persistent actions and C/C++ completion repair

VS Code exposes toolbar actions for individual views through `view/title`, but it does not expose a public toolbar contribution point for the outer `LABWINDOWS/CVI` view-container header. The extension therefore keeps the `CVI Workspace` toolbar and also exposes a compact persistent status-bar strip. The strip remains usable when the sidebar views are collapsed and can be disabled with `labwindowsCvi.showPersistentStatusBarActions`.

Version 0.6.0 permanently disables the historical dynamic Microsoft C/C++ configuration-provider integration. The provider could remain selected globally by cpptools and interfere with unrelated C/C++ folders. CVI include directories are now supplied only through the managed `.vscode/c_cpp_properties.json` entry. On activation, stale LabWindows/CVI provider references are removed automatically. After upgrading from an older version, reload VS Code and run `C/C++: Reset IntelliSense Database` once if native completion such as `printf` is still missing.

## Native workspace safety

Version 0.6.1 writes command-line and DLL-debugging settings only into the CVI per-configuration sections of the `.cws` file. Windows runtime paths are converted back to CVI `/c/...` notation before persistence and are converted to Windows form only in memory when launching a target.

Before overwriting a native `.cws` or `.prj` file, the extension creates a timestamped backup under `.vscode/cvi-native-backups`. Projects created or added from VS Code receive their native workspace project blocks immediately. Workspaces affected by earlier releases, including workspaces created with version `0.6.12`, can be migrated with `LabWindows/CVI: Repair Native Workspace Compatibility`. Missing native project blocks are also initialized automatically when run settings are saved.

### Copying file paths

Files in the CVI workspace explorer expose `Copy Path` and `Copy Relative Path` from the context menu. Relative paths follow the active VS Code workspace root when available, with CVI workspace and project folders used as fallbacks.

## Project Build Settings improvements in 0.6.6

The build-settings page now uses collapsible sections. The `LoadExternalModule` compatibility block mirrors the CVI workflow more closely: enable the option, add `.lib` or `.obj` modules, inspect the preview and remove individual entries before saving.

The editor context menu also exposes `Convert selected integer to` for decimal, hexadecimal and binary literals.

## Project Build Settings improvements in 0.6.7

The **Target** and **Project dependencies and build order** blocks are displayed vertically. Their collapse controls now behave consistently even when the workspace contains many projects.

When **Run-time support** is set to `Instrument Driver Support Only`, the **LoadExternalModule options** section is dimmed and its controls are disabled, matching the native CVI Target Settings dialog. Existing module entries remain stored and reappear when full run-time support is selected again.

## Project Build Settings improvements in 0.6.9

DLL settings now follow the native CVI dependency rules more closely. The exported-header list is dimmed when **Symbols marked for export** is selected, the import-library base name is disabled while the default name is active, the custom copy directory is only editable for **Custom directory**, and the manifest path is only editable when **Embed manifest** is checked. IVI and VXIplug&play import-library choices are exposed through a dedicated **Import library choices…** dialog instead of permanent inline checkboxes.


## Project Build Settings improvements in 0.6.10

The **DLL options** grid now places **Custom copy directory** directly opposite **Where to copy DLL**. **Import library base name** has moved to the second row opposite **Export mode**. This is a visual-only refinement: the existing conditional enablement rules and native CVI persistence remain unchanged.

## Project Build Settings and function panels in 0.6.11

The **Signing information** fields are disabled until **Sign target** is enabled. The **External executable for DLL debugging** field remains visible but disabled for executable targets, and the complete **Executable command line** section is hidden for static-library targets.

Function-panel files (`.fp`) can now be opened directly from the CVI workspace explorer. The extension reads the embedded function reference data and displays a native VS Code selector containing the available functions and prototypes. Selecting an entry opens the embedded JC Lib prototype card when the symbol already exists in the CVI pack. When no packaged card exists, the extension opens a generated fallback card containing the prototype, parameters, header and purpose extracted from the `.fp` file.

## Native CVI breakpoint bridge

Version 0.6.14 can synchronize standard enabled VS Code source breakpoints from the selected CVI project into the loaded native `.cws` workspace. The bridge is intentionally conservative: it preserves breakpoints created manually in LabWindows/CVI, tracks only entries injected by the extension, and skips disabled, conditional, hit-count and log breakpoints until their native serialization has been validated.

Use `LabWindows/CVI: Synchronize VS Code Breakpoints to Native Workspace` for an explicit synchronization. `LabWindows/CVI: Build Debug and Open Native Debugger` performs the synchronization automatically before opening CVI when `labwindowsCvi.synchronizeBreakpointsBeforeNativeDebug` is enabled. Native CVI remains responsible for step commands, watch expressions and variable inspection in this first integration stage.


## Native CVI command bridge — DDE-first deterministic transport

Version 0.6.20 uses the native CVI DDE command server as the default transport because this path has been validated against CVI 2020 with a loaded workspace. The server contract remains:

```text
service = cvi
topic   = system
item    = status
```

The extension now opens the requested `.cws` or `.prj` file explicitly and polls the DDE server directly. It no longer creates a `CVI.Application` COM instance during normal startup, avoiding a second empty CVI workspace.

The ActiveX bridge remains packaged as an experimental compatibility path. Configure the transport through:

```text
labwindowsCvi.nativeCommandTransport
  dde      recommended default
  auto     DDE first, ActiveX fallback
  activex  ActiveX first, DDE fallback

labwindowsCvi.allowActiveXAutoStart
  false    recommended default
  true     allow experimental COM activation when no running object exists
```

The DDE helper cache remains available under:

```text
%LOCALAPPDATA%\LabWindowsCviProjectManager\NativeBridge\CviDdeBridge.0.6.18.dll
```

Version 0.6.21 keeps a persistent DDE conversation open before `Run Project`. CVI 2020 can stop accepting new DDE conversations while the debugged program is executing, so `Pause`, `Continue`, and `Stop` are now sent through the existing session without a blocking `Get CVI State` probe. The extension tracks a cached execution state for diagnostics while the program is active and closes the session when the extension is disposed or the workspace changes.

The persistent-session startup timeout is configurable through:

```text
labwindowsCvi.nativeDdeSessionStartupTimeoutMs
  15000   default
```

Build and initial Run validation continue to use the ordinary DDE state query while CVI is idle. ActiveX HRESULT-style values in the `0x800400xx` range are normalized back to readable CVI command errors when the optional ActiveX path is used.


## Native CVI debug dashboard — 0.6.22

The LabWindows/CVI activity-bar container now includes a resizable native **CVI Debug** view. It does not use a webview and therefore does not start a Chromium service worker. The view remains available next to the workspace tree, the active-project summary, file symbols and JC Lib explorer.

The dashboard displays:

```text
Native bridge        Available / Unavailable / Unknown
Persistent session   Connected / Disconnected
Execution            idle / running / suspended / unknown
Project              active .prj name
Linked               Yes / No / Unknown
Transport            DDE / AUTO / ACTIVEX
State source          native / cached / unknown
Last command          last command sent to CVI
Last result           accepted / rejected / failed / skipped
```

The action rows expose:

```text
Build native project
Run in native debugger
Pause native execution
Continue native execution
Stop native execution
Refresh native state
Diagnose native bridge
```

The compact status-bar action is now dynamic:

```text
CVI:off    no reachable native bridge is known
CVI:idle   CVI is reachable and the project is inactive
CVI:run    a persistent DDE debug session is running
CVI:pause  the native execution is suspended
```

During a debug run, CVI 2020 may stop accepting new DDE conversations. The dashboard therefore uses the cached state maintained by the persistent DDE session introduced in version `0.6.21`. Manual refresh avoids a blocking state probe while execution is active.

## Native CVI debug-session finishing pass — 0.6.23

Version `0.6.23` keeps the validated persistent DDE session from `0.6.21` and refines its behavior during IDE startup and debug-control transitions.

When CVI is launched automatically, the DDE server can temporarily answer with `DMLERR_BUSY` while the workspace is still loading. These transient responses are now polled silently until a stable state is available. The output channel reports the accepted connection rather than expected startup noise.

The persistent-session initialization log is explicit:

```text
[CVI] Persistent DDE session handshake accepted (ansi).
[CVI] Persistent DDE debug session connected for ...
```

For action commands, the historical `cmdsrvr.h` contract is enforced strictly: only status `0` means that the command server accepted the command. A negative status remains a native CVI error. An unexpected positive status is also treated as a rejection and displayed with the closest matching CVI error-table description when available. The cached execution state is not advanced after a rejected command.

The **CVI Debug** view keeps unavailable controls visible but visually disabled. `Build` and `Run` are disabled while an execution is active. `Pause` is available while the cached execution is running. `Continue` and `Stop` remain available throughout an active persistent session because a native breakpoint can suspend CVI asynchronously while the local dashboard still reports a cached running state.


## VS Code Run and Debug integration — 0.6.24

Version `0.6.24` adds an inline VS Code Debug Adapter Protocol (DAP) bridge for the validated CVI native backend. The CVI IDE is still required as the debugger engine, but VS Code now owns the visible debug session and toolbar. The backend CVI window is launched minimized by default.

Start the VS Code-owned session from the **CVI Debug** view or the command palette:

```text
LabWindows/CVI: Start Debugging in VS Code
```

The first integration supports:

```text
source breakpoint synchronization before launch
Run
Pause
Continue
Stop
VS Code debug toolbar and Debug Console output
optional breakpoint-suspension detection through persistent-session polling
```

The direct command remains available as a compatibility fallback:

```text
LabWindows/CVI: Run Project in Native CVI Debugger
```

The DAP adapter intentionally does not fabricate unavailable native data. CVI call-stack frames, local variables, watch evaluation, and step-over / step-in / step-out are not yet exposed in VS Code. Those features require additional stable CVI automation primitives or a dedicated native adapter layer.

Background behavior can be configured with:

```text
labwindowsCvi.nativeDebuggerIdeWindowMode
labwindowsCvi.keepNativeIdeMinimizedDuringVsCodeDebug
labwindowsCvi.nativeDapPollIntervalMs
labwindowsCvi.nativeDapPollTimeoutMs
```
