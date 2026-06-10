# Changelog

## 0.3.0

- Add CVI-like contextual menus for project, logical-folder, and file nodes.
- Add logical-folder creation, nested-folder creation, rename, and safe removal operations.
- Add new-file creation for C sources, headers, and text files.
- Add file replacement while preserving the corresponding CVI project entry.
- Add include/exclude toggling and CVI `.Obj` option toggling for C source files.
- Add single-file compilation through `compile.exe <file.c> <project.prj>` using the selected project build options.
- Add project-specific build, rebuild, execute, native-CVI opening, directory exploration, browsing, search, expand-all, and collapse-all actions.
- Replace the `↳` marker with a clearer `└─` branch marker for file entries.

## 0.2.0

- Automatically create or update a managed `.vscode/c_cpp_properties.json` configuration when a CVI workspace is loaded.
- Resolve the CVI Clang frontend from the selected installation and use it as the C/C++ extension `compilerPath` when available.
- Add CVI `include`, `toolslib`, `toolslib/toolbox`, workspace, and detected Windows SDK paths to IntelliSense.
- Preserve existing user-defined C/C++ configurations and modify only `LabWindows/CVI (managed)`.
- Add a manual **Synchronize C/C++ IntelliSense Configuration** command and a home-page action.
- Add an explicit `↳` marker to file entries so that expanded folder contents remain visually distinct from sibling logical folders in the native VS Code tree view.

## 0.1.0

Initial MVP:

- CVI activity-bar container and workspace tree.
- `.cws` and `.prj` parser.
- Active-project selection.
- Workspace project add/remove operations.
- Project file add/remove operations.
- CVI installation selection and discovery.
- Direct `compile.exe` build and rebuild.
- Active executable resolution and run.
- Native CVI IDE and `.uir` UI editor opening.
- Minimal CVI workspace and project generation.
