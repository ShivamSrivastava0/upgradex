import type { PackageManifest } from "./manifest-reader.js";
import semver from "semver";

import type {
  RuntimeCompatibilitySignal,
  RuntimeDetectionResult,
  RuntimeSurface,
} from "./runtime-types.js";

import type {
  VersionSurface,
  VersionSurfaceGroup,
  VersionSurfaceMap,
} from "./version-surface-types.js";
import type { RepositoryInventory } from "./types.js";

function createSurfaceId(
  technology: string,
  source: string,
  relativePath: string,
  line: number | undefined,
  jsonPath: string | undefined,
  suffix?: string,
): string {
  return [
    technology,
    source,
    relativePath,
    line ?? 0,
    jsonPath ?? "",
    suffix ?? "",
  ].join(":");
}

function getRuntimeSurfaceKind(
  source: RuntimeSurface["source"],
): VersionSurface["kind"] {
  switch (source) {
    case "github-actions":
      return "ci";

    case "dockerfile":
    case "docker-compose":
      return "container";

    case "vercel":
    case "serverless":
    case "devcontainer":
      return "deployment";

    default:
      return "runtime";
  }
}

function isPrimaryNodeSource(source: RuntimeSurface["source"]): boolean {
  return (
    source === "nvmrc" ||
    source === "node-version" ||
    source === "tool-versions" ||
    source === "package-engines" ||
    source === "package-dev-engines"
  );
}

function getRuntimeSurfaceValue(surface: RuntimeSurface): {
  value: string;
  rawValue: string;
} {
  const normalized = surface.constraints.map(
    (constraint) => constraint.normalized,
  );

  const raw = surface.constraints.map((constraint) => constraint.raw);

  if (normalized.length === 1) {
    return {
      value: normalized[0] ?? "",
      rawValue: raw[0] ?? "",
    };
  }

  return {
    value: `[${normalized.join(", ")}]`,
    rawValue: `[${raw.join(", ")}]`,
  };
}

function mapRuntimeSurface(
  surface: RuntimeSurface,
  index: number,
): VersionSurface {
  const values = getRuntimeSurfaceValue(surface);

  const primary = isPrimaryNodeSource(surface.source);

  return {
    id: createSurfaceId(
      "node",
      surface.source,
      surface.location.relativePath,
      surface.location.line,
      undefined,
      String(index),
    ),

    technology: "node",

    kind: getRuntimeSurfaceKind(surface.source),

    value: values.value,

    rawValue: values.rawValue,

    source: surface.source,

    location: {
      relativePath: surface.location.relativePath,

      line: surface.location.line,

      column: surface.location.column,
    },

    priority: primary ? "primary" : "secondary",

    authoritative: primary,

    evidence: surface.evidence,
  };
}

function getDependencyVersion(
  manifest: PackageManifest,
  packageName: string,
):
  | {
      section:
        | "dependencies"
        | "devDependencies"
        | "peerDependencies"
        | "optionalDependencies";
      value: string;
    }
  | undefined {
  const sections = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const;

  for (const section of sections) {
    const dependencyMap = manifest.data[section];

    if (
      dependencyMap &&
      typeof dependencyMap === "object" &&
      packageName in dependencyMap
    ) {
      const value = dependencyMap[packageName];

      if (typeof value === "string") {
        return {
          section,
          value,
        };
      }
    }
  }

  return undefined;
}

function getDependencyVersions(
  manifest: PackageManifest,
  packageName: string,
): Array<{
  section:
    | "dependencies"
    | "devDependencies"
    | "peerDependencies"
    | "optionalDependencies";
  value: string;
}> {
  const sections = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const;
  const results: Array<{
    section: (typeof sections)[number];
    value: string;
  }> = [];

  for (const section of sections) {
    const dependencies = manifest.data[section];
    const value = dependencies?.[packageName];
    if (typeof value === "string") {
      results.push({ section, value });
    }
  }
  return results;
}

function createPackageCompatibilitySurface(
  manifest: PackageManifest,
  signal: RuntimeCompatibilitySignal,
  index: number,
): VersionSurface | undefined {
  const dependency = getDependencyVersion(manifest, signal.packageName);

  if (!dependency) {
    return undefined;
  }

  const jsonPath = `${dependency.section}.${signal.packageName}`;

  return {
    id: createSurfaceId(
      "node",
      "compatibility",
      manifest.relativePath,
      undefined,
      jsonPath,
      String(index),
    ),

    technology: "node",

    kind: "compatibility",

    value: signal.versionRange,

    rawValue: signal.versionRange,

    source: "compatibility",

    location: {
      relativePath: manifest.relativePath,

      jsonPath,
    },

    priority: "secondary",

    authoritative: false,

    evidence: {
      detector: "runtime-detector",

      signal: signal.reason,

      source: manifest.relativePath,

      strength: "medium",

      location: {
        file: manifest.relativePath,
      },
    },
  };
}

function createNodeCompatibilitySurfaces(
  runtime: RuntimeDetectionResult,
  rootManifest: PackageManifest | undefined,
  manifests: PackageManifest[],
): VersionSurface[] {
  const compatibilitySurfaces: VersionSurface[] = [];

  for (let index = 0; index < runtime.compatibilitySignals.length; index += 1) {
    const signal = runtime.compatibilitySignals[index];

    if (!signal) {
      continue;
    }

    const manifest =
      manifests.find((item) => item.relativePath === signal.manifestPath) ??
      rootManifest;
    if (!manifest) continue;
    const surface = createPackageCompatibilitySurface(manifest, signal, index);

    if (surface) {
      compatibilitySurfaces.push(surface);
    }
  }

  return compatibilitySurfaces;
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)];
}

function determineNodeConsistency(
  runtime: RuntimeDetectionResult,
): VersionSurfaceGroup["consistency"] {
  switch (runtime.consistency.status) {
    case "consistent":
      return "consistent";

    case "conflicting":
      return "conflicting";

    case "mixed":
      return "mixed";

    default:
      return "insufficient-evidence";
  }
}

function createNodeGroup(
  runtime: RuntimeDetectionResult,
  rootManifest: PackageManifest | undefined,
  manifests: PackageManifest[],
): VersionSurfaceGroup {
  const runtimeSurfaces = runtime.surfaces.map(mapRuntimeSurface);

  const compatibilitySurfaces = createNodeCompatibilitySurfaces(
    runtime,
    rootManifest,
    manifests,
  );

  const surfaces = [...runtimeSurfaces, ...compatibilitySurfaces];

  const declaredValues = uniqueValues(
    runtimeSurfaces.map((surface) => surface.value),
  );

  return {
    technology: "node",

    surfaces,

    declaredValues,

    consistency: determineNodeConsistency(runtime),

    conflicts: runtime.consistency.conflicts,
  };
}

function createPackageManagerGroup(
  rootManifest: PackageManifest | undefined,
  inventory?: RepositoryInventory,
  manifests: PackageManifest[] = rootManifest ? [rootManifest] : [],
): VersionSurfaceGroup | undefined {
  const packageManager = rootManifest?.data.packageManager;
  const surfaces: VersionSurface[] = [];
  if (
    rootManifest &&
    typeof packageManager === "string" &&
    packageManager.trim().length > 0
  ) {
    const relativePath = rootManifest.relativePath;
    surfaces.push({
      id: createSurfaceId(
        "package-manager",
        "package-manager",
        relativePath,
        undefined,
        "packageManager",
      ),

      technology: "package-manager",

      kind: "tooling",

      value: packageManager,

      rawValue: packageManager,

      source: "package-manager",

      location: {
        relativePath,

        jsonPath: "packageManager",
      },

      priority: "primary",

      authoritative: true,

      evidence: {
        detector: "version-surface-map",

        signal: `package.json declares package manager ${packageManager}`,

        source: relativePath,

        strength: "high",

        location: {
          file: relativePath,
        },
      },
    });
  }
  for (const manifest of manifests) {
    if (
      manifest.isRoot ||
      typeof manifest.data.packageManager !== "string" ||
      !manifest.data.packageManager.trim()
    )
      continue;
    const workspaceManager = manifest.data.packageManager;
    surfaces.push({
      id: createSurfaceId(
        "package-manager",
        "package-manager",
        manifest.relativePath,
        undefined,
        "packageManager",
      ),
      technology: "package-manager",
      kind: "tooling",
      value: workspaceManager,
      rawValue: workspaceManager,
      source: "package-manager",
      location: {
        relativePath: manifest.relativePath,
        jsonPath: "packageManager",
      },
      priority: "secondary",
      authoritative: false,
      evidence: {
        detector: "version-surface-map",
        signal: `Workspace package.json declares package manager ${workspaceManager}`,
        source: manifest.relativePath,
        strength: "high",
        location: { file: manifest.relativePath },
      },
    });
  }
  for (const lockfile of inventory?.lockfiles ?? []) {
    surfaces.push({
      id: createSurfaceId(
        "package-manager",
        "lockfile",
        lockfile,
        undefined,
        undefined,
      ),
      technology: "package-manager",
      kind: "compatibility",
      value: lockfile.split(/[\\/]/).pop() ?? lockfile,
      rawValue: lockfile,
      source: "lockfile",
      location: { relativePath: lockfile },
      priority: "secondary",
      authoritative: false,
      evidence: {
        detector: "version-surface-map",
        signal: `Lockfile evidence found: ${lockfile}`,
        source: lockfile,
        strength: "medium",
        location: { file: lockfile },
      },
    });
  }
  if (surfaces.length === 0) return undefined;
  return {
    technology: "package-manager",
    surfaces,
    declaredValues: uniqueValues(
      surfaces
        .filter((surface) => surface.source === "package-manager")
        .map((surface) => surface.value),
    ),
    consistency: surfaces.some(
      (surface) => surface.source === "package-manager",
    )
      ? "consistent"
      : "insufficient-evidence",
    conflicts: [],
  };
}

function createExpressGroup(
  manifests: PackageManifest[],
): VersionSurfaceGroup | undefined {
  const surfaces: VersionSurface[] = [];
  for (const manifest of manifests) {
    for (const [index, dependency] of getDependencyVersions(
      manifest,
      "express",
    ).entries()) {
      const jsonPath = `${dependency.section}.express`;
      const priority =
        dependency.section === "dependencies" ? "primary" : "secondary";
      surfaces.push({
        id: createSurfaceId(
          "express",
          "package-json",
          manifest.relativePath,
          undefined,
          jsonPath,
          String(index),
        ),
        technology: "express",
        kind: "package",
        value: dependency.value,
        rawValue: dependency.value,
        source: "package-json",
        location: { relativePath: manifest.relativePath, jsonPath },
        priority,
        authoritative: priority === "primary",
        evidence: {
          detector: "version-surface-map",
          signal: `${jsonPath} declares express ${dependency.value}`,
          source: manifest.relativePath,
          strength: "high",
          location: { file: manifest.relativePath },
        },
      });
    }
  }

  if (surfaces.length === 0) {
    return undefined;
  }

  const declaredValues = uniqueValues(surfaces.map((surface) => surface.value));

  const validRanges = declaredValues.map((value) => semver.validRange(value));
  const compatible =
    validRanges.every(Boolean) &&
    validRanges.every((range, index) =>
      validRanges
        .slice(index + 1)
        .every((other) =>
          Boolean(other && range && semver.intersects(range, other)),
        ),
    );
  const conflicts = !compatible
    ? declaredValues.map((value) => `express: ${value}`)
    : [];

  return {
    technology: "express",

    surfaces,

    declaredValues,

    consistency: conflicts.length === 0 ? "consistent" : "conflicting",

    conflicts,
  };
}

function createPackageTechnologyGroup(
  manifests: PackageManifest[],
  technology: "react" | "vite" | "typescript",
  packages: string[],
): VersionSurfaceGroup | undefined {
  const surfaces: VersionSurface[] = [];
  for (const manifest of manifests) {
    for (const packageName of packages) {
      for (const [index, dependency] of getDependencyVersions(
        manifest,
        packageName,
      ).entries()) {
        const jsonPath = `${dependency.section}.${packageName}`;
        const primaryPackage = packageName === technology;
        const directDeclarationIsPrimary =
          dependency.section === "dependencies" ||
          ((technology === "vite" || technology === "typescript") &&
            dependency.section === "devDependencies");
        const priority =
          directDeclarationIsPrimary && primaryPackage
            ? "primary"
            : "secondary";
        surfaces.push({
          id: createSurfaceId(
            technology,
            "package-json",
            manifest.relativePath,
            undefined,
            jsonPath,
            String(index),
          ),
          technology,
          kind: "package",
          value: dependency.value,
          rawValue: dependency.value,
          source: "package-json",
          location: { relativePath: manifest.relativePath, jsonPath },
          priority,
          authoritative: priority === "primary",
          evidence: {
            detector: "version-surface-map",
            signal: `${jsonPath} declares ${technology} ${dependency.value}`,
            source: manifest.relativePath,
            strength: "high",
            location: { file: manifest.relativePath },
          },
        });
      }
    }
  }
  if (surfaces.length === 0) return undefined;
  const ranges = surfaces.map((surface) => semver.validRange(surface.value));
  const comparable = ranges.every(Boolean);
  let consistency: VersionSurfaceGroup["consistency"] = "insufficient-evidence";
  let conflicts: string[] = [];
  if (comparable) {
    const intersects = ranges.every((range, index) =>
      ranges
        .slice(index + 1)
        .every((other) =>
          Boolean(range && other && semver.intersects(range, other)),
        ),
    );
    consistency = intersects ? "consistent" : "conflicting";
    if (!intersects)
      conflicts = surfaces.map(
        (surface) => `${surface.location.jsonPath}: ${surface.value}`,
      );
  }
  return {
    technology,
    surfaces,
    declaredValues: uniqueValues(surfaces.map((surface) => surface.value)),
    consistency,
    conflicts,
  };
}

function createFrameworkGroups(
  manifests: PackageManifest[],
): VersionSurfaceGroup[] {
  const groups: VersionSurfaceGroup[] = [];

  const expressGroup = createExpressGroup(manifests);

  if (expressGroup) {
    groups.push(expressGroup);
  }

  const react = createPackageTechnologyGroup(manifests, "react", [
    "react",
    "react-dom",
  ]);
  const vite = createPackageTechnologyGroup(manifests, "vite", ["vite"]);
  const typescript = createPackageTechnologyGroup(manifests, "typescript", [
    "typescript",
  ]);
  if (react) groups.push(react);
  if (vite) groups.push(vite);
  if (typescript) groups.push(typescript);

  return groups;
}

export function buildVersionSurfaceMap(
  runtime: RuntimeDetectionResult,
  rootManifest: PackageManifest | undefined,
  inventory?: RepositoryInventory,
  manifests: PackageManifest[] = rootManifest ? [rootManifest] : [],
): VersionSurfaceMap {
  const groups: VersionSurfaceGroup[] = [];

  if (runtime.surfaces.length > 0 || runtime.compatibilitySignals.length > 0) {
    groups.push(createNodeGroup(runtime, rootManifest, manifests));
  }

  const frameworkGroups = createFrameworkGroups(manifests);

  groups.push(...frameworkGroups);

  const packageManagerGroup = createPackageManagerGroup(
    rootManifest,
    inventory,
    manifests,
  );

  if (packageManagerGroup) {
    groups.push(packageManagerGroup);
  }

  const warnings = [...runtime.warnings];

  if (
    runtime.compatibilitySignals.some(
      (signal) => signal.kind === "native-module",
    )
  ) {
    warnings.push(
      "Native-module compatibility surfaces are secondary evidence and require runtime/build verification before claiming upgrade safety.",
    );
  }

  if (
    runtime.compatibilitySignals.some((signal) => signal.kind === "node-types")
  ) {
    warnings.push(
      "@types/node was included as a Node.js compatibility surface.",
    );
  }

  const totalSurfaces = groups.reduce(
    (total, group) => total + group.surfaces.length,
    0,
  );

  return {
    version: 1,

    groups,

    totalSurfaces,

    totalTechnologies: groups.length,

    warnings: [...new Set(warnings)],
  };
}
