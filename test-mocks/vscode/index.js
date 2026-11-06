const fs = require('fs');
const path = require('path');
const state = { input: undefined, warningResponse: undefined, warnings: [], infos: [], errors: [], failDelete: false, config: {} };
class EventEmitter {
  constructor(){ this.event = () => ({ dispose(){} }); }
  fire(){}
  dispose(){}
}
const disposable=()=>({dispose(){}});
module.exports = {
  __state: state,
  EventEmitter,
  Uri: { file: (fsPath) => ({ fsPath }) },
  window: {
    async showInputBox(){ return state.input; },
    async showWarningMessage(message, ...args){ state.warnings.push({message,args}); return state.warningResponse; },
    async showInformationMessage(message, ...args){ state.infos.push({message,args}); return undefined; },
    async showErrorMessage(message, ...args){ state.errors.push(message); return undefined; },
    async showOpenDialog(){ return undefined; }
  },
  workspace: {
    getConfiguration: () => ({ get: (key, fallback) => Object.prototype.hasOwnProperty.call(state.config, key) ? state.config[key] : fallback, async update(key, value){ state.config[key] = value; } }),
    onDidSaveTextDocument: disposable,
    onDidChangeWorkspaceFolders: disposable,
    textDocuments: [],
    workspaceFolders: [],
    fs: {
      async rename(from,to,opts={}){
        if(!opts.overwrite && fs.existsSync(to.fsPath)) throw new Error('target exists');
        fs.renameSync(from.fsPath,to.fsPath);
      },
      async delete(uri,opts={}){
        if(state.failDelete) throw new Error('simulated trash failure');
        fs.rmSync(uri.fsPath,{force:false,recursive:!!opts.recursive});
      }
    }
  },
  env: { clipboard: { async writeText(){} } },
  commands: { async executeCommand(){} },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 }
};
