# Architecture notes — 0.7.43

## Main components

- `src/model/iniDocument.ts`: preserving INI-like parser and serializer for `.cws` and `.prj` files.
- `src/model/cviParser.ts`: CVI-specific parsing, mutation, target resolution and minimal workspace/project generation.
- `src/services/cviWorkspaceService.ts`: loaded-workspace lifecycle and project-tree operations.
- `src/services/cviInstallationService.ts`: CVI installation discovery and selected-root persistence.
- `src/services/cviCppToolsService.ts`: managed Microsoft C/C++ configuration file, active-project/native-build-mode synchronization, compiler-path discovery integration and IntelliSense diagnostics.
- `src/services/cviBuildService.ts`: native `compile.exe` build, external MSVC `cl/link/lib` build, executable launch, VS Code `cppvsdbg` handoff, native CVI opening, `.uir` opening and native-debugger handoff.
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

Adding a file allocates `max(existing File id) + 1`, appends the new `[File NNNN]` block after the last physical file block and records its relative and absolute paths. Existing file identifiers are treated as stable native IDs: gaps and arbitrary physical section ordering are preserved. Removing a file deletes only that project reference, updates the advisory `Number of Files` count, and never renumbers surviving `[File NNNN]` / `Res Id` pairs. Disk files are never deleted by reference-removal commands.

Native validation is intentionally tolerant of layouts CVI itself accepts. A stale `Number of Files`, missing external files, legacy folders without `Folder Id`, numeric gaps and out-of-order `[File]` blocks are not repairable corruption. The project repair path is conservative and does not normalize paths, folders, file types or identifiers merely to satisfy CVI PM assumptions.

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

## Debug architecture — 0.7.37

```text
VS Code command
  -> synchronize supported source breakpoints into the native .cws
       -> optimistic-concurrency guard protects concurrent CVI saves
  -> resolve workspace + active project + native build configuration context
  -> bind to one exact CVI PID
       -> DdeConnectList enumerates matching cvi/system servers
       -> DdeQueryConvInfo + hwndPartner -> GetWindowThreadProcessId
       -> ambiguous unbound connections are refused
  -> reuse a verified single-project CVI instance when its window matches
     OR launch a dedicated cvi.exe instance and retain its returned PID
       -> multi-project workspaces always prefer the dedicated instance
  -> establish one persistent PID-targeted DDE conversation before Run Project
       -> Suspend Execution / Continue Execution / Terminate Execution reuse it
       -> bridge loss may reconnect once to the same PID
  -> poll the same PID for natural program completion
  -> optional ActiveX compatibility fallback refuses multiple CVI processes
  -> native CVI debugger handles stepping, watches, call stack and variables
```

The DDE bridge lives in `native/cvi-dde-command.ps1`. It enumerates all matching DDE conversations and only selects the partner whose process ID matches the requested target. An untargeted call is accepted only when exactly one CVI DDE server is available. The persistent JSON-line session therefore cannot silently move to another CVI instance.

`native/cvi-start-background.ps1` returns the launched PID. `native/cvi-window-control.ps1` requires that exact PID, so background/minimize behavior never affects unrelated CVI windows. The optional `CVI.Application` ActiveX bridge is retained as a compatibility path, but it refuses ambiguous multi-process situations because the active automation object does not expose a reliable per-instance selector.

The inline DAP prototype from 0.6.24 was removed in 0.6.30. Current builds do not register a VS Code debug adapter and do not advertise stack/variable/step capabilities that the native command server cannot supply.


## Extension lifecycle — 0.7.38

The loaded CVI workspace is treated as a scoped resource rather than permanent extension state:

```text
load .cws/.prj
  -> create generation-bound native file watchers
  -> publish workspace model
  -> schedule IntelliSense sync with epoch

workspace/project replaced, removed or closed
  -> invalidate watcher generation
  -> cancel pending native refresh
  -> dispose native watchers
  -> invalidate stale IntelliSense sync
  -> close stale Build Settings panel
  -> release idle native DDE binding

extension deactivation/reload
  -> kill active compile.exe / build-step shell children
  -> clear log/native monitoring timers
  -> close persistent DDE bridge
  -> dispose providers/EventEmitters/Webviews
```

A running or suspended native CVI program is the only intentional exception to immediate binding release when the VS Code project context changes. Its original PID remains bound so the user can still Pause/Continue/Stop that execution; it is not silently rebound to the new workspace.

`CviCppToolsService` uses an epoch for queued synchronization. A newer workspace/project refresh invalidates older queued work before `c_cpp_properties.json` is written. `CviWorkspaceService` uses an independent watcher generation for the same reason.

## IntelliSense architecture — 0.7.34

The Microsoft C/C++ integration is file-based and deliberately avoids a persistent custom configuration provider:

```text
CVI workspace / project refresh
  -> resolve active CVI project
  -> resolve native Debug / Release / Debug64 / Release64 mode
  -> read per-configuration Compiler Defines / C99 state
  -> read project Include Paths / Prefix Header
  -> merge CVI headers + Windows SDK headers + user additional paths
  -> write/update only "LabWindows/CVI (managed)"
     in .vscode/c_cpp_properties.json
```

Semantic configuration follows the active CVI project. `includePath` contains that project's explicit Include Paths and source/header directories before CVI/SDK headers. It intentionally does not use `${workspaceFolder}/**`, which could resolve headers from unrelated CVI projects. `browse.path` may still span the complete workspace because it is used for global symbol discovery rather than compiler-like include resolution.

Architecture is mapped to `windows-clang-x86` or `windows-clang-x64`. CVI compiler defines are translated from `/D...` syntax, Prefix Header maps to `forcedInclude`, and the C standard is approximated as `c89` or `c99` based on the native C99-extension switch. Release builds add `NDEBUG`; CVI header architecture macros use `_NI_mswin32_` / `_NI_mswin64_`.

The dynamic cpptools provider introduced by older versions remains permanently disabled because provider selection can leak outside CVI folders. Activation and the repair command remove stale provider references.

`CviCppToolsService.ensureConfigurationRootInWorkspace()` can add the directory containing the loaded `.cws` or standalone `.prj` to the standard VS Code Explorer so cpptools activates the generated configuration.

The IntelliSense path resolver scans CVI ANSI/Toolslib directories and Windows Kits 10, Windows Kits 8.1 and the historical Windows v7.1A SDK. A CVI internal Clang executable is preferred when detected; `labwindowsCvi.intelliSenseCompilerPath` is the explicit override.

Custom native CVI configurations are detected from their serialized `Config Name`, `Is 64-Bit` and `Is Release` fields instead of relying on an undocumented section name. When such a section exists, compiler/IntelliSense settings are read from it directly. Target/linker settings use the same descriptor and the exact `Executable File_<configuration>` output key from `[Create Executable]`.

Workspace Run/Debug settings remain conservative: custom `[Default Build Config NNNN <name>]` data is edited only when CVI has already serialized that exact section. CVI PM never invents a custom workspace section. Named custom Build Steps remain owned by native CVI and `compile.exe -config=<name>`.

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
## Supplemental symbol completion and Signature Help — 0.7.40

`CviSymbolService` keeps a project-local function index built from the active CVI project files and a separate embedded CVI API index. Completion intentionally exposes one preferred item per function name, while Signature Help preserves distinct overloads. When both a header declaration and a source definition exist, the header declaration wins because it is the public API contract and generally contains the most useful parameter names.

`CviSignatureHelpProvider` is registered for C/C++ CVI workspace files with `(` and `,` trigger characters. It resolves the nearest active call from the text before the cursor, ignores strings/comments and nested delimiters, selects the matching project or CVI API signatures, and updates `activeParameter` immediately. This is a supplemental fast path: Microsoft C/C++ remains responsible for full semantic analysis, while CVI PM provides deterministic project-level parameter hints during cpptools indexing.

From v0.7.41, `labwindowsCvi.autocompleteProfile` is the primary policy layer. `hybrid` enables project + embedded CVI API completion and CVI PM Signature Help; `native` withdraws both CVI PM providers; `nativeSignature` leaves completion to the native C/C++ provider while retaining immediate CVI PM parameter hints; `cviApi` adds only the embedded LabWindows/CVI API completion; and `custom` exposes the individual supplemental switches. CVI PM never changes `C_Cpp.*` settings as part of a profile switch.

In `custom` mode, `labwindowsCvi.enableSupplementalCompletionProvider` controls the supplemental completion provider as a whole, `labwindowsCvi.enableSupplementalProjectCompletion` controls active-project entries, `labwindowsCvi.enableSupplementalCviApiCompletion` controls embedded CVI API entries, and `labwindowsCvi.enableSupplementalSignatureHelp` controls immediate parameter hints. Explicit pre-v0.7.41 boolean values are treated as Custom until the user explicitly selects a profile.


## Visual autocompletion settings (v0.7.42)

`BuildSettingsPanel` now contains a dedicated **Autocompletion** page. It is a visual front-end for the same `labwindowsCvi.autocompleteProfile` and supplemental-provider settings used by `CviSymbolService`; it does not introduce a second configuration source. The page is intentionally independent from CVI Debug/Release configuration scope because completion-provider policy belongs to the VS Code workspace. Saving the project settings persists those values through `WorkspaceConfiguration.update(..., ConfigurationTarget.Workspace)`. Microsoft C/C++ `C_Cpp.*` settings are never rewritten by this page.

## External compiler pipeline (0.7.43)

The project build engine is stored in `.vscode/labwindows-cvi-build.json` and defaults to `cvi`. `msvc` is intentionally a parallel build path; it does not rewrite the native `.prj` compiler selection. The selected native CVI configuration remains the source of truth for bitness, defines, include paths and output target. CVI PM resolves a Visual Studio C++ environment through `vcvarsall.bat`, compiles each C source to an isolated object file, then links with the CVI external-support import libraries. Generated UIR callback/project-symbol files are consumed only when already produced by CVI. Native CVI debugger commands always force the `cvi` build engine.
