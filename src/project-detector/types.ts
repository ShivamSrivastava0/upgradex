import type { RuntimeDetectionResult } from "./runtime-types.js";
import type { DetectionEvidence } from "./evidence.js";
import type { ScanWarning } from "../safety/scan-policy.js";
import type { VersionSurfaceMap } from "./version-surface-types.js";
import type { PackageManifest } from "./manifest-reader.js";
import type { RepositoryAnalysis } from "../analyzer/change-graph.js";
export type SourceLanguage = "typescript" | "javascript" | "mixed" | "unknown";

export type DetectedLanguage = "typescript" | "javascript";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "unknown";

export type RepositoryFileCategory =
  | "source"
  | "test"
  | "config"
  | "manifest"
  | "lockfile"
  | "ci"
  | "docker"
  | "generated"
  | "sensitive"
  | "unknown";

export interface RepositoryFile {
  absolutePath: string;
  relativePath: string;
  extension: string;
  sizeBytes: number;
  category: RepositoryFileCategory;
}

export interface RepositoryInventory {
  root: string;

  files: RepositoryFile[];

  sourceFileCount: number;
  testFileCount: number;
  configFileCount: number;
  sensitiveFileCount: number;

  extensions: Record<string, number>;

  hasPackageJson: boolean;
  hasLockfile: boolean;

  packageJsonPath?: string;

  lockfiles: string[];
  configFiles: string[];
  ciFiles: string[];
  dockerFiles: string[];

  totalBytesScanned: number;

  warnings: ScanWarning[];
}

export interface LanguageEvidenceSummary {
  language: DetectedLanguage;

  sourceFileCount: number;

  sourceBytes: number;

  evidence: DetectionEvidence[];
}

export interface LanguageDetectionResult {
  value: SourceLanguage;

  languages: LanguageEvidenceSummary[];

  evidence: DetectionEvidence[];

  conflicts: string[];
}

export interface ProjectDetectionResult {
  root: string;

  language: LanguageDetectionResult;

  frameworks: FrameworkDetectionResult;

  packageManager: PackageManager;

  workspace: {
    detected: boolean;
    type: "unknown";
    packages: string[];
  };

  inventory: RepositoryInventory;

  runtime: RuntimeDetectionResult;

  versionSurfaceMap: VersionSurfaceMap;
  manifests: PackageManifest[];
  analysis: RepositoryAnalysis;
  warnings: Array<string | ScanWarning>;
}

export type FrameworkTechnology = "express" | "react" | "vite" | "typescript";

export type TechnologyCategory =
  "framework" | "build-tool" | "language-tooling";

export interface TechnologyDetection {
  technology: FrameworkTechnology;

  category: TechnologyCategory;

  declaredVersionRanges: string[];

  evidence: DetectionEvidence[];

  status: "detected" | "conflicting" | "declared-unused" | "usage-only";
}

export interface FrameworkDetectionResult {
  technologies: TechnologyDetection[];

  conflicts: string[];
}
