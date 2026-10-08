import { existsSync } from "node:fs";
import { join } from "node:path";

import type {
  DetectedLanguage,
  LanguageDetectionResult,
  LanguageEvidenceSummary,
  RepositoryInventory,
} from "./types.js";

import type { DetectionEvidence } from "./evidence.js";
import { readProjectTextFile } from "../safety/safe-file-reader.js";

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface LanguageSignal {
  language: DetectedLanguage;
  evidence: DetectionEvidence;
}

const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

const JAVASCRIPT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs"]);

function readPackageJson(root: string): PackageManifest | undefined {
  const result = readProjectTextFile(root, "package.json");
  if (!result.ok || result.content === undefined) return undefined;

  try {
    const parsed: unknown = JSON.parse(result.content);

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }

    return parsed as PackageManifest;
  } catch {
    return undefined;
  }
}

function hasDependency(
  manifest: PackageManifest | undefined,
  dependencyName: string,
): boolean {
  return Boolean(
    manifest?.dependencies?.[dependencyName] ??
    manifest?.devDependencies?.[dependencyName] ??
    manifest?.peerDependencies?.[dependencyName],
  );
}

function getSourceStats(
  inventory: RepositoryInventory,
  extensions: Set<string>,
): {
  fileCount: number;
  bytes: number;
} {
  let fileCount = 0;
  let bytes = 0;

  for (const file of inventory.files) {
    if (file.category !== "source" && file.category !== "test") {
      continue;
    }

    if (!extensions.has(file.extension)) {
      continue;
    }

    fileCount += 1;
    bytes += file.sizeBytes;
  }

  return {
    fileCount,
    bytes,
  };
}

function detectConfigSignals(
  root: string,
  manifest: PackageManifest | undefined,
): LanguageSignal[] {
  const signals: LanguageSignal[] = [];

  if (existsSync(join(root, "tsconfig.json"))) {
    signals.push({
      language: "typescript",
      evidence: {
        detector: "language",
        signal: "tsconfig.json detected",
        source: "repository",
        strength: "high",
        location: {
          file: "tsconfig.json",
        },
      },
    });
  }

  if (existsSync(join(root, "tsconfig.base.json"))) {
    signals.push({
      language: "typescript",
      evidence: {
        detector: "language",
        signal: "tsconfig.base.json detected",
        source: "repository",
        strength: "high",
        location: {
          file: "tsconfig.base.json",
        },
      },
    });
  }

  if (existsSync(join(root, "jsconfig.json"))) {
    signals.push({
      language: "javascript",
      evidence: {
        detector: "language",
        signal: "jsconfig.json detected",
        source: "repository",
        strength: "medium",
        location: {
          file: "jsconfig.json",
        },
      },
    });
  }

  if (hasDependency(manifest, "typescript")) {
    signals.push({
      language: "typescript",
      evidence: {
        detector: "language",
        signal: "typescript dependency detected",
        source: "package.json",
        strength: "high",
        location: {
          file: "package.json",
        },
      },
    });
  }

  if (
    hasDependency(manifest, "@babel/preset-typescript") ||
    hasDependency(manifest, "@swc/core")
  ) {
    signals.push({
      language: "typescript",
      evidence: {
        detector: "language",
        signal: "TypeScript-capable build tooling detected",
        source: "package.json",
        strength: "medium",
        location: {
          file: "package.json",
        },
      },
    });
  }

  return signals;
}

export function detectLanguage(
  inventory: RepositoryInventory,
): LanguageDetectionResult {
  const evidence: DetectionEvidence[] = [];
  const conflicts: string[] = [];

  const root = inventory.root;
  const manifest = readPackageJson(root);

  const typeScriptStats = getSourceStats(inventory, TYPESCRIPT_EXTENSIONS);

  const javaScriptStats = getSourceStats(inventory, JAVASCRIPT_EXTENSIONS);

  if (typeScriptStats.fileCount > 0) {
    evidence.push({
      detector: "language",
      signal: `${typeScriptStats.fileCount} TypeScript source/test files detected`,
      source: "repository-inventory",
      strength: "high",
    });
  }

  if (javaScriptStats.fileCount > 0) {
    evidence.push({
      detector: "language",
      signal: `${javaScriptStats.fileCount} JavaScript source/test files detected`,
      source: "repository-inventory",
      strength: "high",
    });
  }

  const configSignals = detectConfigSignals(root, manifest);

  evidence.push(...configSignals.map((signal) => signal.evidence));

  if (
    configSignals.some((signal) => signal.language === "typescript") &&
    javaScriptStats.fileCount > 0 &&
    typeScriptStats.fileCount === 0
  ) {
    conflicts.push(
      "TypeScript tooling/configuration detected, but no TypeScript source files were found.",
    );
  }

  if (
    configSignals.some((signal) => signal.language === "javascript") &&
    typeScriptStats.fileCount > 0
  ) {
    conflicts.push(
      "JavaScript configuration detected alongside TypeScript source files.",
    );
  }

  const languages: LanguageEvidenceSummary[] = [];

  if (typeScriptStats.fileCount > 0) {
    languages.push({
      language: "typescript",
      sourceFileCount: typeScriptStats.fileCount,
      sourceBytes: typeScriptStats.bytes,
      evidence: evidence.filter(
        (item) =>
          item.signal.includes("TypeScript") ||
          item.signal.includes("tsconfig") ||
          item.signal.includes("typescript"),
      ),
    });
  }

  if (javaScriptStats.fileCount > 0) {
    languages.push({
      language: "javascript",
      sourceFileCount: javaScriptStats.fileCount,
      sourceBytes: javaScriptStats.bytes,
      evidence: evidence.filter(
        (item) =>
          item.signal.includes("JavaScript") ||
          item.signal.includes("jsconfig"),
      ),
    });
  }

  let value: LanguageDetectionResult["value"];

  if (typeScriptStats.fileCount > 0 && javaScriptStats.fileCount > 0) {
    value = "mixed";
  } else if (typeScriptStats.fileCount > 0) {
    value = "typescript";
  } else if (javaScriptStats.fileCount > 0) {
    value = "javascript";
  } else {
    value = "unknown";
  }

  return {
    value,
    languages,
    evidence,
    conflicts,
  };
}
