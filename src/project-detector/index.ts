export { detectProject } from "./project-detector.js";

export { buildRepositoryInventory } from "./repository-inventory.js";

export { detectLanguage } from "./language-detector.js";

export { detectFrameworks } from "./framework-detector.js";

export { readPackageManifests } from "./manifest-reader.js";

export { detectRuntime } from "./runtime-detector.js";

export { buildNodeRuntimeSurfaceMap } from "./runtime-surface-map.js";

export type { DetectionEvidence, EvidenceStrength } from "./evidence.js";

export type {
  RepositoryFile,
  RepositoryFileCategory,
  RepositoryInventory,
  SourceLanguage,
  DetectedLanguage,
  PackageManager,
  LanguageDetectionResult,
  LanguageEvidenceSummary,
  FrameworkDetectionResult,
  FrameworkTechnology,
  TechnologyCategory,
  TechnologyDetection,
  ProjectDetectionResult,
} from "./types.js";

export type * from "./runtime-types.js";

export type {
  RuntimeSurfaceMap,
  RuntimeSurfaceMapEntry,
} from "./runtime-surface-map.js";

export * from "./version-surface-types.js";
export * from "./version-surface-map.js";
