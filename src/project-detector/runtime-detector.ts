import path from "node:path";

import semver from "semver";

import { readProjectTextFile } from "../safety/safe-file-reader.js";

import type { RepositoryInventory } from "./types.js";

import type {
  RuntimeCompatibilitySignal,
  RuntimeDetectionResult,
  RuntimePackageManifest,
  RuntimeSurface,
  RuntimeSurfaceLocation,
  RuntimeSurfaceSource,
  RuntimeVersionConstraint,
} from "./runtime-types.js";

interface RuntimeManifestData {
  packageManager?: string;
  engines?: Record<string, string>;
  devEngines?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function createLocation(
  relativePath: string,
  line?: number,
  column?: number,
): RuntimeSurfaceLocation {
  return {
    relativePath,
    line,
    column,
  };
}

function normalizeVersionValue(value: string): string {
  const normalized = value
    .trim()
    .replace(/^v/i, "")
    .replace(/^nodejs/i, "")
    .trim();
  const dockerTag = normalized.match(
    /^(\d+(?:\.\d+){0,2})-(?:alpine|slim|bookworm|bullseye|buster|stretch|jessie|trixie)(?:-|$)/i,
  );
  return dockerTag?.[1] ?? normalized;
}

function classifyConstraint(value: string): RuntimeVersionConstraint["type"] {
  const normalized = normalizeVersionValue(value);

  if (/^\d+$/.test(normalized)) {
    return "major";
  }

  if (/^\d+\.\d+$/.test(normalized)) {
    return "minor";
  }

  if (/^\d+\.\d+\.\d+$/.test(normalized)) {
    return "exact";
  }

  if (/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(normalized)) {
    return "exact";
  }

  if (
    normalized.includes(">") ||
    normalized.includes("<") ||
    normalized.includes("=") ||
    normalized.includes("^") ||
    normalized.includes("~") ||
    normalized.includes("*") ||
    normalized.includes("||") ||
    /\bx\b/i.test(normalized)
  ) {
    return "range";
  }

  if (/^(lts|node|current|stable)$/i.test(normalized)) {
    return "runtime-label";
  }

  return "unknown";
}

function createVersionConstraint(value: string): RuntimeVersionConstraint {
  const normalized = normalizeVersionValue(value);

  return {
    raw: value,
    normalized,
    type: classifyConstraint(value),
  };
}

function createFileSurface(
  root: string,
  filePath: string,
  source: RuntimeSurfaceSource,
): RuntimeSurface | undefined {
  const result = readProjectTextFile(root, filePath);

  if (!result.ok || !result.content) {
    return undefined;
  }

  const lines = result.content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const value = lines[index]?.trim();

    if (!value || value.startsWith("#")) {
      continue;
    }

    let runtimeValue = value;

    if (source === "tool-versions") {
      const match = value.match(
        /^\s*(?:nodejs|node)\s+(?:=\s*)?([^\s#]+)(?:\s+#.*)?$/i,
      );

      if (!match?.[1]) {
        continue;
      }

      runtimeValue = match[1];
    }

    const constraint = createVersionConstraint(runtimeValue);

    return {
      runtime: "node",
      source,
      constraints: [constraint],
      location: createLocation(filePath, index + 1, 1),
      evidence: {
        detector: "runtime-detector",
        signal: `${source} declares Node.js ${runtimeValue}`,
        source: filePath,
        strength: "high",
        location: {
          file: filePath,
          line: index + 1,
          column: 1,
        },
      },
    };
  }

  return undefined;
}

function createManifestSurface(
  filePath: string,
  source: "package-engines" | "package-dev-engines",
  value: string,
  fieldPath: string,
): RuntimeSurface {
  const constraint = createVersionConstraint(value);

  return {
    runtime: "node",
    source,
    constraints: [constraint],
    location: createLocation(filePath),
    evidence: {
      detector: "runtime-detector",
      signal: `${fieldPath} declares Node.js ${value}`,
      source: filePath,
      strength: "high",
      location: {
        file: filePath,
      },
    },
  };
}

function createDockerSurfaces(
  root: string,
  filePath: string,
  source: "dockerfile" | "docker-compose",
): RuntimeSurface[] {
  const result = readProjectTextFile(root, filePath);

  if (!result.ok || !result.content) {
    return [];
  }

  const lines = result.content.split(/\r?\n/);
  const surfaces: RuntimeSurface[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const value = lines[index]?.trim();

    if (!value || value.startsWith("#")) {
      continue;
    }

    const match =
      source === "dockerfile"
        ? value.match(
            /^FROM\s+(?:--platform=[^\s]+\s+)?node(?::([^\s@]+))?(?:@sha256:[^\s]+)?(?:\s+AS\s+[^\s]+)?$/i,
          )
        : value.match(/^image:\s*node(?::([^\s@]+))?(?:@sha256:[^\s]+)?\s*$/i);

    if (!match) {
      continue;
    }

    const runtimeValue = match[1] ?? "unknown";
    const constraint = createVersionConstraint(runtimeValue);

    surfaces.push({
      runtime: "node",
      source,
      constraints: [constraint],
      location: createLocation(filePath, index + 1, 1),
      evidence: {
        detector: "runtime-detector",
        signal: `${source} references Node.js ${runtimeValue}`,
        source: filePath,
        strength: runtimeValue === "unknown" ? "medium" : "high",
        location: {
          file: filePath,
          line: index + 1,
          column: 1,
        },
      },
    });
  }

  return surfaces;
}

function extractGithubNodeMatrixValues(content: string): Array<{
  values: string[];
  line: number;
}> {
  const lines = content.split(/\r?\n/);
  const results: Array<{
    values: string[];
    line: number;
  }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (!line) {
      continue;
    }

    const match = line.match(/^\s*node-version:\s*\[(.*?)\]\s*(?:#.*)?$/i);

    if (!match?.[1]) {
      continue;
    }

    const values = match[1]
      .split(",")
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);

    if (values.length > 0) {
      results.push({
        values,
        line: index + 1,
      });
    }
  }

  return results;
}

function createGithubActionsSurfaces(
  root: string,
  relativePath: string,
): RuntimeSurface[] {
  const result = readProjectTextFile(root, relativePath);

  if (!result.ok || !result.content) {
    return [];
  }

  const surfaces: RuntimeSurface[] = [];
  const lines = result.content.split(/\r?\n/);

  const matrixDeclarations = extractGithubNodeMatrixValues(result.content);

  const matrixValues = [
    ...new Set(matrixDeclarations.flatMap((item) => item.values)),
  ];

  const matrixLine = matrixDeclarations[0]?.line;

  for (let index = 0; index < lines.length; index += 1) {
    const value = lines[index]?.trim();

    if (!value || value.startsWith("#")) {
      continue;
    }

    const nodeVersionMatch = value.match(/(?:^|\s)node-version:\s*(.+)$/i);

    if (!nodeVersionMatch?.[1]) {
      continue;
    }

    const nodeVersionValue = nodeVersionMatch[1]
      .trim()
      .replace(/,$/, "")
      .replace(/^['"]|['"]$/g, "")
      .trim();

    if (!nodeVersionValue) {
      continue;
    }

    if (nodeVersionValue === "${{ matrix.node-version }}") {
      if (matrixValues.length > 0) {
        surfaces.push({
          runtime: "node",
          source: "github-actions",
          constraints: matrixValues.map(createVersionConstraint),
          location: createLocation(relativePath, index + 1, 1),
          evidence: {
            detector: "runtime-detector",
            signal: `GitHub Actions uses Node.js matrix ${matrixValues.join(", ")}`,
            source: relativePath,
            strength: "high",
            location: {
              file: relativePath,
              line: index + 1,
              column: 1,
            },
          },
        });
      }

      continue;
    }

    const arrayMatch = nodeVersionValue.match(/^\[(.*)\]$/);

    if (arrayMatch?.[1]) {
      const values = arrayMatch[1]
        .split(",")
        .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);

      if (values.length > 0) {
        surfaces.push({
          runtime: "node",
          source: "github-actions",
          constraints: values.map(createVersionConstraint),
          location: createLocation(relativePath, index + 1, 1),
          evidence: {
            detector: "runtime-detector",
            signal: `GitHub Actions declares Node.js matrix ${values.join(", ")}`,
            source: relativePath,
            strength: "high",
            location: {
              file: relativePath,
              line: index + 1,
              column: 1,
            },
          },
        });
      }

      continue;
    }

    surfaces.push({
      runtime: "node",
      source: "github-actions",
      constraints: [createVersionConstraint(nodeVersionValue)],
      location: createLocation(relativePath, index + 1, 1),
      evidence: {
        detector: "runtime-detector",
        signal: `GitHub Actions declares Node.js ${nodeVersionValue}`,
        source: relativePath,
        strength: "high",
        location: {
          file: relativePath,
          line: index + 1,
          column: 1,
        },
      },
    });
  }

  /*
   * Some workflows only declare the matrix and
   * do not repeat the value on setup-node.
   *
   * In that case preserve the matrix itself as
   * a detectable surface.
   */
  if (
    matrixValues.length > 0 &&
    !surfaces.some(
      (surface) =>
        surface.constraints.length === matrixValues.length &&
        surface.constraints.every((constraint) =>
          matrixValues.includes(constraint.raw),
        ),
    )
  ) {
    surfaces.push({
      runtime: "node",
      source: "github-actions",
      constraints: matrixValues.map(createVersionConstraint),
      location: createLocation(relativePath, matrixLine, 1),
      evidence: {
        detector: "runtime-detector",
        signal: `GitHub Actions declares Node.js matrix ${matrixValues.join(", ")}`,
        source: relativePath,
        strength: "high",
        location: {
          file: relativePath,
          line: matrixLine,
          column: 1,
        },
      },
    });
  }

  return surfaces;
}

function createDeploymentSurface(
  root: string,
  filePath: string,
  source: "vercel" | "serverless" | "devcontainer",
): RuntimeSurface | undefined {
  const result = readProjectTextFile(root, filePath);

  if (!result.ok || !result.content) {
    return undefined;
  }

  const lines = result.content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const value = lines[index]?.trim();

    if (!value || value.startsWith("#")) {
      continue;
    }

    let runtimeValue: string | undefined;

    if (source === "vercel") {
      const nodeRuntimeMatch = value.match(/"nodejs(\d+(?:\.\d+)?)\.x"/i);

      runtimeValue = nodeRuntimeMatch?.[1];

      if (!runtimeValue) {
        const enginesMatch = value.match(/"node"\s*:\s*"([^"]+)"/i);

        runtimeValue = enginesMatch?.[1];
      }
    }

    if (source === "serverless") {
      const match = value.match(/^\s*runtime:\s*(nodejs[^\s#]+)\s*$/i);

      runtimeValue = match?.[1];
    }

    if (source === "devcontainer") {
      const imageMatch = value.match(/["']?image["']?\s*:\s*["']([^"']+)["']/i);

      const image = imageMatch?.[1];

      if (image) {
        const nodeMatch = image.match(
          /(?:^|[-_/])node(?::|-)(\d+(?:\.\d+){0,2}(?:[-+][A-Za-z0-9.-]+)?)/i,
        );

        if (nodeMatch?.[1]) {
          runtimeValue = nodeMatch[1];
        }

        const javascriptNodeMatch = image.match(
          /javascript-node:\d*-(\d+(?:\.\d+){0,2}(?:[-+][A-Za-z0-9.-]+)?)/i,
        );

        if (!runtimeValue && javascriptNodeMatch?.[1]) {
          runtimeValue = javascriptNodeMatch[1];
        }
      }
    }

    if (!runtimeValue) {
      continue;
    }

    const normalized = normalizeVersionValue(runtimeValue);

    const constraint = createVersionConstraint(normalized);

    return {
      runtime: "node",
      source,
      constraints: [constraint],
      location: createLocation(filePath, index + 1, 1),
      evidence: {
        detector: "runtime-detector",
        signal: `${source} declares Node.js ${runtimeValue}`,
        source: filePath,
        strength: "medium",
        location: {
          file: filePath,
          line: index + 1,
          column: 1,
        },
      },
    };
  }

  return undefined;
}

function createCompatibilitySignals(
  manifest: RuntimeManifestData | undefined,
  manifestPath = "package.json",
): RuntimeCompatibilitySignal[] {
  if (!manifest) {
    return [];
  }

  const signals: RuntimeCompatibilitySignal[] = [];

  const dependencyMaps = [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.peerDependencies,
    manifest.optionalDependencies,
  ];

  for (const dependencyMap of dependencyMaps) {
    if (!dependencyMap) {
      continue;
    }

    for (const [name, version] of Object.entries(dependencyMap)) {
      if (name === "@types/node") {
        signals.push({
          kind: "node-types",
          packageName: name,
          versionRange: version,
          reason: `@types/node ${version} provides Node.js API/type compatibility signals`,
          manifestPath,
        });
      }

      if (
        name === "node-gyp" ||
        name === "node-gyp-build" ||
        name === "better-sqlite3" ||
        name === "sqlite3" ||
        name === "sharp" ||
        name === "canvas" ||
        name === "isolated-vm" ||
        name === "bindings" ||
        name === "node-pre-gyp" ||
        name === "prebuild-install"
      ) {
        signals.push({
          kind: "native-module",
          packageName: name,
          versionRange: version,
          reason: `${name} may depend on Node.js native ABI compatibility`,
          manifestPath,
        });
      }
    }
  }

  return signals;
}

function inferPackageManager(
  inventory: RepositoryInventory,
): string | undefined {
  if (inventory.lockfiles.some((file) => file === "package-lock.json")) {
    return "npm";
  }

  if (inventory.lockfiles.some((file) => file === "pnpm-lock.yaml")) {
    return "pnpm";
  }

  if (inventory.lockfiles.some((file) => file === "yarn.lock")) {
    return "yarn";
  }

  if (
    inventory.lockfiles.some(
      (file) => file === "bun.lock" || file === "bun.lockb",
    )
  ) {
    return "bun";
  }

  return undefined;
}

function extractPackageRuntime(
  manifest: RuntimeManifestData | undefined,
  inventory: RepositoryInventory,
): RuntimePackageManifest | undefined {
  if (!manifest) {
    return undefined;
  }

  return {
    engines: manifest.engines,
    packageManager: manifest.packageManager ?? inferPackageManager(inventory),
  };
}

function getSurfaceValues(surface: RuntimeSurface): string[] {
  return surface.constraints
    .map((constraint) => constraint.normalized)
    .filter(Boolean);
}

function canCompareVersion(value: string): boolean {
  return Boolean(semver.valid(value) ?? semver.validRange(value));
}

function areSurfacesConsistent(surfaces: RuntimeSurface[]): boolean {
  const comparable = surfaces.filter((surface) =>
    getSurfaceValues(surface).some(canCompareVersion),
  );

  if (comparable.length < 2) {
    return true;
  }

  const surfaceRanges = comparable.map((surface) =>
    getSurfaceValues(surface)
      .map((value) => semver.validRange(value))
      .filter((value): value is string => Boolean(value)),
  );

  for (let left = 0; left < surfaceRanges.length; left += 1) {
    for (let right = left + 1; right < surfaceRanges.length; right += 1) {
      const leftRanges = surfaceRanges[left] ?? [];

      const rightRanges = surfaceRanges[right] ?? [];

      if (leftRanges.length === 0 || rightRanges.length === 0) {
        continue;
      }

      const intersects = leftRanges.some((leftRange) =>
        rightRanges.some((rightRange) =>
          semver.intersects(leftRange, rightRange, {
            includePrerelease: true,
          }),
        ),
      );

      if (!intersects) {
        return false;
      }
    }
  }

  return true;
}

function collectRuntimeFiles(inventory: RepositoryInventory): {
  nvmrc?: string;
  nodeVersion?: string;
  toolVersions?: string;
  dockerfiles: string[];
  composeFiles: string[];
  githubActions: string[];
  vercelFiles: string[];
  serverlessFiles: string[];
  devcontainerFiles: string[];
} {
  const normalizedFiles = inventory.files.map((file) => ({
    ...file,
    relativePath: file.relativePath.replaceAll("\\", "/"),
  }));

  const nvmrc = normalizedFiles.find(
    (file) => file.relativePath === ".nvmrc",
  )?.relativePath;

  const nodeVersion = normalizedFiles.find(
    (file) => file.relativePath === ".node-version",
  )?.relativePath;

  const toolVersions = normalizedFiles.find(
    (file) => file.relativePath === ".tool-versions",
  )?.relativePath;

  const dockerfiles = inventory.dockerFiles
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => /(^|\/)dockerfile(?:\.[^/]+)?$/i.test(file));

  const composeFiles = inventory.dockerFiles
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) =>
      /(^|\/)(?:docker-compose|compose)(?:\.[^/]+)?\.ya?ml$/i.test(file),
    );

  const githubActions = inventory.ciFiles
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => file.startsWith(".github/workflows/"));

  const vercelFiles = inventory.configFiles
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => /(^|\/)vercel\.json$/i.test(file));

  const serverlessFiles = inventory.configFiles
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => /(^|\/)serverless\.ya?ml$/i.test(file));

  const devcontainerFiles = inventory.configFiles
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) =>
      /(^|\/)\.devcontainer\/(?:devcontainer\.json|Dockerfile)$/i.test(file),
    );

  return {
    nvmrc,
    nodeVersion,
    toolVersions,
    dockerfiles,
    composeFiles,
    githubActions,
    vercelFiles,
    serverlessFiles,
    devcontainerFiles,
  };
}

export function detectRuntime(
  root: string,
  inventory: RepositoryInventory,
  manifest?: RuntimeManifestData,
  manifests: Array<{ relativePath: string; data: RuntimeManifestData }> = [],
): RuntimeDetectionResult {
  const surfaces: RuntimeSurface[] = [];
  const warnings: string[] = [];

  const files = collectRuntimeFiles(inventory);

  if (files.nvmrc) {
    const surface = createFileSurface(root, files.nvmrc, "nvmrc");

    if (surface) {
      surfaces.push(surface);
    }
  }

  if (files.nodeVersion) {
    const surface = createFileSurface(root, files.nodeVersion, "node-version");

    if (surface) {
      surfaces.push(surface);
    }
  }

  if (files.toolVersions) {
    const surface = createFileSurface(
      root,
      files.toolVersions,
      "tool-versions",
    );

    if (surface) {
      surfaces.push(surface);
    }
  }

  const packageJsonFile =
    inventory.files.find(
      (file) => file.relativePath.replaceAll("\\", "/") === "package.json",
    )?.relativePath ?? "package.json";

  if (manifest?.engines?.node) {
    surfaces.push(
      createManifestSurface(
        packageJsonFile,
        "package-engines",
        manifest.engines.node,
        "engines.node",
      ),
    );
  }

  if (
    manifest?.devEngines &&
    typeof manifest.devEngines === "object" &&
    manifest.devEngines !== null
  ) {
    const devEngines = manifest.devEngines as Record<string, unknown>;

    const runtime = devEngines.runtime;

    if (typeof runtime === "string") {
      surfaces.push(
        createManifestSurface(
          packageJsonFile,
          "package-dev-engines",
          runtime,
          "devEngines.runtime",
        ),
      );
    }

    if (
      typeof runtime === "object" &&
      runtime !== null &&
      !Array.isArray(runtime)
    ) {
      const runtimeObject = runtime as Record<string, unknown>;

      if (typeof runtimeObject.version === "string") {
        surfaces.push(
          createManifestSurface(
            packageJsonFile,
            "package-dev-engines",
            runtimeObject.version,
            "devEngines.runtime.version",
          ),
        );
      }
    }
  }

  for (const dockerfile of files.dockerfiles) {
    surfaces.push(...createDockerSurfaces(root, dockerfile, "dockerfile"));
  }

  for (const composeFile of files.composeFiles) {
    surfaces.push(...createDockerSurfaces(root, composeFile, "docker-compose"));
  }

  for (const workflow of files.githubActions) {
    surfaces.push(...createGithubActionsSurfaces(root, workflow));
  }

  for (const vercelFile of files.vercelFiles) {
    const surface = createDeploymentSurface(root, vercelFile, "vercel");

    if (surface) {
      surfaces.push(surface);
    }
  }

  for (const serverlessFile of files.serverlessFiles) {
    const surface = createDeploymentSurface(root, serverlessFile, "serverless");

    if (surface) {
      surfaces.push(surface);
    }
  }

  for (const devcontainerFile of files.devcontainerFiles) {
    const surface = createDeploymentSurface(
      root,
      devcontainerFile,
      "devcontainer",
    );

    if (surface) {
      surfaces.push(surface);
    }
  }

  const compatibilitySignals =
    manifests.length > 0
      ? manifests.flatMap((item) =>
          createCompatibilitySignals(item.data, item.relativePath),
        )
      : createCompatibilitySignals(manifest);

  const consistency = areSurfacesConsistent(surfaces);

  const normalizedTargets = surfaces.flatMap(getSurfaceValues);

  const conflicts = consistency
    ? []
    : surfaces.map((surface) => {
        const values = getSurfaceValues(surface).join(", ");

        return `${surface.location.relativePath}: ${values}`;
      });

  if (surfaces.length === 0) {
    warnings.push("No explicit Node.js runtime version surface was detected.");
  }

  if (surfaces.length > 1 && !consistency) {
    warnings.push(
      "Node.js runtime declarations are inconsistent across repository surfaces.",
    );
  }

  if (compatibilitySignals.some((signal) => signal.kind === "native-module")) {
    warnings.push(
      "Native-module dependencies were detected; Node.js runtime upgrades may require ABI/build verification.",
    );
  }

  if (compatibilitySignals.some((signal) => signal.kind === "node-types")) {
    warnings.push(
      "Node.js type compatibility signals were detected through @types/node.",
    );
  }

  const packageRuntime = extractPackageRuntime(manifest, inventory);

  return {
    runtime: "node",
    surfaces,
    compatibilitySignals,
    package: packageRuntime,
    consistency: {
      status:
        surfaces.length === 0
          ? "insufficient-evidence"
          : consistency
            ? "consistent"
            : "conflicting",

      normalizedTargets,

      conflicts,
    },
    warnings,
  };
}

export function getRuntimeSurfacePath(
  root: string,
  surface: RuntimeSurface,
): string {
  return path.resolve(root, surface.location.relativePath);
}

export function getRuntimeSurfaceLine(
  surface: RuntimeSurface,
): number | undefined {
  return surface.location.line;
}

export function getRuntimeSurfaceEvidence(surface: RuntimeSurface) {
  return surface.evidence;
}

export function getRuntimeSurfaceSource(
  surface: RuntimeSurface,
): RuntimeSurfaceSource {
  return surface.source;
}
