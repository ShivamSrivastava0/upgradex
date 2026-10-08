import { readProjectTextFile } from "../safety/safe-file-reader.js";
import type { RepositoryInventory } from "./types.js";

export interface PackageManifestData {
  name?: string;
  version?: string;
  private?: boolean;

  packageManager?: string;

  engines?: Record<string, string>;

  devEngines?: unknown;

  dependencies?: Record<string, string>;

  devDependencies?: Record<string, string>;

  peerDependencies?: Record<string, string>;

  optionalDependencies?: Record<string, string>;

  bundledDependencies?: string[];

  scripts?: Record<string, string>;

  workspaces?:
    | string[]
    | {
        packages?: string[];
        nohoist?: string[];
      };

  [key: string]: unknown;
}

export interface PackageManifest {
  absolutePath: string;
  relativePath: string;

  data: PackageManifestData;

  isRoot: boolean;
}

export interface PackageManifestReadResult {
  manifests: PackageManifest[];

  rootManifest?: PackageManifest;

  warnings: string[];
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((item) => typeof item === "string");
}

function normalizeManifest(value: unknown): PackageManifestData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const raw = value as Record<string, unknown>;

  const result: PackageManifestData = {};

  if (typeof raw.name === "string") {
    result.name = raw.name;
  }

  if (typeof raw.version === "string") {
    result.version = raw.version;
  }

  if (typeof raw.private === "boolean") {
    result.private = raw.private;
  }

  if (typeof raw.packageManager === "string") {
    result.packageManager = raw.packageManager;
  }

  if (isStringRecord(raw.engines)) {
    result.engines = raw.engines;
  }

  if (raw.devEngines !== undefined) {
    result.devEngines = raw.devEngines;
  }

  if (isStringRecord(raw.dependencies)) {
    result.dependencies = raw.dependencies;
  }

  if (isStringRecord(raw.devDependencies)) {
    result.devDependencies = raw.devDependencies;
  }

  if (isStringRecord(raw.peerDependencies)) {
    result.peerDependencies = raw.peerDependencies;
  }

  if (isStringRecord(raw.optionalDependencies)) {
    result.optionalDependencies = raw.optionalDependencies;
  }

  if (
    Array.isArray(raw.bundledDependencies) &&
    raw.bundledDependencies.every((item) => typeof item === "string")
  ) {
    result.bundledDependencies = raw.bundledDependencies;
  }

  if (isStringRecord(raw.scripts)) {
    result.scripts = raw.scripts;
  }

  if (
    Array.isArray(raw.workspaces) &&
    raw.workspaces.every((item) => typeof item === "string")
  ) {
    result.workspaces = raw.workspaces;
  } else if (
    typeof raw.workspaces === "object" &&
    raw.workspaces !== null &&
    !Array.isArray(raw.workspaces)
  ) {
    const workspaceObject = raw.workspaces as Record<string, unknown>;

    const packages =
      Array.isArray(workspaceObject.packages) &&
      workspaceObject.packages.every((item) => typeof item === "string")
        ? workspaceObject.packages
        : undefined;

    const nohoist =
      Array.isArray(workspaceObject.nohoist) &&
      workspaceObject.nohoist.every((item) => typeof item === "string")
        ? workspaceObject.nohoist
        : undefined;

    result.workspaces = {
      packages,
      nohoist,
    };
  }

  /*
   * Keep the remaining package.json metadata.
   *
   * This is useful later for dependency intelligence,
   * version surface analysis and package-specific detectors.
   */
  for (const [key, item] of Object.entries(raw)) {
    if (!(key in result)) {
      result[key] = item;
    }
  }

  return result;
}

function parseManifest(
  content: string,
  relativePath: string,
): PackageManifestData {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Invalid JSON in ${relativePath}`);
  }

  return normalizeManifest(parsed);
}

export function readPackageManifests(
  inventory: RepositoryInventory,
): PackageManifestReadResult {
  const manifests: PackageManifest[] = [];
  const warnings: string[] = [];

  /*
   * The inventory currently identifies package.json
   * files as manifest files.
   *
   * We intentionally read only package.json files that
   * were already discovered by the repository inventory.
   */
  const packageFiles = inventory.files.filter((file) =>
    file.relativePath.replaceAll("\\", "/").endsWith("package.json"),
  );

  for (const file of packageFiles) {
    const result = readProjectTextFile(inventory.root, file.relativePath);

    if (!result.ok || !result.content) {
      if (result.warning) {
        warnings.push(result.warning);
      }

      continue;
    }

    try {
      const data = parseManifest(result.content, file.relativePath);

      manifests.push({
        absolutePath: file.absolutePath,

        relativePath: file.relativePath,

        data,

        isRoot: file.relativePath === "package.json",
      });
    } catch (error) {
      warnings.push(
        error instanceof Error
          ? error.message
          : `Unable to parse ${file.relativePath}`,
      );
    }
  }

  const rootManifest = manifests.find((manifest) => manifest.isRoot);

  return {
    manifests,
    rootManifest,
    warnings,
  };
}
