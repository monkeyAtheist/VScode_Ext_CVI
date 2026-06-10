# Architecture notes

## Main components

- `src/model/iniDocument.ts`: preserving INI-like document reader and writer used for `.cws` and `.prj` files.
- `src/model/cviParser.ts`: CVI-specific parsing, mutation, target resolution, and minimal project generation.
- `src/services/cviWorkspaceService.ts`: loaded-workspace lifecycle and user operations.
- `src/services/cviInstallationService.ts`: installation discovery, selected-root persistence, and CVI executable discovery.
- `src/services/cviCppToolsService.ts`: managed `.vscode/c_cpp_properties.json` generation for the Microsoft C/C++ extension.
- `src/services/cviBuildService.ts`: `compile.exe`, run, CVI IDE, and native `.uir` opening operations.
- `src/providers/cviTreeProvider.ts`: native VS Code tree view.
- `src/views/homePanel.ts`: compact PlatformIO-style entry page for global operations.

## Design rules

The `.cws` and `.prj` serializers preserve unknown sections and keys whenever an existing file is modified. This is required because CVI projects contain version-specific configuration data that must not be discarded by the extension.

Adding files appends new `[File NNNN]` sections while preserving existing resource identifiers. Removing files deletes the referenced section but does not renumber existing resource identifiers. Replacing a file updates the existing section so CVI-specific per-entry state is preserved where applicable.

Removing a workspace project reindexes `Project NNNN` references because the workspace header uses a contiguous project count and indexed references.


Logical folders are CVI metadata rather than physical directories. Folder mutation therefore edits the `[Folders]` declaration and every affected `Folder = "..."` file attribute. Removing a folder is deliberately safe: the UI asks whether file references should be moved to the parent logical folder or removed from the project. Neither choice deletes disk files.

The tree provider encodes file state in `contextValue` strings such as `cviFile.source.included.objOff`. VS Code when-clauses use these values to display state-specific context actions, including **Exclude File from Build**, **Include File in Build**, and **Toggle .Obj Option**.

The C/C++ integration intentionally writes a normal `.vscode/c_cpp_properties.json` file rather than generating `tasks.json` or `launch.json`. The Microsoft C/C++ extension consumes this standard file directly. The CVI extension owns only the configuration named `LabWindows/CVI (managed)` and preserves other configurations. The selected CVI installation remains the source of truth for compiler and system-header paths.

## Planned development passes

1. Validate the MVP on CVI 2012 with copies of production workspaces.
2. Compare generated minimal projects against projects created by CVI 2012 and the other installed CVI releases.
3. Parse additional include directories and preprocessor definitions from CVI `.prj` build configurations, then merge them into IntelliSense.
4. Refine contextual menu parity where CVI-specific behavior still requires validation on Windows, especially printing and integrated source-control actions.
5. Add an editable Project Settings webview for target paths, build configurations, runtime binding, compiler defines, include paths, DLL options, and run parameters.
6. Add workspace project creation inside an existing `.cws` file.
7. Evaluate a C/C++ custom configuration provider if removing the generated `.vscode/c_cpp_properties.json` file becomes a requirement.
8. Add optional dynamic debug configurations without generating `launch.json`.
9. Add a read-only `.uir` metadata preview only if a reliable parser for the resource format is established; retain the native CVI UI editor for modifications.
