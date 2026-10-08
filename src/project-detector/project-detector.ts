import { buildRepositoryInventory } from "./repository-inventory.js";
import { detectLanguage } from "./language-detector.js";
import { detectFrameworks } from "./framework-detector.js";
import { readPackageManifests } from "./manifest-reader.js";
import { detectRuntime } from "./runtime-detector.js";
import { buildVersionSurfaceMap } from "./version-surface-map.js";
import { analyzeRepository } from "../analyzer/change-graph.js";
import { createSourceProject } from "./source-project.js";

import type { PackageManager } from "./types.js";

export interface DetectionProgress {
  stage: "index" | "project" | "versions" | "source";
  status: "start" | "complete";
  durationMs: number;
  detail?: string;
}

function detectPackageManager(
  lockfiles: string[],
  packageManagerField?: string,
): PackageManager {
  if (packageManagerField) {
    const normalized = packageManagerField.trim().toLowerCase();

    if (normalized.startsWith("pnpm@")) {
      return "pnpm";
    }

    if (normalized.startsWith("yarn@")) {
      return "yarn";
    }

    if (normalized.startsWith("bun@")) {
      return "bun";
    }

    if (normalized.startsWith("npm@")) {
      return "npm";
    }
  }

  const normalizedLockfiles = lockfiles.map(
    (file) => file.replaceAll("\\", "/").split("/").pop()?.toLowerCase() ?? "",
  );

  if (normalizedLockfiles.includes("pnpm-lock.yaml")) {
    return "pnpm";
  }

  if (normalizedLockfiles.includes("yarn.lock")) {
    return "yarn";
  }

  if (
    normalizedLockfiles.includes("bun.lock") ||
    normalizedLockfiles.includes("bun.lockb")
  ) {
    return "bun";
  }

  if (
    normalizedLockfiles.includes("package-lock.json") ||
    normalizedLockfiles.includes("npm-shrinkwrap.json")
  ) {
    return "npm";
  }

  return "unknown";
}

function detectWorkspace(
  rootManifest:
    | {
        data: {
          workspaces?: unknown;
        };
      }
    | undefined,
) {
  const workspaces = rootManifest?.data.workspaces;

  if (Array.isArray(workspaces)) {
    return {
      detected: true,
      type: "unknown" as const,
      packages: workspaces.filter(
        (item): item is string => typeof item === "string",
      ),
    };
  }

  if (
    typeof workspaces === "object" &&
    workspaces !== null &&
    !Array.isArray(workspaces)
  ) {
    const packages = (workspaces as { packages?: unknown }).packages;

    return {
      detected: true,
      type: "unknown" as const,
      packages: Array.isArray(packages)
        ? packages.filter((item): item is string => typeof item === "string")
        : [],
    };
  }

  return {
    detected: false,
    type: "unknown" as const,
    packages: [],
  };
}

function getRootManifestData(
  rootManifest:
    | {
        data: {
          packageManager?: string;
          engines?: Record<string, string>;
          devEngines?: unknown;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
          peerDependencies?: Record<string, string>;
          optionalDependencies?: Record<string, string>;
          scripts?: Record<string, string>;
          workspaces?: unknown;
        };
      }
    | undefined,
) {
  if (!rootManifest) {
    return undefined;
  }

  return {
    packageManager: rootManifest.data.packageManager,
    engines: rootManifest.data.engines,
    devEngines: rootManifest.data.devEngines,
    dependencies: rootManifest.data.dependencies,
    devDependencies: rootManifest.data.devDependencies,
    peerDependencies: rootManifest.data.peerDependencies,
    optionalDependencies: rootManifest.data.optionalDependencies,
    scripts: rootManifest.data.scripts,
    workspaces: rootManifest.data.workspaces,
  };
}

export function detectProject(
  root: string,
  onProgress?: (event: DetectionProgress) => void,
) {
  let started = Date.now();
  onProgress?.({ stage: "index", status: "start", durationMs: 0 });
  const inventory = buildRepositoryInventory(root);
  onProgress?.({
    stage: "index",
    status: "complete",
    durationMs: Date.now() - started,
    detail: `${inventory.files.length} files indexed · ${inventory.totalBytesScanned} bytes read`,
  });

  started = Date.now();
  onProgress?.({ stage: "project", status: "start", durationMs: 0 });
  const sourceProject = createSourceProject(inventory);
  onProgress?.({
    stage: "project",
    status: "complete",
    durationMs: Date.now() - started,
    detail: `${sourceProject.getSourceFiles().length} source files parsed`,
  });
  onProgress?.({ stage: "versions", status: "start", durationMs: 0 });
  started = Date.now();
  const manifestResult = readPackageManifests(inventory);
  const rootManifest = manifestResult.rootManifest;

  const manifestData = getRootManifestData(rootManifest);

  const language = detectLanguage(inventory);

  /*
   * Current framework-detector API accepts only the project root.
   * Keep that API intact for now.
   */
  const frameworks = detectFrameworks(inventory, sourceProject);

  const packageManager = detectPackageManager(
    inventory.lockfiles,
    manifestData?.packageManager,
  );

  const workspace = detectWorkspace(rootManifest);

  const runtime = detectRuntime(
    root,
    inventory,
    manifestData,
    manifestResult.manifests,
  );
  const versionSurfaceMap = buildVersionSurfaceMap(
    runtime,
    rootManifest,
    inventory,
    manifestResult.manifests,
  );
  onProgress?.({
    stage: "versions",
    status: "complete",
    durationMs: Date.now() - started,
    detail: `${versionSurfaceMap.totalSurfaces} version references across ${versionSurfaceMap.totalTechnologies} technologies`,
  });
  started = Date.now();
  onProgress?.({ stage: "source", status: "start", durationMs: 0 });
  const analysis = analyzeRepository(inventory, sourceProject);
  onProgress?.({
    stage: "source",
    status: "complete",
    durationMs: Date.now() - started,
    detail: `${analysis.analyzedSourceFiles} source files · ${analysis.analyzedTestFiles} test files · ${analysis.graph.nodes.length} graph nodes`,
  });

  return {
    root,
    language,
    frameworks,
    packageManager,
    workspace,
    inventory,
    runtime,
    versionSurfaceMap,
    analysis,
    manifests: manifestResult.manifests,
    warnings: [
      ...manifestResult.warnings,
      ...inventory.warnings,
      ...runtime.warnings,
      ...analysis.blindSpots.map((blindSpot) => blindSpot.message),
    ],
  };
}
