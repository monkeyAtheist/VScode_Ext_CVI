# Changelog

## 0.5.2

- Automatically adds the directory containing an opened CVI workspace or project to the standard VS Code Explorer.
- Adds `labwindowsCvi.autoAddCviFolderToWorkspace` to disable this behavior when a manual multi-root workspace is preferred.
- Extends Windows SDK discovery to Windows Kits 10, Windows Kits 8.1 and the historical Windows v7.1A SDK.
- Adds explicit versioned Windows SDK include directories, including `um`, `shared`, `ucrt`, `winrt` and `cppwinrt`, so `windows.h` is resolved reliably.
- Adds targeted CVI ANSI header discovery and diagnostic output for `ansi.h` / `ansi_c.h`.

## 0.5.1

- Added a dynamic Microsoft C/C++ custom configuration provider for CVI project files.
- Kept managed `.vscode/c_cpp_properties.json` generation as a readable fallback and added `configurationProvider` plus `mergeConfigurations` to the managed entry.
- Added explicit `include`, `include/ansi`, `include/clang/**`, `toolslib`, `toolslib/**` and `toolslib/toolbox` paths.
- Added concrete recursive header-directory enumeration in the dynamic provider to improve `toolbox.h` and nested Toolslib resolution.
- Added project source and header directories to generated and dynamic IntelliSense configurations.
- Extended CVI compiler detection to nested `bin/clang/<version>` directories and to `clang-cc.exe`, `clang.exe` and `clang-cl.exe`.
- Added `labwindowsCvi.intelliSenseCompilerPath` for manual compiler override.
- Added `labwindowsCvi.additionalIncludePaths` for project-specific external headers.
- Added `labwindowsCvi.useCppToolsConfigurationProvider` to disable the dynamic provider when required.
- Added **LabWindows/CVI: Diagnose C/C++ IntelliSense Configuration**.
- Added **LabWindows/CVI: Add CVI Folder to VS Code Workspace for IntelliSense**.

## 0.5.0

- Updated the embedded JC Lib runtime from `0.7.93` to `0.7.96`.
- Updated the bundled LabWindows/CVI Structured API Pack from `1.2.0` to `1.5.0`.
- Added `data/metadata/cvi_callback_event_catalog.json` while retaining the User Interface attribute catalog.
- Consolidated `CVI Patterns & References` into `CVI Basics`.
- Added CVIRTE lifecycle cards, editable callback typedefs, parameterized callback skeletons, grouped event selectors, event-data selectors, recipes, keywords and workflows through the updated CVI pack.
- Replaced the basic new-file prompt with **Create New File or Starter...**.
- Added blank CVI `.uir + .h` generation using embedded CVI 2012 and CVI 2020 binary resources.
- Added a complete CVI UI application starter generating `.c + .uir + .h`.
- Added paired `.c + .h` module generation with include guards.
- Added cleaned `main`, `WinMain`, `RTmain` and DLL starter templates.
- Added a cleaned generic CVI error-management module derived from the supplied legacy files.
- Added persistent user-defined creation templates with placeholder expansion.
- Added insertable built-in and user-defined CVI snippets.
- Added configurable snippet shortcut `Ctrl+Alt+I` / `Cmd+Alt+I`.
- Added editor contextual actions for inserting and saving snippets.
- Added a project-tree contextual action for saving a source or header as a creation template.
- Added `labwindowsCvi.uirTemplateVersion` with `auto`, `cvi2012` and `cvi2020` modes.

## 0.4.2

- Updated the embedded JC Lib engine from 0.7.90 to 0.7.93.
- Updated the bundled LabWindows/CVI Structured API Pack from 1.1.0 to 1.2.0.
- Added `data/metadata/cvi_ui_attribute_catalog.json`.
- Extended structured attribute pickers to the 24 `Set*Attribute` functions from the CVI User Interface API.
- Added contextual value pickers based on the selected `ATTR_*` constant.
- Added safe bundled-pack migration with a timestamped backup of the previous writable CVI pack.

## 0.4.1

- Replaced the Activity Bar IHI-style glyph with a compact CVI glyph.
- Displayed the workspace home action as a Home icon.
- Added configurable Find Symbol shortcut `Ctrl+Alt+P` / `Cmd+Alt+P`.

## 0.4.0

- Added composite branch-and-file-type SVG icons.
- Added the resizable **CVI Libraries** view below **CVI Workspace**.
- Embedded the JC Lib-based CVI function explorer.
- Added **Build Debug and Open Native Debugger**.

## 0.3.0

- Added CVI-like context menus, logical folders, new-file creation, file replacement, include/exclude toggles, `.Obj` toggling and single-file compilation.

## 0.2.0

- Added managed `.vscode/c_cpp_properties.json` generation and CVI IntelliSense paths.

## 0.1.0

- Initial CVI workspace, project, build, run and native panel-opening MVP.
