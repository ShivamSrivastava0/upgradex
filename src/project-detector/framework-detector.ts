import { SyntaxKind, type Project } from "ts-morph";
import { createSourceProject } from "./source-project.js";

import type { DetectionEvidence } from "./evidence.js";

import {
  readPackageManifests,
  type PackageManifest,
} from "./manifest-reader.js";

import type {
  FrameworkDetectionResult,
  FrameworkTechnology,
  RepositoryInventory,
  TechnologyCategory,
  TechnologyDetection,
} from "./types.js";

interface TechnologyDefinition {
  technology: FrameworkTechnology;
  category: TechnologyCategory;

  dependencyNames: string[];

  importModuleNames: string[];

  configFileNames: string[];
}

const TECHNOLOGIES: TechnologyDefinition[] = [
  {
    technology: "express",
    category: "framework",
    dependencyNames: ["express"],
    importModuleNames: ["express"],
    configFileNames: [],
  },
  {
    technology: "react",
    category: "framework",
    dependencyNames: ["react", "react-dom"],
    importModuleNames: ["react", "react-dom", "react-dom/client"],
    configFileNames: [],
  },
  {
    technology: "vite",
    category: "build-tool",
    dependencyNames: ["vite", "@vitejs/plugin-react"],
    importModuleNames: ["vite"],
    configFileNames: [
      "vite.config.ts",
      "vite.config.js",
      "vite.config.mts",
      "vite.config.mjs",
    ],
  },
  {
    technology: "typescript",
    category: "language-tooling",
    dependencyNames: ["typescript"],
    importModuleNames: ["typescript"],
    configFileNames: ["tsconfig.json", "tsconfig.base.json"],
  },
];

function allDependencyRanges(
  manifest: PackageManifest,
  dependencyName: string,
): string[] {
  const data = manifest.data;

  if (!data) {
    return [];
  }

  const ranges: string[] = [];

  for (const dependencies of [
    data.dependencies,
    data.devDependencies,
    data.peerDependencies,
    data.optionalDependencies,
  ]) {
    const value = dependencies?.[dependencyName];

    if (value) {
      ranges.push(value);
    }
  }

  return ranges;
}

function collectDependencyEvidence(
  manifests: PackageManifest[],
  definition: TechnologyDefinition,
): {
  evidence: DetectionEvidence[];
  versions: string[];
} {
  const evidence: DetectionEvidence[] = [];
  const versions: string[] = [];

  for (const manifest of manifests) {
    for (const dependencyName of definition.dependencyNames) {
      const ranges = allDependencyRanges(manifest, dependencyName);

      for (const versionRange of ranges) {
        versions.push(versionRange);

        evidence.push({
          detector: "framework",
          signal: `${dependencyName} declared as ${versionRange}`,
          source: manifest.relativePath,
          strength: "high",
          location: {
            file: manifest.relativePath,
          },
        });
      }
    }
  }

  return {
    evidence,
    versions,
  };
}

function collectImportEvidence(
  definitions: TechnologyDefinition[],
  project: Project,
): Map<FrameworkTechnology, DetectionEvidence[]> {
  const evidence = new Map(
    definitions.map(
      (definition) =>
        [definition.technology, []] as [
          FrameworkTechnology,
          DetectionEvidence[],
        ],
    ),
  );

  const definitionsByModule = new Map<string, TechnologyDefinition[]>();
  for (const definition of definitions) {
    for (const moduleName of definition.importModuleNames) {
      const matches = definitionsByModule.get(moduleName) ?? [];
      matches.push(definition);
      definitionsByModule.set(moduleName, matches);
    }
  }

  for (const sourceFile of project.getSourceFiles()) {
    for (const declaration of sourceFile.getImportDeclarations()) {
      const moduleName = declaration.getModuleSpecifierValue();
      for (const definition of definitionsByModule.get(moduleName) ?? [])
        evidence.get(definition.technology)?.push({
          detector: "framework",
          signal: `import from "${moduleName}" detected`,
          source: "source-code",
          strength: "high",
          location: {
            file: sourceFile.getFilePath(),
            line: declaration.getStartLineNumber(),
          },
        });
    }

    for (const call of sourceFile.getDescendantsOfKind(
      SyntaxKind.CallExpression,
    )) {
      const expression = call.getExpression();

      if (expression.getKind() !== SyntaxKind.Identifier) {
        continue;
      }

      if (expression.getText() !== "require") {
        continue;
      }

      const argument = call.getArguments()[0];

      if (!argument) {
        continue;
      }

      if (!(
        argument.getKind() === SyntaxKind.StringLiteral ||
        argument.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral
      )) {
        continue;
      }

      const moduleName = argument.getText().slice(1, -1);
      for (const definition of definitionsByModule.get(moduleName) ?? [])
        evidence.get(definition.technology)?.push({
          detector: "framework",
          signal: `require("${moduleName}") detected`,
          source: "source-code",
          strength: "high",
          location: {
            file: sourceFile.getFilePath(),
            line: call.getStartLineNumber(),
          },
        });
    }
  }

  return evidence;
}

function collectConfigEvidence(
  inventory: RepositoryInventory,
  definition: TechnologyDefinition,
): DetectionEvidence[] {
  const evidence: DetectionEvidence[] = [];

  const names = new Set(definition.configFileNames);

  for (const file of inventory.files) {
    if (!names.has(file.relativePath.split(/[\\/]/).pop() ?? "")) {
      continue;
    }

    evidence.push({
      detector: "framework",
      signal: `${file.relativePath} detected`,
      source: "repository-config",
      strength: "high",
      location: {
        file: file.relativePath,
      },
    });
  }

  return evidence;
}

function deduplicate(evidence: DetectionEvidence[]): DetectionEvidence[] {
  const seen = new Set<string>();

  return evidence.filter((item) => {
    const key = [
      item.detector,
      item.signal,
      item.source,
      item.location?.file ?? "",
      item.location?.line ?? "",
    ].join("|");

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function determineStatus(
  evidence: DetectionEvidence[],
): TechnologyDetection["status"] {
  const hasDependency = evidence.some((item) =>
    item.signal.includes("declared as"),
  );

  const hasSourceUsage = evidence.some(
    (item) =>
      item.signal.includes("import from") || item.signal.includes("require("),
  );

  if (hasDependency && hasSourceUsage) {
    return "detected";
  }

  if (hasDependency) {
    return "declared-unused";
  }

  if (hasSourceUsage) {
    return "usage-only";
  }

  return "usage-only";
}

export function detectFrameworks(
  inventory: RepositoryInventory,
  sourceProject: Project = createSourceProject(inventory),
): FrameworkDetectionResult {
  const manifestResult = readPackageManifests(inventory);
  const manifests = manifestResult.manifests;
  const importEvidence = collectImportEvidence(TECHNOLOGIES, sourceProject);

  const technologies: TechnologyDetection[] = [];

  const conflicts: string[] = [];

  for (const definition of TECHNOLOGIES) {
    const dependencyEvidence = collectDependencyEvidence(manifests, definition);

    const sourceEvidence = importEvidence.get(definition.technology) ?? [];

    const configEvidence = collectConfigEvidence(inventory, definition);

    const evidence = deduplicate([
      ...dependencyEvidence.evidence,
      ...sourceEvidence,
      ...configEvidence,
    ]);

    if (evidence.length === 0) {
      continue;
    }

    const uniqueVersions = [...new Set(dependencyEvidence.versions)];

    if (uniqueVersions.length > 1) {
      conflicts.push(
        `${definition.technology} has multiple declared version ranges: ${uniqueVersions.join(", ")}`,
      );
    }

    technologies.push({
      technology: definition.technology,
      category: definition.category,
      declaredVersionRanges: uniqueVersions,
      evidence,
      status:
        uniqueVersions.length > 1 ? "conflicting" : determineStatus(evidence),
    });
  }

  return {
    technologies,
    conflicts,
  };
}
