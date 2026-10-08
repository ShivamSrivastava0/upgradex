import type {
  RuntimeDetectionResult,
  RuntimeSurface,
} from "./runtime-types.js";

export interface RuntimeSurfaceMapEntry {
  runtime: "node";

  value: string;

  source: RuntimeSurface["source"];

  filePath: string;

  line?: number;

  jsonPath?: string;

  authoritative: boolean;
}

export interface RuntimeSurfaceMap {
  runtime: "node";

  surfaceCount: number;

  entries: RuntimeSurfaceMapEntry[];

  currentTargets: string[];

  consistency: RuntimeDetectionResult["consistency"];

  compatibilitySignals: RuntimeDetectionResult["compatibilitySignals"];

  warnings: string[];
}

export function buildNodeRuntimeSurfaceMap(
  detection: RuntimeDetectionResult,
): RuntimeSurfaceMap {
  const entries = detection.surfaces.map((surface) => ({
    runtime: "node" as const,

    value: surface.constraints[0]?.raw ?? "",

    source: surface.source,

    filePath: surface.location.relativePath,

    line: surface.location.line,

    jsonPath:
      surface.source === "package-engines"
        ? "engines.node"
        : surface.source === "package-dev-engines"
          ? "devEngines.runtime.version"
          : undefined,

    authoritative:
      surface.source === "package-engines" ||
      surface.source === "package-dev-engines" ||
      surface.source === "nvmrc" ||
      surface.source === "node-version" ||
      surface.source === "tool-versions",
  }));

  return {
    runtime: "node",

    surfaceCount: entries.length,

    entries,

    currentTargets: detection.consistency.normalizedTargets,

    consistency: detection.consistency,

    compatibilitySignals: detection.compatibilitySignals,

    warnings: detection.warnings,
  };
}
