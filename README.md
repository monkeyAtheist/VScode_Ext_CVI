# LabWindows/CVI Project Manager

A Visual Studio Code extension for working with NI LabWindows/CVI workspaces and projects without maintaining per-project `.vscode/tasks.json` or `.vscode/launch.json` files.

Version `0.3.0` extends the MVP with CVI-like contextual project editing operations while retaining compatibility with older CVI 2012 projects.

## Implemented features

The extension contributes a dedicated **LabWindows/CVI** activity-bar view and a compact home page.

It can:

- open an existing `.cws` workspace or a standalone `.prj` project;
- display the CVI hierarchy as `workspace -> projects -> logical CVI folders -> files`;
- identify and change the active project stored by a `.cws` workspace;
- add an existing `.prj` project to a `.cws` workspace;
- remove a project reference from a workspace without deleting the `.prj` file;
- add `.c`, `.h`, `.uir`, `.fp`, `.lib`, `.obj`, or other files to a CVI project;
- remove a file reference from a project without deleting the file from disk;
- create, rename, and remove CVI logical folders;
- create new `.c`, `.h`, and text files directly from the project tree;
- replace an existing project file reference while preserving the CVI entry;
- include or exclude files from the build and toggle the CVI `.Obj` option for C sources;
- compile a single C file using the selected project build options;
- expose CVI-like contextual actions for projects, logical folders, and files;
- invoke CVI `compile.exe` for Debug x86, Release x86, Debug x64, or Release x64 builds;
- rebuild the active project with `-rebuild`;
- resolve and run the executable target declared in the active `.prj` file;
- open a workspace in the native CVI IDE;
- open `.uir` panels in the native CVI UI editor;
- discover common CVI installation directories and store a manually selected installation root;
- create a minimal `.cws` workspace and `.prj` project directly from VS Code;
- generate and maintain a managed C/C++ IntelliSense configuration for CVI headers.

## Installation

Install the generated `.vsix` file from VS Code:

1. Open **Extensions**.
2. Use the `...` menu.
3. Select **Install from VSIX...**.
4. Select `labwindows-cvi-project-manager-0.3.0.vsix`.

After installation, open the **LabWindows/CVI** icon in the activity bar.

## First validation sequence

Use an existing CVI workspace first:

1. Run `LabWindows/CVI: Open Workspace or Project`.
2. Select a `.cws` file.
3. Run `LabWindows/CVI: Select Installation` and choose the CVI installation root, for example `C:\Program Files (x86)\National Instruments\CVI2012`.
4. Confirm that `.vscode/c_cpp_properties.json` contains the generated `LabWindows/CVI (managed)` configuration.
5. Open a `.c` file and confirm that CVI headers such as `cvirte.h` or `userint.h` resolve correctly.
6. Confirm that the project tree matches the native CVI project tree.
7. Select a project and run **Set as Active CVI Project**.
8. Run **Build Active Project**.
9. Open a `.uir` file from the tree and confirm that the native CVI UI editor opens it.

Then validate workspace mutation on a disposable copy of a project:

1. Add a source file to a project.
2. Reopen the project in CVI.
3. Confirm that the file appears in the expected logical folder.
4. Remove the file reference from VS Code.
5. Confirm that the disk file remains present and the CVI project reference disappears.

## CVI-like contextual menus

Right-click operations are available directly in the CVI workspace tree.

Project nodes expose active-project selection, build, rebuild, execute, opening in CVI, project-file browsing, logical-folder creation, file addition, new-file creation, directory exploration, search, and tree expansion controls.

Logical-folder nodes expose rename, remove, nested-folder creation, file addition, new-file creation, directory exploration, and search. Removing a logical folder never deletes files from disk: the user chooses whether references are moved to the parent folder or removed from the CVI project.

File nodes expose open, save, include/exclude from build, `.Obj` toggling for C sources, replacement, removal, single-file compilation, browsing, directory exploration, and search.

The native VS Code tree view controls the actual indentation width. File labels use an additional `└─` branch marker so expanded logical-folder contents remain visually attached to their parent.

## Managed C/C++ IntelliSense configuration

When a CVI workspace or standalone project is loaded, the extension creates or updates `.vscode/c_cpp_properties.json` in the owning VS Code folder. It only owns the configuration named `LabWindows/CVI (managed)` and preserves the other configurations already present in the file.

The generated entry is derived from the currently selected CVI installation. It includes:

- `${workspaceFolder}/**`;
- `<CVI root>/include`;
- `<CVI root>/toolslib/**`;
- `<CVI root>/toolslib/toolbox`;
- the Windows 10 SDK include directory when detected;
- `<CVI root>/bin/clang/clang-cc.exe` as `compilerPath` when available;
- `_WINDOWS` and `_CRT_SECURE_NO_WARNINGS` defines.

The configuration is refreshed automatically after opening or creating a CVI workspace and after changing the selected CVI installation. It can also be regenerated manually with `LabWindows/CVI: Synchronize C/C++ IntelliSense Configuration` or the **Sync IntelliSense** button on the home page.

If the loaded `.cws` or `.prj` file is outside the folders currently opened in VS Code, the file is written beside the CVI workspace. Open that directory as a VS Code folder so the Microsoft C/C++ extension can consume the configuration.

## Settings

The extension contributes the following settings:

- `labwindowsCvi.installations`: known CVI installation root directories.
- `labwindowsCvi.activeInstallation`: selected installation root directory.
- `labwindowsCvi.buildMode`: `debug`, `release`, `debug64`, or `release64`.
- `labwindowsCvi.customBuildConfiguration`: optional `-config=...` argument.
- `labwindowsCvi.extraCompilerArguments`: extra arguments appended to `compile.exe`.
- `labwindowsCvi.runArguments`: arguments passed to the generated executable.
- `labwindowsCvi.projectFormatVersion`: format version written into newly generated CVI files. The default is `1200`, matching the supplied CVI 2012 examples.
- `labwindowsCvi.autoLoadWorkspace`: auto-load a `.cws` when the opened folder contains exactly one workspace within the first three directory levels.
- `labwindowsCvi.autoConfigureCppTools`: automatically maintain the managed `.vscode/c_cpp_properties.json` entry.

## Build behavior

Build does not create a VS Code task file. The extension invokes CVI `compile.exe` directly and writes the process output into the **LabWindows/CVI** output channel.

The resulting command is equivalent to:

```text
compile.exe <active-project.prj> -debug
compile.exe <active-project.prj> -release
compile.exe <active-project.prj> -debug64
compile.exe <active-project.prj> -release64
```

Optional arguments include `-rebuild`, `-config=<name>`, and the configured extra compiler arguments.

## Current limitations

This version deliberately delegates `.uir` editing to the native CVI UI editor. A `.uir` renderer and WYSIWYG editor have not been reimplemented inside VS Code.

The generated `.cws` and `.prj` files use a conservative minimal template derived from supplied CVI 2012 project files. They must be validated by opening them with each CVI release that will be supported before this generator is treated as stable.

The extension does not yet parse additional include directories declared in CVI project build settings. Version `0.3.0` covers the selected CVI installation headers, the opened VS Code workspace, and the detected Windows SDK headers.

The extension exposes the common project-tree mutation operations, but it does not yet expose all CVI project settings, such as target settings, external compiler options, distribution kits, manifest configuration, runtime binding details, DLL export settings, or per-project run working directories.

The extension currently starts built executables but does not attach a debugger. A later version can provide dynamic debug configurations without writing `launch.json` files.

## Source build

```text
npm install
npm run compile
npm run package
```

The packaging step generates a `.vsix` file.
