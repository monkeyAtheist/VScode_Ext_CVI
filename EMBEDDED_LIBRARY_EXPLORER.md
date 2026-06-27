# Embedded CVI library explorer

The `src/jcLibEmbedded.ts` module is derived from the user-supplied JC Lib `0.7.90` source archive and namespaced for integration into the LabWindows/CVI Project Manager extension.

The integration keeps the existing structured-pack tree, search, generated-call insertion, function-details webview and visual pack editor workflows. The project manager seeds `data/cvi_pack.json` into extension storage on first activation so the integrated view opens directly on the CVI API surface.
