# Templates and snippets guide

## Creation wizard

Open a CVI project, right-click the project or a logical folder, then run **Create New File or Starter...**.

The wizard can generate one file or a coordinated starter set. Existing files are never overwritten silently. When a generated filename already exists, choose either:

- **Keep existing and add references**;
- **Overwrite generated files**;
- cancel the operation.

## User creation templates

Run **LabWindows/CVI: Manage Creation Templates...**. A text file can be saved as a reusable template or imported from disk.

Templates support these placeholders:

| Placeholder | Meaning |
|---|---|
| `{{baseName}}` | output filename without extension |
| `{{fileName}}` | output filename |
| `{{headerFile}}` | generated or associated header filename |
| `{{guard}}` | normalized uppercase include guard |
| `{{prefix}}` | normalized uppercase module prefix |
| `{{uirFile}}` | associated UIR filename |
| `{{date}}` | ISO generation date |
| `{{year}}` | generation year |

## Snippet insertion

Run **LabWindows/CVI: Insert CVI Snippet...** or press `Ctrl+Alt+I` (`Cmd+Alt+I` on macOS). The selected snippet is inserted at the current cursor position through VS Code `SnippetString`, so tab stops such as `${1:panel}` remain interactive.

To add a personal snippet, select code in the editor and run **LabWindows/CVI: Save Selection as CVI Snippet...**.
