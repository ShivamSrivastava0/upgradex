import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadRulePacks, runUpgradeRules } from "../src/rules/rule-engine.js";
import { buildRepositoryInventory } from "../src/project-detector/repository-inventory.js";
import { analyzeRepository } from "../src/analyzer/change-graph.js";
import { enrichFindings } from "../src/impact-engine/impact-engine.js";
import {
  createMigrationPreview,
  transformSource,
  applyMigrationPreview,
} from "../src/migration-engine/migration-engine.js";

describe("upgrade rule engine", () => {
  it("loads strict packs and detects documented Express 4 to 5 cases", () => {
    const rules = loadRulePacks(path.resolve(process.cwd(), "rules"));
    const inventory = buildRepositoryInventory(
      path.resolve(process.cwd(), "fixtures", "rule-express-positive"),
    );
    const findings = runUpgradeRules(inventory, rules, {
      technology: "express",
      current: "4.21.2",
      target: "5.0.0",
    });
    expect(findings.map((finding) => finding.ruleId)).toEqual(
      expect.arrayContaining([
        "EXP5-001",
        "EXP5-002",
        "EXP5-007",
        "EXP5-010",
        "EXP5-020",
        "EXP5-021",
        "EXP5-022",
      ]),
    );
    expect(
      findings.some(
        (finding) =>
          finding.location.file === "src/legacy.js" &&
          finding.location.line === 3,
      ),
    ).toBe(true);
    expect(
      findings.some(
        (finding) =>
          finding.ruleId === "EXP5-010" &&
          finding.location.file === "src/legacy.js",
      ),
    ).toBe(true);
  });

  it("does not report Express rules for unrelated version paths", () => {
    const rules = loadRulePacks(path.resolve(process.cwd(), "rules"));
    const inventory = buildRepositoryInventory(
      path.resolve(process.cwd(), "fixtures", "rule-express-positive"),
    );
    expect(
      runUpgradeRules(inventory, rules, {
        technology: "express",
        current: "4.21.2",
        target: "4.22.0",
      }),
    ).toEqual([]);
  });

  it("loads Node 22 to 24 rules with source backed rule references", () => {
    const rules = loadRulePacks(path.resolve(process.cwd(), "rules"));
    expect(rules.length).toBeGreaterThanOrEqual(30);
    const inventory = buildRepositoryInventory(
      path.resolve(process.cwd(), "fixtures", "rule-node-positive"),
    );
    const findings = runUpgradeRules(inventory, rules, {
      technology: "node",
      current: "22",
      target: "24",
    });
    expect(findings.map((finding) => finding.ruleId)).toEqual(
      expect.arrayContaining([
        "NODE24-001",
        "NODE24-002",
        "NODE24-006",
        "NODE24-007",
        "NODE24-008",
        "NODE24-009",
      ]),
    );
  });

  it("adds bounded graph impact and evidence-based risk explanations", () => {
    const root = path.resolve(
      process.cwd(),
      "fixtures",
      "rule-express-positive",
    );
    const inventory = buildRepositoryInventory(root);
    const rules = loadRulePacks(path.resolve(process.cwd(), "rules"));
    const findings = runUpgradeRules(inventory, rules, {
      technology: "express",
      current: "4.21.2",
      target: "5.0.0",
    });
    const enriched = enrichFindings(findings, analyzeRepository(inventory));
    expect(enriched[0]?.risk.level).toBe("HIGH");
    expect(enriched[0]?.risk.reasons.length).toBeGreaterThan(0);
    expect(enriched[0]?.impact.affectedRoutes).toContain("GET /health");
  });

  it("previews deterministic Express edits idempotently and requires approval", () => {
    const root = path.resolve(
      process.cwd(),
      "fixtures",
      "rule-express-positive",
    );
    const inventory = buildRepositoryInventory(root);
    const rules = loadRulePacks(path.resolve(process.cwd(), "rules"));
    const findings = runUpgradeRules(inventory, rules, {
      technology: "express",
      current: "4.21.2",
      target: "5.0.0",
    });
    const preview = createMigrationPreview(inventory, findings);
    const file = preview.files.find((item) => item.file === "src/legacy.js");
    expect(file?.updated).toContain("app.delete('/old'");
    expect(
      transformSource(file?.updated ?? "", ["express-del-to-delete"]),
    ).toBe(file?.updated);
    expect(
      applyMigrationPreview(root, preview, { approved: false }).blocked,
    ).toMatch(/approval/i);
  });
});
