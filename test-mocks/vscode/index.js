module.exports = {
  Uri: { file: (fsPath) => ({ fsPath }) },
  window: {},
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) }
};
