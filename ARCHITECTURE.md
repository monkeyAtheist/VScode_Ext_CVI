# Architecture notes — 0.5.1

## Main components

- `src/model/iniDocument.ts`: preserving INI-like parser and serializer for `.cws` and `.prj` files.
- `src/model/cviParser.ts`: CVI-specific parsing, mutation, target resolution and minimal workspace/project generation.
- `src/services/cviWorkspaceService.ts`: loaded-workspace lifecycle and project-tree operations.
- `src/services/cviInstallationService.ts`: CVI installation discovery and selected-root persistence.
- `src/services/cviCppToolsService.ts`: managed Microsoft C/C++ configuration file, dynamic custom configuration provider, compiler-path discovery integration and IntelliSense diagnostics.
- `src/services/cviBuildService.ts`: `compile.exe`, executable launch, native CVI opening, `.uir` opening and native-debugger handoff.
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
  -> enforce debug/debug64 build mode
  -> compile.exe build
  -> open workspace in cvi.exe
  -> native CVI debugger handles execution control and inspection
```

A VS Code-native debugger remains a separate future Debug Adapter Protocol project.


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
