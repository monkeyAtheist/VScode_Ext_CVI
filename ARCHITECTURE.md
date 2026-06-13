# Architecture notes — 0.5.1

## Main components

- `src/model/iniDocument.ts`: preserving INI-like parser and serializer for `.cws` and `.prj` files.
- `src/model/cviParser.ts`: CVI-specific parsing, mutation, target resolution and minimal workspace/project generation.
- `src/services/cviWorkspaceService.ts`: loaded-workspace lifecycle and project-tree operations.
- `src/services/cviInstallationService.ts`: CVI installation discovery and selected-root persistence.
- `src/services/cviCppToolsService.ts`: managed Microsoft C/C++ configuration file, dynamic custom configuration provider, compiler-path discovery integration and IntelliSense diagnostics.
- `src/services/cviBuildService.ts`: `compile.exe`, executable launch, native CVI opening, `.uir` opening and native-debugger handoff.
- `src/services/cviNativeCommandService.ts`: DDE-first native CVI command transport, persistent debug-session lifecycle, optional ActiveX compatibility fallback and diagnostic reporting.
- `src/services/cviTemplateService.ts`: starter generation, blank UIR resources, user templates and snippets.
- `src/services/cviLibraryPackService.ts`: seeding and versioned migration of the editable embedded CVI pack.
- `src/providers/cviTreeProvider.ts`: native VS Code project tree and composite CVI-style icons.
- `src/jcLibEmbedded.ts`: namespaced embedded library explorer and structured prototype UI synchronized from JC Lib `0.7.96`.
- `src/views/homePanel.ts`: compact global-operation page.

## View layout

```text
LabWindows/CVI activity-bar container
├── CVI Workspace
└── CVI Libraries
```

Both areas are native contributed VS Code views. VS Code manages their vertical splitter, resize behavior and tree navigation.

## CVI project mutation rules

The `.cws` and `.prj` serializers preserve unknown sections and keys. Existing CVI projects contain release-specific settings that must not be discarded.

Adding a file appends a new `[File NNNN]` section and records its relative and absolute paths. Removing a file deletes only the project reference. Disk files are never deleted by reference-removal commands.

## Template-generation pipeline

```text
Create New File or Starter...
  -> select generator
  -> select output path
  -> render text placeholders or copy blank UIR binary
  -> protect existing files unless overwrite is explicitly selected
  -> append every generated file to the selected CVI project
  -> open the primary text file
  -> optionally open the generated UIR in native CVI
```

Text templates expand:

```text
{{baseName}} {{fileName}} {{headerFile}} {{guard}}
{{prefix}}   {{uirFile}}  {{date}}       {{year}}
```

User templates and snippets are stored under the extension global-storage directory:

```text
templates/file-templates.json
templates/snippets.json
```

## UIR generation

`.uir` files are binary NI resources and cannot be synthesized as plain text. The extension embeds two blank resources derived from CVI-generated examples:

```text
data/templates/blank-cvi2012.uir
data/templates/blank-cvi2020.uir
```

The `.h` companion is generated as a CVI-style resource include file with `PANEL` identifier `1`. Native CVI remains the graphical editor.

## Cleaned error-management starter

The generic starter intentionally excludes application-specific dependencies from the supplied legacy files. It avoids implementation functions in headers, adds the required standard includes, stores log state in one `.c` translation unit and provides reusable negative-status and pointer checks.

## Embedded CVI libraries

Version `0.5.0` embeds JC Lib `0.7.96`. The library runtime is namespaced under:

```text
labwindowsCvi.library.*
```

The writable CVI pack is copied to global storage. When the packaged version changes, the previous writable copy is backed up before replacement.

Pack metadata:

```text
data/cvi_pack.json                              1.5.0
data/metadata/cvi_ui_attribute_catalog.json
data/metadata/cvi_callback_event_catalog.json
```

## Debug architecture

```text
VS Code command
  -> synchronize supported source breakpoints into the native .cws
  -> invoke historical CVI DDE server cvi/system/status by default
       -> use one-shot Get CVI State / Build Project while CVI is idle
       -> establish one persistent DDE conversation before Run Project
       -> keep the conversation alive for Suspend Execution / Continue Execution / Terminate Execution
  -> launch cvi.exe with the requested .cws path when needed
  -> poll DDE directly until the requested workspace instance is ready
  -> keep CVI.Application ActiveX as an explicit experimental fallback
  -> native CVI debugger handles stepping, watches, call stack and variables
```

The DDE bridge is isolated in `native/cvi-dde-command.ps1`, caches its managed helper locally and supports a JSON-line persistent-session mode over stdin/stdout. The optional ActiveX bridge remains available in `native/cvi-activex-command.ps1`, but automatic COM activation is disabled by default so the extension does not open an empty second CVI instance. A VS Code-native debugger with inline variables and stack frames remains a separate future Debug Adapter Protocol project.


## IntelliSense architecture — 0.5.1

The extension uses two complementary paths:

```text
CVI workspace load
  -> write or update .vscode/c_cpp_properties.json
  -> register jc-tools.labwindows-cvi-project-manager as a C/C++ provider
  -> enumerate project directories and CVI header directories
  -> notify ms-vscode.cpptools when workspace or installation settings change
```

The generated JSON remains useful for transparency and for environments where the provider API is unavailable. The dynamic provider resolves CVI project files opened from the custom explorer even when their workspace root is not the first folder opened in VS Code.

The provider returns concrete directories rather than only recursive patterns. It includes project folders, `<CVI>/include`, ANSI and Clang subdirectories, Toolslib header directories, Toolbox and Windows SDK include directories.

Compiler discovery prefers CVI's internal Clang executable and searches nested `bin/clang` trees. A user may override discovery with:

```text
labwindowsCvi.intelliSenseCompilerPath
```

The diagnostic command reports the active installation, `toolbox.h` presence, provider registration and generated include directories.

## Standard Explorer synchronization and SDK discovery

`CviCppToolsService.ensureConfigurationRootInWorkspace()` adds the directory containing the loaded `.cws` or standalone `.prj` file to the standard VS Code Explorer when `labwindowsCvi.autoAddCviFolderToWorkspace` is enabled. The normal workspace context then activates the generated `.vscode/c_cpp_properties.json` file. The dynamic Microsoft C/C++ provider remains enabled as a fallback for CVI files opened outside the active folder set.

The IntelliSense path resolver enumerates the CVI ANSI directories and scans Windows Kits 10, Windows Kits 8.1 and the historical Windows v7.1A SDK. Versioned SDK folders and the `um`, `shared`, `ucrt`, `winrt` and `cppwinrt` segments are exposed explicitly.


## Native CVI debug dashboard — 0.6.22

```text
CviNativeCommandService
  -> publishes onDidChange after native state transitions
  -> exposes getDebugSnapshot()
       -> bridge availability
       -> persistent DDE-session connectivity
       -> cached execution state
       -> link state
       -> last command and result
  -> CviDebugView renders one native VS Code tree
  -> extension.ts updates the compact status-bar indicator
       -> CVI:off / CVI:idle / CVI:run / CVI:pause
```

The dashboard is deliberately implemented with `TreeDataProvider` rather than `WebviewView`. This keeps debugger controls available without reintroducing Chromium service-worker failure modes. While a CVI user program executes, the view presents the cached state maintained by the persistent DDE session instead of creating a new synchronous `Get CVI State` conversation.


## VS Code DAP facade — 0.6.24

```text
VS Code Run and Debug UI
  -> labwindows-cvi-native inline DebugAdapter
       -> launch/configurationDone
            -> conservative breakpoint synchronization into .cws
            -> minimized cvi.exe backend startup when required
            -> persistent DDE handshake
            -> Run Project
       -> pause / continue / terminate
            -> reuse the established DDE conversation
       -> optional persistent-session Get CVI State polling
            -> detect running / suspended / idle transitions when CVI responds
            -> keep failures non-destructive so controls remain available
```

The DAP adapter is implemented in `src/debug/cviNativeDebugAdapter.ts` and is registered as an inline implementation through `DebugAdapterInlineImplementation`. This keeps the first adapter inside the extension host and avoids an additional Node.js child process.

The backend IDE launcher is isolated in `native/cvi-start-background.ps1`. For VS Code-owned sessions it starts `cvi.exe` minimized by default. `native/cvi-window-control.ps1` re-minimizes CVI after control transitions when `labwindowsCvi.keepNativeIdeMinimizedDuringVsCodeDebug` is enabled.

The adapter advertises only capabilities backed by the validated bridge. It does not fabricate stack frames, scopes, variables, expression evaluation, or step-by-step commands.
