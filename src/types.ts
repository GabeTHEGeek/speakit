export type AppStatus = "ready" | "starting" | "recording" | "transcribing" | "error";

export type FocusTarget = { appName: string; role: string; canPaste: boolean };

export type ActiveTarget = {
  appName: string;
  pid: number;
  anchorX: number;
  anchorY: number;
};

export type PasteResult = { focusedRole: string; focusedSubrole: string };

export type DiagnosticReport = {
  version: string;
  accessibilityReady: boolean;
  modelReady: boolean;
  modelSizeMb: number;
  installLocation: string;
  executablePath: string;
  logPath: string;
  recentLog: string;
};
