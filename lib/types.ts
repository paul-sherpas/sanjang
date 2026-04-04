// Central type definitions for Sanjang

export interface Camp {
  name: string;
  branch: string;
  slot: number;
  fePort: number;
  bePort: number;
  url?: string;
  status: "stopped" | "starting" | "starting-frontend" | "running" | "setting-up" | "error";
  description?: string;
  baseCommit?: string;
  parentBranch?: string;
}

export interface DevConfig {
  command: string;
  port: number;
  portFlag: string | null;
  cwd: string;
  env: Record<string, string>;
}

export interface BackendConfig {
  command: string;
  port: number;
  healthCheck?: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface PortRange {
  base: number;
  slots: number;
}

export interface PortsConfig {
  fe: PortRange;
  be: PortRange;
}

export interface SanjangConfig {
  dev: DevConfig;
  setup: string | null;
  copyFiles: string[];
  backend: BackendConfig | null;
  ports: PortsConfig;
  _autoDetected?: boolean;
}

export interface PortAllocation {
  slot: number;
  fePort: number;
  bePort: number;
}

export interface PortStatus extends PortAllocation {
  feBusy: boolean;
  beBusy: boolean;
}

export interface CacheValidation {
  valid: boolean;
  reason?: string;
}

export interface CacheBuildResult {
  success: boolean;
  error?: string;
  duration: number;
}

export interface CacheApplyResult {
  applied: boolean;
  reason?: string;
  duration?: number;
  count?: number;
}

export interface LockfileInfo {
  path: string;
  name: string;
}

export interface DetectedProject {
  framework: string;
  dev: DevConfig;
  setup: string | null;
  copyFiles: string[];
  _note?: string;
}

export interface DetectedApp {
  dir: string;
  framework: string;
  detected: DetectedProject;
}

export interface GenerateConfigResult {
  created: boolean;
  framework?: string;
  configPath?: string;
  message: string;
}

export interface SnapshotInfo {
  name: string;
  date: string;
  message: string;
}

export interface DiagnosticsResult {
  status: string;
  checks: DiagnosticsCheck[];
}

export interface DiagnosticsCheck {
  name: string;
  ok: boolean;
  message: string;
}

export type BroadcastMessage = {
  type: string;
  name?: string;
  source?: string;
  data?: unknown;
};

export type EventCallback = (event: BroadcastMessage) => void;

export interface ChangeReportFile {
  path: string;
  status: "수정" | "추가" | "삭제" | "새 파일";
  category: "ui" | "api" | "config" | "test" | "docs" | "other";
}

export interface ChangeReportWarning {
  type: "config" | "db" | "env" | "infra" | "security";
  message: string;
  file: string;
}

export interface ChangeReport {
  files: ChangeReportFile[];
  totalCount: number;
  byCategory: Record<string, ChangeReportFile[]>;
  warnings: ChangeReportWarning[];
  summary: string | null;
  humanDescription: string | null;
  categoryDetails: Record<string, string[]> | null; // 카테고리별 변경 내용 설명
}
