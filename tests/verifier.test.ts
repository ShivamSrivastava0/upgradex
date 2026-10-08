import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { detectProject } from "../src/project-detector/project-detector.js";
import { analyzeUpgrade } from "../src/upgrade-pipeline.js";
import { getProductVersion } from "../src/product-metadata.js";
import { createMigrationPreview } from "../src/migration-engine/migration-engine.js";
import {
  createProof,
  verifyProject,
  writeProof,
} from "../src/verifier/verifier.js";
import {
  createScanReport,
  createSarif,
  renderHumanFindingsOverview,
  renderHumanSummary,
  renderHumanReport,
  renderHumanImpactAssessment,
  renderHumanMigrationPlan,
  renderHumanDetailedAnalysis,
  renderHumanVerificationResults,
  wrapHumanReport,
} from "../src/reporting/reports.js";

describe("verifier and proof", () => {
  it("records missing checks instead of claiming they passed", async () => {
    const project = detectProject(
      path.resolve(process.cwd(), "fixtures", "framework-express"),
    );
    const results = await verifyProject(project);
    expect(results.map((result) => result.status)).toEqual([
      "not_configured",
      "not_configured",
      "not_configured",
    ]);
    const proof = createProof(project, [], results);
    expect(proof.run.status).toBe("INCONCLUSIVE");
    expect(proof.versionSurfaces.totalSurfaces).toBe(
      project.versionSurfaceMap.totalSurfaces,
    );
    expect(JSON.stringify(proof)).not.toContain("SAFE");
  });

  it("reports actual verification start and completion events", async () => {
    const project = detectProject(
      path.resolve(process.cwd(), "fixtures", "framework-express"),
    );
    const events: string[] = [];
    await verifyProject(project, {
      kinds: ["test"],
      onCheckProgress(event) {
        events.push(`${event.status}:${event.kind}`);
      },
    });

    expect(events).toEqual(["start:test", "complete:test"]);
  });

  it("emits stable empty SARIF and a structured scan report", () => {
    const project = detectProject(
      path.resolve(process.cwd(), "fixtures", "framework-express"),
    );
    const report = createScanReport(project);
    const sarif = createSarif([]);
    expect(report.versionSurfaces).toEqual(project.versionSurfaceMap);
    expect(renderHumanReport(report)).toContain(
      "No upgrade rules run; no upgrade path was selected.",
    );
    expect(renderHumanReport(report)).toContain("Version Surface Map");
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0]?.tool.driver.version).toBe(getProductVersion());
    expect(sarif.runs[0]?.results).toEqual([]);
  });

  it("does not present an overview without a selected upgrade as ready for verification", () => {
    const project = detectProject(
      path.resolve(process.cwd(), "fixtures", "framework-false-positive"),
    );
    const report = createScanReport(project);

    expect(report.finalStatus).toBe("OVERVIEW ONLY");
    expect(renderHumanImpactAssessment(report)).toContain(
      "OVERVIEW ONLY · SELECT A SUPPORTED UPGRADE PATH TO RUN RULES",
    );
    expect(renderHumanImpactAssessment(report)).not.toContain(
      "READY FOR VERIFICATION",
    );
  });

  it("keeps clean supported scans reviewable despite ordinary static-analysis notes", () => {
    const result = analyzeUpgrade(
      path.resolve(process.cwd(), "fixtures", "framework-express"),
      { technology: "express", current: "4.0.0", target: "5.0.0" },
    );
    const report = createScanReport(
      result.project,
      result.findings,
      [],
      result.selection,
    );

    expect(report.finalStatus).toBe("READY TO REVIEW");
    expect(
      createProof(result.project, result.findings, [], result.selection).run
        .status,
    ).toBe("READY TO REVIEW");
    const summary = renderHumanSummary(report);
    expect(summary).toContain("No findings matched the selected upgrade rules");
    expect(summary).toContain("Result · READY TO REVIEW");
    expect(summary).toContain("◇ Version Surface Map");
    expect(summary).toContain("Express · 1 reference · aligned");
    expect(summary).not.toContain("dependencies.express");
    expect(summary).not.toContain("Impact graph:");
  });

  it("renders evidence-based impact, migration, and deep-analysis sections", () => {
    const result = analyzeUpgrade(
      path.resolve(process.cwd(), "fixtures", "rule-express-positive"),
      { technology: "express", current: "4.0.0", target: "5.0.0" },
    );
    const report = createScanReport(
      result.project,
      result.findings,
      [],
      result.selection,
      {
        available: result.availableRuleCount,
        applicable: result.applicableRuleCount,
      },
    );
    const impact = renderHumanImpactAssessment(report);
    const migration = renderHumanMigrationPlan(
      createMigrationPreview(result.project.inventory, result.findings),
    );
    const detailed = renderHumanDetailedAnalysis(
      report,
      createMigrationPreview(result.project.inventory, result.findings),
    );

    expect(impact).toContain("Upgrade Impact Assessment");
    expect(impact).toContain(`${result.applicableRuleCount} rule(s) match`);
    expect(migration).toContain("Migration Plan");
    expect(migration).toContain("No project files have been changed.");
    expect(detailed).toContain("Affected Files");
    expect(detailed).toContain("Analysis Limits");
  });

  it("does not call a failed verification ready for verification", () => {
    const result = analyzeUpgrade(
      path.resolve(process.cwd(), "fixtures", "framework-express"),
      { technology: "express", current: "4.0.0", target: "5.0.0" },
    );
    const report = createScanReport(
      result.project,
      result.findings,
      [
        {
          id: "failed-check",
          kind: "typecheck",
          command: "npm run typecheck",
          status: "failed",
          exitCode: 1,
          durationMs: 120,
          startedAt: new Date(0).toISOString(),
          endedAt: new Date(120).toISOString(),
        },
      ],
      result.selection,
      {
        available: result.availableRuleCount,
        applicable: result.applicableRuleCount,
      },
    );

    expect(renderHumanImpactAssessment(report)).toContain(
      "BLOCKED · PROJECT CHECKS FAILED",
    );
    const detailed = renderHumanDetailedAnalysis(report);
    expect(detailed).toContain("Project Checks");
    expect(detailed).toContain("typecheck · failed");
    expect(detailed).not.toContain("Project scripts were not run");
  });

  it("explains missing project-local commands in failed check output", () => {
    const rendered = renderHumanVerificationResults([
      {
        id: "missing-tsc",
        kind: "typecheck",
        command: "npm run typecheck",
        status: "failed",
        exitCode: 1,
        durationMs: 500,
        stdoutSummary:
          "'tsc' is not recognized as an internal or external command.",
        startedAt: new Date(0).toISOString(),
        endedAt: new Date(500).toISOString(),
      },
    ]);

    expect(rendered).toContain("project command is unavailable");
    expect(rendered).toContain("install workspace dependencies");
  });

  it("surfaces post-migration verification failures in the human report", () => {
    const project = detectProject(
      path.resolve(process.cwd(), "fixtures", "framework-express"),
    );
    const report = createScanReport(
      project,
      [],
      [
        {
          id: "verification-1",
          kind: "test",
          command: "npm run test",
          exitCode: 1,
          status: "failed",
          durationMs: 250,
          startedAt: new Date(0).toISOString(),
          endedAt: new Date(250).toISOString(),
        },
      ],
    );

    expect(report.finalStatus).toBe("BLOCKED");
    expect(renderHumanReport(report)).toContain(
      "test: FAILED (250 ms) · exit 1",
    );
    expect(renderHumanReport(report)).toContain("Final status: BLOCKED");
  });

  it("renders finding locations and readable impact graph paths", () => {
    const result = analyzeUpgrade(
      path.resolve(process.cwd(), "fixtures", "rule-express-positive"),
      {
        technology: "express",
        current: "4.0.0",
        target: "5.0.0",
      },
    );
    const rendered = renderHumanReport(
      createScanReport(result.project, result.findings, [], result.selection),
    );
    expect(rendered).toContain("◇ Findings (");
    expect(rendered).toMatch(/at .+:\d+:\d+/);
    expect(rendered).toContain("Impact graph:");
    expect(rendered).toContain("Reach:");
    const overview = renderHumanFindingsOverview(
      createScanReport(result.project, result.findings, [], result.selection),
    );
    expect(overview).toContain("Findings & next steps");
    expect(overview).toContain("Suggested next step");
    expect(overview).not.toContain("Impact graph:");
    expect(overview).not.toContain("Evidence:");
  });

  it("wraps long human report lines at word boundaries within terminal width", () => {
    const wrapped = wrapHumanReport(
      "│  Risk: medium severity was detected. No statically connected tests were found; this is not proof that tests do not exist.",
      48,
    );
    const lines = wrapped.split("\n");

    expect(lines.every((line) => line.length <= 48)).toBe(true);
    expect(lines.slice(1).every((line) => line.startsWith("│  "))).toBe(true);
    expect(wrapped).toContain("statically connected");
    expect(wrapped).toContain("not proof that tests do not exist.");
  });

  it("does not persist arbitrary verifier output in proof files", () => {
    const project = detectProject(
      path.resolve(process.cwd(), "fixtures", "framework-express"),
    );
    const proof = createProof(
      project,
      [],
      [
        {
          id: "verification-1",
          kind: "test",
          command: "npm run test",
          status: "passed",
          durationMs: 15,
          stdoutSummary: "API_TOKEN=private",
          stderrSummary: "private build path",
          startedAt: new Date(0).toISOString(),
          endedAt: new Date(15).toISOString(),
        },
      ],
    );
    expect(proof.tool.version).toBe(getProductVersion());
    expect(JSON.stringify(proof)).not.toContain("API_TOKEN");
    expect(JSON.stringify(proof)).not.toContain("private build path");
  });

  it("writes a parseable proof using a temporary file and atomically replaces it", () => {
    const project = detectProject(
      path.resolve(process.cwd(), "fixtures", "framework-express"),
    );
    const proof = createProof(project, [], []);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "upgradex-proof-"));
    try {
      const output = writeProof(directory, proof);
      expect(JSON.parse(fs.readFileSync(output, "utf8"))).toEqual(proof);
      writeProof(directory, {
        ...proof,
        summary: { ...proof.summary, findings: 1 },
      });
      expect(JSON.parse(fs.readFileSync(output, "utf8")).summary.findings).toBe(
        1,
      );
      expect(
        fs.readdirSync(directory).some((name) => name.endsWith(".tmp")),
      ).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a directory at the proof output path", () => {
    const project = detectProject(
      path.resolve(process.cwd(), "fixtures", "framework-express"),
    );
    const proof = createProof(project, [], []);
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "upgradex-proof-dir-"),
    );
    try {
      fs.mkdirSync(path.join(directory, "upgradex.proof.json"));
      expect(() => writeProof(directory, proof)).toThrow(
        /non-file proof destination/i,
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
