export type CviBuildMode = 'debug' | 'release' | 'debug64' | 'release64';

export interface CviBuildConfigurationDescriptor {
  name: string;
  sectionName: string;
  is64Bit: boolean;
  isRelease: boolean;
  isCustom: boolean;
  mode?: CviBuildMode;
}

export interface CviRunOptions {
  arguments: string;
  workingDirectory: string;
  environmentOptions: string;
  externalProcessPath: string;
}

export interface CviWorkspaceProjectRef {
  index: number;
  relativePath: string;
  absolutePath: string;
  name: string;
  exists: boolean;
  /** Native CVI workspace configuration stored in [Project Header NNNN]. */
  buildConfiguration?: string;
  /** Standard CVI build mode when buildConfiguration is Debug/Release/Debug64/Release64. */
  buildMode?: CviBuildMode;
}

export interface CviWorkspace {
  path: string;
  name: string;
  activeProjectIndex: number;
  projects: CviWorkspaceProjectRef[];
  cviDir?: string;
}

export interface CviProjectFile {
  sectionName: string;
  id: number;
  type: string;
  folder: string;
  relativePath?: string;
  absolutePath: string;
  excluded: boolean;
  compileIntoObjectFile: boolean;
  excludeEligible: boolean;
  projectFlags: number;
  pathForceAbsolute: boolean;
  exists: boolean;
}

export interface CviProject {
  path: string;
  name: string;
  targetType: string;
  cviDir?: string;
  folders: string[];
  files: CviProjectFile[];
}

export interface CviInstallation {
  root: string;
  label: string;
  compileExe?: string;
  ideExe?: string;
  clangCcExe?: string;
  source: 'configured' | 'workspace' | 'scan' | 'manual';
}
