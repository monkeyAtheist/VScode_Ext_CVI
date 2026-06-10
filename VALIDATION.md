# Validation report for version 0.3.0

## Automated local checks completed

The TypeScript source compiles successfully with `npm run compile`.

The CVI parser was previously exercised against the supplied workspace and project examples:

- parsed `fileEdition_main.cws` as a workspace with one active project;
- parsed `fileEdition_main.prj` as an executable project with 53 files;
- resolved the Debug x86 output target as `EditDB.exe`;
- copied a supplied `.prj`, added a new `.c` file reference, reparsed the project, then removed the reference;
- generated a new minimal `WS.cws` and `APP.prj`, reparsed both, and resolved the generated Debug x86 target as `APP.exe`.

The compiled IntelliSense synchronization service:

- derives CVI include paths from the selected installation root;
- detects `bin/clang/clang-cc.exe` when present;
- detects the Windows 10 SDK include root when present;
- creates `.vscode/c_cpp_properties.json` when absent;
- preserves configurations not named `LabWindows/CVI (managed)`;
- accepts JSON-with-comments and trailing commas when reading an existing configuration;
- refuses to overwrite an invalid existing JSON document.

Version `0.3.0` also exercises project-tree mutations on a disposable copy of the supplied `GR_IHM.prj` example:

- adds a nested logical folder;
- adds a new C source reference into that folder;
- renames a parent logical folder and verifies descendant migration;
- toggles `Exclude`;
- toggles `Compile Into Object File`;
- replaces the C source reference with a header reference and verifies that the `.Obj` field is removed;
- removes a logical folder while moving contents to its parent;
- removes a logical folder together with its CVI file references while leaving disk files untouched.

## Checks requiring a Windows machine with LabWindows/CVI

The following points cannot be validated in the packaging environment:

- actual discovery of installed CVI directories;
- exact `compile.exe`, `cvi.exe`, and `clang-cc.exe` locations for each installed CVI release;
- successful build with CVI 2012 and any newer CVI release;
- C/C++ IntelliSense resolution of CVI headers after selecting a real installation;
- opening generated `.cws` and `.prj` files inside the native CVI IDE;
- direct opening of `.uir` files through `cvi.exe`;
- actual single-file compilation through `compile.exe <file.c> <project.prj>`;
- runtime behavior of contextual expand-all and collapse-all actions in the installed VS Code host;
- compatibility of minimal generated project sections with every supported CVI version.
