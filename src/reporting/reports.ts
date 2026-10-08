import type { ProjectDetectionResult } from "../project-detector/types.js";
import type { ImpactFinding } from "../impact-engine/impact-engine.js";
import type { ProofDocument } from "../verifier/verifier.js";
import type { UpgradeSelection } from "../upgrade-pipeline.js";
import {
  createMigrationPreview,
  type MigrationPreview,
} from "../migration-engine/migration-engine.js";
import { getProductVersion } from "../product-metadata.js";
import { hasCriticalScanGaps } from "../safety/scan-policy.js";

export interface ScanDiagnostic {
  code: string;
  summary: string;
  count: number;
  examples: string[];
  incomplete: boolean;
}

export interface ScanReport {
  schemaVersion: 1;
  project: {
    root: string;
    name?: string;
    language: string;
    packageManager: string;
    technologies: Array<{ name: string; versionRanges: string[] }>;
  };
  versionSurfaces: ProjectDetectionResult["versionSurfaceMap"];
  findings: ImpactFinding[];
  migrations: Array<{
    ruleId: string;
    codemod?: string;
    status: "available" | "manual";
  }>;
  verification: ProofDocument["verification"];
  blindSpots: string[];
  diagnostics: ScanDiagnostic[];
  scan: {
    indexedFiles: number;
    sourceFiles: number;
    testFiles: number;
    bytesRead: number;
    incomplete: boolean;
  };
  ruleCoverage: {
    available: number;
    applicable: number;
  };
  summary: {
    findingsBySeverity: Record<"critical" | "high" | "medium" | "low", number>;
    affectedFiles: number;
    affectedRoutes: number;
    impactPaths: number;
    resolvedFindings: number;
    heuristicFindings: number;
    automaticMigrations: number;
    manualMigrations: number;
  };
  finalStatus:
    | "VERIFIED FOR OBSERVED CHECKS"
    | "NEEDS MIGRATION"
    | "BLOCKED"
    | "INCONCLUSIVE"
    | "OVERVIEW ONLY"
    | "READY TO REVIEW";
  selection?: UpgradeSelection;
}

export function createScanReport(
  project: ProjectDetectionResult,
  findings: ImpactFinding[] = [],
  verification: ProofDocument["verification"] = [],
  selection?: UpgradeSelection,
  ruleCoverage: ScanReport["ruleCoverage"] = { available: 0, applicable: 0 },
): ScanReport {
  const manifest = project.manifests.find((item) => item.isRoot);
  const diagnostics = createDiagnostics(project);
  const selectedSurface = selection
    ? project.versionSurfaceMap.groups.find(
        (group) => group.technology === selection.technology,
      )
    : undefined;
  const incomplete =
    hasCriticalScanGaps(
      project.inventory.warnings,
      project.analysis.blindSpots,
    ) || selectedSurface?.consistency === "conflicting";
  const findingsBySeverity = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  const migrationPreview = createMigrationPreview(project.inventory, findings);
  const automaticallyPreviewableRuleIds = new Set(
    migrationPreview.files.flatMap((file) => file.ruleIds),
  );
  for (const finding of findings) findingsBySeverity[finding.severity] += 1;
  const affectedFiles = new Set<string>();
  const affectedRoutes = new Set<string>();
  const impactPaths = new Set<string>();
  for (const finding of findings) {
    affectedFiles.add(finding.location.file);
    for (const file of finding.impact.affectedFiles) affectedFiles.add(file);
    for (const route of finding.impact.affectedRoutes)
      affectedRoutes.add(route);
    for (const edge of finding.impact.traversal)
      impactPaths.add(`${edge.from}\0${edge.edge}\0${edge.to}`);
  }
  const hasVerificationFailure = verification.some((result) =>
    ["failed", "timed_out", "blocked"].includes(result.status),
  );
  const hasUnconfiguredVerification = verification.some(
    (result) => result.status === "not_configured",
  );
  const finalStatus: ScanReport["finalStatus"] = hasVerificationFailure
    ? "BLOCKED"
    : findings.length > 0
      ? "NEEDS MIGRATION"
      : incomplete || hasUnconfiguredVerification
        ? "INCONCLUSIVE"
        : verification.length > 0 &&
            verification.every((result) => result.status === "passed")
          ? "VERIFIED FOR OBSERVED CHECKS"
          : !selection && verification.length === 0
            ? "OVERVIEW ONLY"
            : "READY TO REVIEW";
  return {
    schemaVersion: 1,
    project: {
      root: project.root,
      ...(manifest?.data.name ? { name: manifest.data.name } : {}),
      language: project.language.value,
      packageManager: project.packageManager,
      technologies: project.versionSurfaceMap.groups.map((group) => ({
        name: group.technology,
        versionRanges: group.surfaces
          .filter((surface) => surface.priority === "primary")
          .map((surface) => surface.rawValue),
      })),
    },
    versionSurfaces: project.versionSurfaceMap,
    findings,
    migrations: findings.map((finding) => ({
      ruleId: finding.ruleId,
      ...(automaticallyPreviewableRuleIds.has(finding.ruleId) && finding.codemod
        ? { codemod: finding.codemod }
        : {}),
      status: automaticallyPreviewableRuleIds.has(finding.ruleId)
        ? "available"
        : "manual",
    })),
    verification,
    blindSpots: [
      ...new Set([
        ...project.analysis.blindSpots.map(
          (spot) => `${spot.code}: ${spot.message}`,
        ),
        ...project.warnings.map((warning) =>
          typeof warning === "string"
            ? warning
            : `${warning.code}: ${warning.message}`,
        ),
      ]),
    ].sort(),
    diagnostics,
    scan: {
      indexedFiles: project.inventory.files.length,
      sourceFiles: project.analysis.analyzedSourceFiles,
      testFiles: project.analysis.analyzedTestFiles,
      bytesRead: project.inventory.totalBytesScanned,
      incomplete,
    },
    ruleCoverage,
    summary: {
      findingsBySeverity,
      affectedFiles: affectedFiles.size,
      affectedRoutes: affectedRoutes.size,
      impactPaths: impactPaths.size,
      resolvedFindings: findings.filter(
        (finding) => finding.evidence.resolution === "resolved",
      ).length,
      heuristicFindings: findings.filter(
        (finding) => finding.evidence.resolution === "heuristic",
      ).length,
      automaticMigrations: findings.filter((finding) =>
        automaticallyPreviewableRuleIds.has(finding.ruleId),
      ).length,
      manualMigrations: findings.filter(
        (finding) => !automaticallyPreviewableRuleIds.has(finding.ruleId),
      ).length,
    },
    finalStatus,
    ...(selection ? { selection } : {}),
  };
}

function level(
  severity: ImpactFinding["severity"],
): "error" | "warning" | "note" {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium") return "warning";
  return "note";
}

function createDiagnostics(project: ProjectDetectionResult): ScanDiagnostic[] {
  const diagnostics = new Map<string, ScanDiagnostic>();
  const add = (
    code: string,
    summary: string,
    example?: string,
    incomplete = false,
  ) => {
    const current = diagnostics.get(code) ?? {
      code,
      summary,
      count: 0,
      examples: [],
      incomplete,
    };
    current.count += 1;
    current.incomplete ||= incomplete;
    if (
      example &&
      current.examples.length < 3 &&
      !current.examples.includes(example)
    )
      current.examples.push(example);
    diagnostics.set(code, current);
  };

  for (const warning of project.inventory.warnings) {
    const summaries: Record<string, string> = {
      FILE_TOO_LARGE: "Oversized files skipped; contents were not read.",
      FILE_LIMIT_REACHED: "The configured file-count limit stopped the scan.",
      TOTAL_SIZE_LIMIT_REACHED:
        "The configured total-size limit stopped the scan.",
      SENSITIVE_FILE:
        "Sensitive files were skipped without reading their contents.",
      SYMLINK_SKIPPED: "Symbolic links were skipped for scan safety.",
      READ_ERROR: "Some paths could not be read.",
    };
    const incomplete =
      ["FILE_LIMIT_REACHED", "TOTAL_SIZE_LIMIT_REACHED", "READ_ERROR"].includes(
        warning.code,
      ) ||
      (warning.code === "FILE_TOO_LARGE" &&
        (/\.(?:[cm]?[jt]sx?)$/i.test(warning.relativePath) ||
          /(?:^|[\\/])package\.json$/i.test(warning.relativePath)));
    add(
      warning.code,
      summaries[warning.code] ?? "Repository scan warning.",
      warning.code === "SENSITIVE_FILE" ? undefined : warning.relativePath,
      incomplete,
    );
  }

  const blindSpotSummaries: Record<string, string> = {
    DYNAMIC_CODE: "Dynamic code prevents complete static impact tracing.",
    DYNAMIC_REQUIRE: "Some dynamic require targets could not be resolved.",
    DYNAMIC_IMPORT: "Some dynamic import targets could not be resolved.",
    DYNAMIC_ROUTE: "Some route paths are computed dynamically.",
    AMBIGUOUS_CALL: "Some calls have multiple possible declarations.",
    GENERATED_SOURCE:
      "Generated code is not included in relationship analysis.",
    SOURCE_UNREADABLE: "Some source files could not be analyzed.",
    PARSE_FAILURE: "Some source files could not be parsed.",
  };
  for (const spot of project.analysis.blindSpots)
    add(
      spot.code,
      blindSpotSummaries[spot.code] ??
        "Some static relationships could not be resolved.",
      spot.location?.file,
      ["SOURCE_UNREADABLE", "PARSE_FAILURE"].includes(spot.code),
    );

  const staticMessages = new Set(
    project.analysis.blindSpots.map((spot) => spot.message),
  );
  const inventoryMessages = new Set(
    project.inventory.warnings.map((warning) => warning.message),
  );
  for (const warning of project.warnings) {
    if (typeof warning !== "string") continue;
    if (staticMessages.has(warning) || inventoryMessages.has(warning)) continue;
    const runtimeMessage = project.runtime.warnings.includes(warning);
    add(
      runtimeMessage ? "RUNTIME_CONTEXT" : "PROJECT_METADATA",
      runtimeMessage
        ? "Runtime version declarations or compatibility signals need review."
        : "Some project metadata could not be read cleanly.",
    );
  }

  return [...diagnostics.values()].sort(
    (a, b) =>
      Number(b.incomplete) - Number(a.incomplete) ||
      b.count - a.count ||
      a.code.localeCompare(b.code),
  );
}

export function createSarif(findings: ImpactFinding[]) {
  const rules = [
    ...new Map(
      findings.map((finding) => [
        finding.ruleId,
        {
          id: finding.ruleId,
          name: finding.title,
          shortDescription: { text: finding.title },
          fullDescription: { text: finding.message },
          helpUri: finding.references[0],
          defaultConfiguration: { level: level(finding.severity) },
        },
      ]),
    ).values(),
  ].sort((a, b) => a.id.localeCompare(b.id));
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "UpgradeX",
            version: getProductVersion(),
            informationUri: "https://www.npmjs.com/package/upgradex",
            rules,
          },
        },
        results: findings.map((finding) => ({
          ruleId: finding.ruleId,
          level: level(finding.severity),
          message: { text: finding.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: {
                  uri: finding.location.file.replaceAll("\\", "/"),
                },
                region: {
                  startLine: finding.location.line,
                  startColumn: finding.location.column,
                },
              },
            },
          ],
          help: {
            text: `${finding.guidance}\nRisk: ${finding.risk.level}. ${finding.risk.reasons.join(" ")}`,
          },
          relatedLocations: finding.impact.affectedFiles.map((file, index) => ({
            id: index + 1,
            physicalLocation: {
              artifactLocation: { uri: file.replaceAll("\\", "/") },
            },
            message: { text: "Connected impact path" },
          })),
        })),
      },
    ],
  };
}

function displayVersion(value: string): string {
  return value.match(/^(\d+)\.0\.0$/)?.[1] ?? value;
}

function displayTechnology(name: string): string {
  const labels: Record<string, string> = {
    node: "Node.js",
    express: "Express",
    react: "React",
    vite: "Vite",
    typescript: "TypeScript",
    "package-manager": "npm",
  };
  return labels[name] ?? name;
}

function displayAlignment(consistency: string): string {
  if (consistency === "consistent") return "aligned";
  if (consistency === "conflicting") return "conflicts detected";
  if (consistency === "mixed") return "mixed declarations";
  return "alignment unknown";
}

function plural(
  count: number,
  singular: string,
  pluralForm = `${singular}s`,
): string {
  return count === 1 ? singular : pluralForm;
}

function technologySummary(report: ScanReport): string {
  return report.project.technologies
    .map(
      ({ name, versionRanges }) =>
        `${displayTechnology(name)}${versionRanges.length ? ` ${[...new Set(versionRanges)].join(", ")}` : ""}`,
    )
    .join(" · ");
}

export function renderHumanSummary(report: ScanReport): string {
  const projectName = report.project.name ?? report.project.root;
  const findings = report.summary.findingsBySeverity;
  const findingCount = report.findings.length;
  const findingsText = findingCount
    ? `${findingCount} issue(s) found · ${findings.critical} critical · ${findings.high} high · ${findings.medium} medium · ${findings.low} low`
    : report.selection
      ? "No findings matched the selected upgrade rules. This is not a guarantee that the upgrade is safe."
      : "No upgrade selected yet. Choose a supported path to check for known issues.";
  const migrationSummary =
    report.summary.automaticMigrations + report.summary.manualMigrations > 0
      ? `No files changed · ${report.summary.automaticMigrations} ${plural(report.summary.automaticMigrations, "finding")} can be previewed · ${report.summary.manualMigrations} ${plural(report.summary.manualMigrations, "finding")} need manual changes`
      : report.selection
        ? "No files changed · no migration steps identified"
        : "No files changed · select an upgrade to see available migrations";
  const verification =
    report.verification.length === 0
      ? "Not run"
      : report.verification
          .map((item) => `${item.kind}: ${item.status.replaceAll("_", " ")}`)
          .join(" · ");
  const lines = [
    "◆ UpgradeX",
    `◇ ${projectName}`,
    `│ ${report.project.language} · ${report.project.packageManager}${technologySummary(report) ? ` · ${technologySummary(report)}` : ""}`,
  ];
  if (report.selection)
    lines.push(
      `◇ Upgrade · ${displayTechnology(report.selection.technology)} ${displayVersion(report.selection.current)} → ${displayVersion(report.selection.target)}`,
    );
  lines.push(
    "│",
    "◇ Version Surface Map",
    `├─ ${report.versionSurfaces.totalSurfaces} ${plural(report.versionSurfaces.totalSurfaces, "reference")} across ${report.versionSurfaces.totalTechnologies} ${plural(report.versionSurfaces.totalTechnologies, "technology", "technologies")}`,
  );
  if (report.versionSurfaces.groups.length === 0) {
    lines.push("└─ No version references detected.");
  } else {
    for (const group of report.versionSurfaces.groups)
      lines.push(
        `├─ ${displayTechnology(group.technology)} · ${group.surfaces.length} ${plural(group.surfaces.length, "reference")} · ${displayAlignment(group.consistency)}`,
      );
    const conflicts = report.versionSurfaces.groups.filter(
      (group) => group.consistency === "conflicting",
    ).length;
    lines.push(
      conflicts === 0
        ? "└─ No conflicting version declarations detected."
        : `└─ ${conflicts} technology group(s) have conflicting version declarations.`,
    );
  }
  if (report.selection) {
    const selectedGroup = report.versionSurfaces.groups.find(
      (group) => group.technology === report.selection?.technology,
    );
    if (selectedGroup)
      lines.push(
        `│ ${displayTechnology(selectedGroup.technology)} is represented in ${selectedGroup.surfaces.length} ${plural(selectedGroup.surfaces.length, "reference")}; review these when planning the upgrade.`,
      );
  }
  lines.push(
    `│ Analyzed ${report.scan.sourceFiles} JavaScript/TypeScript ${plural(report.scan.sourceFiles, "source file")} and ${report.scan.testFiles} ${plural(report.scan.testFiles, "test file")}.`,
  );
  if (report.diagnostics.length > 0) {
    const incomplete = report.diagnostics.filter(
      (diagnostic) => diagnostic.incomplete,
    );
    if (incomplete.length > 0) {
      lines.push(
        `! Scan coverage needs review: ${incomplete
          .map((diagnostic) => diagnostic.summary.toLowerCase())
          .slice(0, 2)
          .join(" ")}`,
      );
    } else {
      lines.push(
        `│ ${report.diagnostics.length} additional ${plural(report.diagnostics.length, "note")}; choose “View Detailed Analysis & Affected Files” for details.`,
      );
    }
  }
  lines.push(
    "│",
    "◇ What needs attention?",
    `├─ ${findingsText}`,
    `├─ Known impact · ${report.summary.affectedFiles} connected ${plural(report.summary.affectedFiles, "file")} · ${report.summary.affectedRoutes} statically connected ${plural(report.summary.affectedRoutes, "route")}`,
    `├─ Migration · ${migrationSummary}`,
    `├─ Project checks · ${verification}`,
    `└─ Result · ${report.finalStatus}`,
  );

  return lines.join("\n");
}

export function renderHumanSurfaceMap(report: ScanReport): string {
  const lines = [
    "◆ Version Surface Map",
    `│ ${report.versionSurfaces.totalSurfaces} ${plural(report.versionSurfaces.totalSurfaces, "version reference")} across ${report.versionSurfaces.totalTechnologies} ${plural(report.versionSurfaces.totalTechnologies, "technology", "technologies")}`,
  ];
  if (report.versionSurfaces.groups.length === 0)
    lines.push("└─ No version references detected.");
  for (const group of report.versionSurfaces.groups) {
    lines.push(
      `◇ ${displayTechnology(group.technology)} · ${group.surfaces.length} ${plural(group.surfaces.length, "reference")} · ${displayAlignment(group.consistency)}`,
    );
    for (const surface of group.surfaces) {
      const location = `${surface.location.relativePath}${surface.location.line === undefined ? "" : `:${surface.location.line}`}${surface.location.jsonPath ? ` (${surface.location.jsonPath})` : ""}`;
      lines.push(`├─ ${location} → ${surface.rawValue} · ${surface.priority}`);
    }
    for (const conflict of group.conflicts)
      lines.push(`! Conflict · ${conflict}`);
  }
  if (report.diagnostics.length > 0) {
    lines.push("◇ Additional scan context");
    for (const diagnostic of report.diagnostics)
      lines.push(
        `├─ ${diagnostic.summary}${diagnostic.count > 1 ? ` (${diagnostic.count})` : ""}${diagnostic.examples.length ? ` · ${diagnostic.examples.join(", ")}` : ""}`,
      );
  } else lines.push("◇ No additional scan context.");
  return lines.join("\n");
}

export function renderHumanFindingsOverview(report: ScanReport): string {
  const lines = ["◆ Findings & next steps"];
  if (report.findings.length === 0) {
    lines.push(
      report.selection
        ? "└─ No issues matched the selected upgrade rules. Run your project checks before upgrading."
        : "└─ Choose a supported upgrade to check for migration issues.",
    );
    return lines.join("\n");
  }

  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  const findings = [...report.findings].sort(
    (a, b) =>
      severityOrder[a.severity] - severityOrder[b.severity] ||
      a.location.file.localeCompare(b.location.file) ||
      a.location.line - b.location.line,
  );
  lines.push(
    `│ ${findings.length} issue(s) to review · ${report.summary.affectedFiles} affected file(s) · ${report.summary.affectedRoutes} route(s)`,
  );
  for (const [index, finding] of findings.slice(0, 5).entries()) {
    lines.push(
      "│",
      `◇ ${index + 1}. ${finding.title} · ${finding.severity.toUpperCase()}`,
      `├─ Where · ${finding.location.file}:${finding.location.line}`,
      `├─ Why it matters · ${finding.message}`,
      `├─ Suggested next step · ${finding.guidance}`,
      `└─ Statically connected · ${finding.impact.affectedFiles.length} ${plural(finding.impact.affectedFiles.length, "file")}, ${finding.impact.affectedRoutes.length} ${plural(finding.impact.affectedRoutes.length, "route")}, ${finding.impact.affectedTests.length} ${plural(finding.impact.affectedTests.length, "test")}`,
    );
  }
  if (findings.length > 5)
    lines.push(
      "│",
      `${findings.length - 5} more issue(s) are available in Detailed Analysis & Affected Files.`,
    );
  lines.push(
    "│",
    "Impact is based on statically resolved connections; dynamic or runtime-only behavior may not appear.",
    "For evidence, connected callers, and graph paths, open Detailed Analysis & Affected Files from the menu.",
  );
  return lines.join("\n");
}

export function renderHumanImpactAssessment(report: ScanReport): string {
  const selection = report.selection;
  const title = selection
    ? `${displayTechnology(selection.technology)} ${displayVersion(selection.current)} → ${displayVersion(selection.target)}`
    : "No supported upgrade path selected";
  const noIssues = report.findings.length === 0 && Boolean(selection);
  const status = report.finalStatus;
  const verificationFailed = report.verification.some((check) =>
    ["failed", "timed_out", "blocked"].includes(check.status),
  );
  const conclusion = !selection
    ? "OVERVIEW ONLY · SELECT A SUPPORTED UPGRADE PATH TO RUN RULES"
    : report.findings.length > 0
      ? "NEEDS MIGRATION"
      : verificationFailed
        ? "BLOCKED · PROJECT CHECKS FAILED"
        : report.scan.incomplete || status === "INCONCLUSIVE"
          ? "INCONCLUSIVE · REVIEW SCAN GAPS OR UNCONFIGURED CHECKS"
          : report.verification.length > 0 &&
              report.verification.every((check) => check.status === "passed")
            ? "VERIFIED FOR OBSERVED CHECKS"
            : "READY FOR VERIFICATION";
  const lines = [
    "◆ Upgrade Impact Assessment",
    "│",
    `◇ ${title}`,
    "│",
    noIssues
      ? "◆ NO UPGRADE-SPECIFIC ISSUES FOUND"
      : report.findings.length > 0
        ? `◆ ${report.findings.length} UPGRADE-SPECIFIC ISSUE(S) FOUND`
        : "◆ ANALYSIS ONLY · NO RULES WERE RUN",
    "│",
    "◇ Analysis",
    `├─ ${report.ruleCoverage.available} supported rule(s) loaded`,
    `├─ ${report.ruleCoverage.applicable} rule(s) match this version transition`,
    `├─ ${report.findings.length} issue(s) detected`,
    `├─ Evaluated across ${report.scan.sourceFiles} source file(s) and ${report.scan.testFiles} test file(s)`,
    `└─ ${report.summary.impactPaths} statically connected relationship(s) identified`,
    "│",
    "◇ Evidence",
    `├─ ${report.versionSurfaces.totalSurfaces} version reference(s) checked across ${report.versionSurfaces.totalTechnologies} technology group(s)`,
    `├─ ${report.summary.resolvedFindings} resolved match(es) · ${report.summary.heuristicFindings} heuristic match(es)`,
    `└─ ${report.scan.indexedFiles} relevant project file(s) indexed within scan limits`,
    "│",
    "◇ Verification",
    ...(report.verification.length === 0
      ? ["└─ Not run · typecheck, build, and tests have not been executed."]
      : verificationAssessmentLines(report.verification)),
    "│",
    "◇ Important",
    "├─ This is a static compatibility assessment, not a guarantee of runtime safety.",
    "└─ Scan did not change files or execute project scripts.",
    "│",
    "◆ Conclusion",
    `└─ ${conclusion}`,
  ];
  if (report.diagnostics.some((diagnostic) => diagnostic.incomplete)) {
    const incomplete = report.diagnostics
      .filter((diagnostic) => diagnostic.incomplete)
      .map((diagnostic) => diagnostic.summary)
      .slice(0, 3);
    lines.splice(
      lines.indexOf("◇ Important") + 1,
      0,
      `├─ Scan limitations · ${incomplete.join(" ")}`,
    );
  }
  return lines.join("\n");
}

function verificationAssessmentLines(
  verification: ProofDocument["verification"],
): string[] {
  return verification.map(
    (check, index) =>
      `${index === verification.length - 1 ? "└─" : "├─"} ${check.kind} · ${check.status.replaceAll("_", " ")}${check.durationMs > 0 ? ` · ${check.durationMs} ms` : ""}${check.exitCode === undefined ? "" : ` · exit ${check.exitCode}`}`,
  );
}

export function renderHumanMigrationPlan(preview: MigrationPreview): string {
  const lines = [
    "◆ Migration Plan",
    "│",
    "◇ Summary",
    `├─ ${preview.files.length} file(s) have safe, deterministic edits available`,
    `├─ ${preview.manual.length} finding(s) need manual developer review`,
    "└─ No project files have been changed.",
  ];
  if (preview.files.length > 0) {
    lines.push("│", "◇ Proposed files");
    for (const [index, file] of preview.files.entries())
      lines.push(
        `${index === preview.files.length - 1 ? "└─" : "├─"} ${file.file} · ${file.ruleIds.length} supported edit(s)`,
      );
  }
  if (preview.manual.length > 0) {
    lines.push("│", "◇ Manual review");
    for (const [index, item] of preview.manual.slice(0, 8).entries())
      lines.push(
        `${index === Math.min(preview.manual.length, 8) - 1 ? "└─" : "├─"} ${item.file}:${item.line} · ${item.guidance}`,
      );
    if (preview.manual.length > 8)
      lines.push(`└─ ${preview.manual.length - 8} more manual item(s).`);
  }
  return lines.join("\n");
}

export function renderHumanVerificationResults(
  verification: ProofDocument["verification"],
): string {
  const failed = verification.filter((check) =>
    ["failed", "timed_out", "blocked"].includes(check.status),
  );
  const passed = verification.filter((check) => check.status === "passed");
  const missing = verification.filter(
    (check) => check.status === "not_configured",
  );
  const lines = [
    "◆ Upgrade Verification",
    "│",
    `◇ Results · ${passed.length} passed · ${failed.length} failed · ${missing.length} not configured`,
  ];
  for (const check of verification) {
    lines.push(
      "│",
      `◇ ${check.kind} · ${check.status.replaceAll("_", " ").toUpperCase()}${check.durationMs > 0 ? ` · ${check.durationMs} ms` : ""}`,
    );
    if (check.command) lines.push(`├─ Command · ${check.command}`);
    if (check.exitCode !== undefined)
      lines.push(`├─ Exit code · ${check.exitCode}`);
    const output = check.stderrSummary ?? check.stdoutSummary;
    if (output)
      lines.push(
        "└─ Output",
        ...output.split("\n").map((line) => `   ${line}`),
      );
    if (
      ["failed", "timed_out", "blocked"].includes(check.status) &&
      /not recognized as an internal or external command|command not found|could not determine executable to run/i.test(
        output ?? "",
      )
    )
      lines.push(
        "└─ Likely cause · a project command is unavailable; install workspace dependencies and run verification again.",
      );
    else if (check.status === "not_configured")
      lines.push(
        "└─ No matching script is configured in the project manifest.",
      );
  }
  lines.push(
    "│",
    failed.length > 0
      ? "◆ Some project checks failed. Review the output above before upgrading."
      : missing.length > 0
        ? "◆ Verification is incomplete because some checks are not configured."
        : "◆ All selected project checks passed.",
  );
  return lines.join("\n");
}

export function renderHumanDetailedAnalysis(
  report: ScanReport,
  preview?: MigrationPreview,
): string {
  const selection = report.selection;
  const lines = [
    "◆ Detailed Analysis & Affected Files",
    "│",
    "◇ Upgrade",
    selection
      ? `├─ ${displayTechnology(selection.technology)} ${displayVersion(selection.current)} → ${displayVersion(selection.target)}`
      : "├─ No supported upgrade path selected",
    `├─ ${report.findings.length} finding(s) · ${report.summary.affectedFiles} affected file(s) · ${report.finalStatus}`,
    `└─ Risk · ${report.findings.some((finding) => ["critical", "high"].includes(finding.severity)) ? "HIGH" : report.findings.some((finding) => finding.severity === "medium") ? "MEDIUM" : "No high or medium findings detected"}`,
    "│",
    "◇ Affected Files",
  ];
  if (!report.findings.length)
    lines.push("└─ No files matched the selected rules.");
  else {
    const byFile = new Map<string, ImpactFinding[]>();
    for (const finding of report.findings) {
      const rows = byFile.get(finding.location.file) ?? [];
      rows.push(finding);
      byFile.set(finding.location.file, rows);
      for (const file of finding.impact.affectedFiles) {
        const related = byFile.get(file) ?? [];
        if (!related.includes(finding)) related.push(finding);
        byFile.set(file, related);
      }
      for (const file of finding.impact.affectedTests) {
        const related = byFile.get(file) ?? [];
        if (!related.includes(finding)) related.push(finding);
        byFile.set(file, related);
      }
    }
    lines.push(
      `│ ${byFile.size} affected file(s) · direct findings and statically connected files/tests`,
    );
    for (const [fileIndex, [file, findings]] of [...byFile.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .entries()) {
      lines.push(`${fileIndex === byFile.size - 1 ? "└─" : "├─"} ${file}`);
      for (const finding of findings)
        lines.push(
          `   └─ ${finding.title} · ${finding.ruleId} · ${finding.severity.toUpperCase()}${finding.location.file === file ? ` · line ${finding.location.line}` : " · connected impact"}`,
        );
    }
  }
  lines.push("│", "◇ Impact Paths");
  const edges = new Map<string, string>();
  for (const finding of report.findings)
    for (const edge of finding.impact.traversal)
      edges.set(
        `${edge.from}\0${edge.edge}\0${edge.to}`,
        `${edge.fromLabel} ─${edge.edge}→ ${edge.toLabel}`,
      );
  if (!edges.size)
    lines.push(
      "└─ No static caller, route, or test connections were resolved.",
    );
  else
    for (const [index, edge] of [...edges.values()].entries())
      lines.push(`${index === edges.size - 1 ? "└─" : "├─"} ${edge}`);
  lines.push("│", "◇ Version Surface Map");
  if (!report.versionSurfaces.groups.length)
    lines.push("└─ No version references detected.");
  for (const group of report.versionSurfaces.groups) {
    lines.push(
      `├─ ${displayTechnology(group.technology)} · ${group.surfaces.length} reference(s) · ${displayAlignment(group.consistency)}`,
    );
    for (const surface of group.surfaces) {
      const location = `${surface.location.relativePath}${surface.location.line === undefined ? "" : `:${surface.location.line}${surface.location.column === undefined ? "" : `:${surface.location.column}`}`}${surface.location.jsonPath ? ` (${surface.location.jsonPath})` : ""}`;
      lines.push(`│  └─ ${location} → ${surface.rawValue}`);
    }
  }
  lines.push(
    "│",
    "◇ Rule Coverage",
    `├─ ${report.ruleCoverage.available} supported rule(s) loaded for this upgrade family`,
    `├─ ${report.ruleCoverage.applicable} rule(s) matched the selected version transition`,
    `├─ ${report.findings.length} finding(s) emitted`,
    `└─ ${report.scan.sourceFiles} source file(s) and ${report.scan.testFiles} test file(s) parsed`,
    "│",
    "◇ Evidence",
    `├─ ${report.summary.resolvedFindings} finding(s) with resolved evidence · ${report.summary.heuristicFindings} heuristic match(es)`,
    `├─ ${report.versionSurfaces.totalSurfaces} version reference(s) indexed`,
    `└─ ${report.scan.indexedFiles} project file(s) indexed · ${report.scan.bytesRead} bytes read`,
    "│",
    "◇ Migration Analysis",
  );
  lines.push(
    `├─ ${preview?.files.length ?? 0} file(s) have deterministic preview edits`,
    `├─ ${preview?.manual.length ?? report.findings.length} finding(s) need manual review`,
    "└─ Detailed diff and explicit approval are required before changes are applied.",
    "│",
    "◇ Scan Notes",
  );
  if (!report.diagnostics.length) lines.push("└─ No scan notes recorded.");
  for (const diagnostic of report.diagnostics)
    lines.push(
      `├─ ${diagnostic.summary}${diagnostic.count > 1 ? ` (${diagnostic.count})` : ""}${diagnostic.examples.length ? ` · ${diagnostic.examples.join(", ")}` : ""}`,
    );
  lines.push(
    "│",
    "◇ Project Checks",
    ...(report.verification.length === 0
      ? ["└─ Not run during this CLI session."]
      : report.verification.map(
          (check, index) =>
            `${index === report.verification.length - 1 ? "└─" : "├─"} ${check.kind} · ${check.status.replaceAll("_", " ")}${check.durationMs > 0 ? ` · ${check.durationMs} ms` : ""}${check.command ? ` · ${check.command}` : ""}`,
        )),
    "│",
    "◇ Analysis Limits",
    "├─ Static analysis only; dynamic and runtime-only behavior may not be visible.",
    "├─ Scan did not modify project files; migration writes require explicit approval.",
    "└─ Findings describe supported rules; no findings do not prove upgrade safety.",
  );
  return lines.join("\n");
}

export function renderHumanReport(report: ScanReport): string {
  const lines = [
    "◆ UpgradeX",
    "│",
    "◇ Project",
    `├─ ${report.project.name ?? report.project.root}`,
    `├─ Language: ${report.project.language}`,
    `├─ Package manager: ${report.project.packageManager}`,
  ];
  if (report.selection)
    lines.push(
      `└─ Upgrade: ${report.selection.technology} ${report.selection.current} -> ${report.selection.target}`,
    );
  lines.push(
    "│",
    `◇ Version Surface Map (${report.versionSurfaces.totalSurfaces} surfaces across ${report.versionSurfaces.totalTechnologies} technologies)`,
  );
  if (report.versionSurfaces.groups.length === 0)
    lines.push("└─ No version surfaces found.");
  for (const group of report.versionSurfaces.groups) {
    lines.push(
      `├─ ${group.technology}: ${group.surfaces.length} surface(s) · ${group.consistency}`,
    );
    for (const surface of group.surfaces) {
      const line =
        surface.location.line === undefined
          ? ""
          : `:${surface.location.line}${surface.location.column === undefined ? "" : `:${surface.location.column}`}`;
      const jsonPath = surface.location.jsonPath
        ? ` (${surface.location.jsonPath})`
        : "";
      lines.push(
        `│  ${surface.rawValue} · ${surface.location.relativePath}${line}${jsonPath} · ${surface.priority}`,
      );
    }
    for (const conflict of group.conflicts)
      lines.push(`│  ! Conflict: ${conflict}`);
  }
  lines.push("│", `◇ Findings (${report.findings.length})`);
  if (report.findings.length === 0)
    lines.push(
      report.selection
        ? "└─ No findings for the selected upgrade path."
        : "└─ No upgrade rules run; no upgrade path was selected.",
    );
  for (const finding of report.findings) {
    lines.push(
      `├─ ${finding.severity.toUpperCase()} ${finding.ruleId} · ${finding.title}`,
      `│  at ${finding.location.file}:${finding.location.line}:${finding.location.column}`,
      `│  Why: ${finding.message}`,
      `│  Evidence: ${finding.evidence.tier} · ${finding.evidence.resolution}`,
      `│  Risk: ${finding.risk.level} · ${finding.risk.reasons.join(" ")}`,
      `│  Next: ${finding.guidance}`,
    );
    lines.push(
      `│  Migration: ${finding.codemod ? `automatic preview available (${finding.codemod})` : "manual change"}`,
    );
    const graphEdges = finding.impact.traversal.slice(0, 6);
    if (graphEdges.length) {
      lines.push("│  Impact graph:");
      for (const edge of graphEdges)
        lines.push(
          `│    ${edge.fromLabel} --${edge.edge} (${edge.resolution})--> ${edge.toLabel}`,
        );
      if (finding.impact.traversal.length > graphEdges.length)
        lines.push(
          `│    ... ${finding.impact.traversal.length - graphEdges.length} more graph edge(s)`,
        );
    } else {
      lines.push("│  Impact graph: no connected paths resolved.");
    }
    lines.push(
      `│  Reach: ${finding.impact.affectedFiles.length} file(s), ${finding.impact.affectedSymbols.length} symbol(s), ${finding.impact.affectedRoutes.length} route(s), ${finding.impact.affectedTests.length} test(s), ${finding.impact.relatedConfiguration.length} config(s)`,
    );
    for (const spot of finding.impact.blindSpots)
      lines.push(`│  Blind spot: ${spot}`);
  }
  lines.push("│", "◇ Verification");
  if (report.verification.length === 0) lines.push("└─ Not run");
  for (const result of report.verification)
    lines.push(
      `├─ ${result.kind}: ${result.status.toUpperCase()}${result.durationMs ? ` (${result.durationMs} ms)` : ""}${result.exitCode === undefined ? "" : ` · exit ${result.exitCode}`}`,
    );
  lines.push("│", `◇ Blind spots (${report.blindSpots.length})`);
  if (report.blindSpots.length === 0) lines.push("└─ None recorded.");
  for (const spot of report.blindSpots) lines.push(`├─ ${spot}`);
  lines.push("│", `Final status: ${report.finalStatus}`);
  return lines.join("\n");
}

export function wrapHumanReport(report: string, width: number): string {
  const columnLimit = Number.isFinite(width)
    ? Math.max(40, Math.floor(width))
    : 80;
  return report
    .split("\n")
    .flatMap((line) => {
      if (line.length <= columnLimit || line.trim() === "│") return [line];

      const treePrefix = line.match(/^(?:│\s+|[├└]─\s+)/)?.[0] ?? "";
      const continuationPrefix =
        treePrefix.startsWith("├") || treePrefix.startsWith("└")
          ? "│  "
          : treePrefix || "  ";
      const words = line
        .slice(treePrefix.length)
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const wrapped: string[] = [];
      let prefix = treePrefix;
      let current = prefix;

      for (const word of words) {
        const separator = current.length > prefix.length ? " " : "";
        if (current.length + separator.length + word.length <= columnLimit) {
          current += `${separator}${word}`;
          continue;
        }

        if (current.length > prefix.length) wrapped.push(current);
        prefix = continuationPrefix;

        let remaining = word;
        while (prefix.length + remaining.length > columnLimit) {
          const available = Math.max(1, columnLimit - prefix.length);
          wrapped.push(`${prefix}${remaining.slice(0, available)}`);
          remaining = remaining.slice(available);
        }
        current = `${prefix}${remaining}`;
      }

      if (current.length > prefix.length || wrapped.length === 0)
        wrapped.push(current);
      return wrapped;
    })
    .join("\n");
}
