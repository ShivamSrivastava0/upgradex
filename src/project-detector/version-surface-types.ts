import type { DetectionEvidence } from "./evidence.js";

export type VersionSurfaceTechnology =
  "node" | "express" | "react" | "vite" | "typescript" | "package-manager";

export type VersionSurfaceKind =
  | "runtime"
  | "framework"
  | "tooling"
  | "package"
  | "ci"
  | "container"
  | "deployment"
  | "compatibility";

export type VersionSurfacePriority = "primary" | "secondary";

export type VersionSurfaceConsistency =
  "consistent" | "mixed" | "conflicting" | "insufficient-evidence";

export interface VersionSurfaceLocation {
  relativePath: string;
  line?: number;
  column?: number;
  jsonPath?: string;
}

export interface VersionSurface {
  id: string;

  technology: VersionSurfaceTechnology;
  kind: VersionSurfaceKind;

  value: string;
  rawValue: string;

  source: string;

  location: VersionSurfaceLocation;

  priority: VersionSurfacePriority;

  authoritative: boolean;

  evidence: DetectionEvidence;
}

export interface VersionSurfaceGroup {
  technology: VersionSurfaceTechnology;

  surfaces: VersionSurface[];

  declaredValues: string[];

  consistency: VersionSurfaceConsistency;

  conflicts: string[];
}

export interface VersionSurfaceMap {
  version: 1;

  groups: VersionSurfaceGroup[];

  totalSurfaces: number;

  totalTechnologies: number;

  warnings: string[];
}
