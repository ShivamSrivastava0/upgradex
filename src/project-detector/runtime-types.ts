import type { DetectionEvidence } from "./evidence.js";

export type RuntimeName = "node";

export type RuntimeSurfaceSource =
  | "nvmrc"
  | "node-version"
  | "tool-versions"
  | "package-engines"
  | "package-dev-engines"
  | "dockerfile"
  | "docker-compose"
  | "github-actions"
  | "vercel"
  | "serverless"
  | "devcontainer"
  | "compatibility";

export type RuntimeConstraintType =
  | "exact"
  | "major"
  | "minor"
  | "range"
  | "matrix"
  | "runtime-label"
  | "unknown";

export interface RuntimeVersionConstraint {
  raw: string;
  normalized: string;
  type: RuntimeConstraintType;
}

export interface RuntimeSurfaceLocation {
  relativePath: string;
  line?: number;
  column?: number;
}

export interface RuntimeSurface {
  runtime: RuntimeName;
  source: RuntimeSurfaceSource;
  constraints: RuntimeVersionConstraint[];
  location: RuntimeSurfaceLocation;
  evidence: DetectionEvidence;
}

export interface RuntimeCompatibilitySignal {
  kind: "node-types" | "native-module";
  packageName: string;
  versionRange: string;
  reason: string;
  manifestPath?: string;
}

export interface RuntimePackageManifest {
  engines?: Record<string, string>;
  packageManager?: string;
}

export type RuntimeConsistencyStatus =
  "consistent" | "mixed" | "conflicting" | "insufficient-evidence";

export interface RuntimeDetectionResult {
  runtime: RuntimeName;
  surfaces: RuntimeSurface[];
  compatibilitySignals: RuntimeCompatibilitySignal[];
  package?: RuntimePackageManifest;
  consistency: {
    status: RuntimeConsistencyStatus;
    normalizedTargets: string[];
    conflicts: string[];
  };
  warnings: string[];
}
