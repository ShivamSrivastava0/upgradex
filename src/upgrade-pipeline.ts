import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectProject,
  type DetectionProgress,
} from "./project-detector/project-detector.js";
import {
  enrichFindings,
  type ImpactFinding,
} from "./impact-engine/impact-engine.js";
import {
  loadRulePacks,
  getApplicableUpgradeRules,
  runUpgradeRules,
  type UpgradeRule,
} from "./rules/rule-engine.js";

export interface UpgradeSelection {
  technology: "node" | "express";
  current: string;
  target: string;
}
export type UpgradeProgress = Omit<DetectionProgress, "stage"> & {
  stage: DetectionProgress["stage"] | "rules" | "impact" | "assessment";
};
export interface UpgradeAnalysis {
  project: ReturnType<typeof detectProject>;
  selection?: UpgradeSelection;
  findings: ImpactFinding[];
  availableRuleCount: number;
  applicableRuleCount: number;
}

export function builtInRuleDirectory(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDirectory, "..", "rules"),
    path.resolve(moduleDirectory, "..", "..", "rules"),
    path.resolve(process.cwd(), "rules"),
  ];
  const directory = candidates.find((candidate) => fs.existsSync(candidate));
  if (!directory)
    throw new Error("UpgradeX built-in rule packs could not be found.");
  return directory;
}

export function analyzeUpgrade(
  root: string,
  selection?: UpgradeSelection,
  rules?: UpgradeRule[],
  onProgress?: (event: UpgradeProgress) => void,
): UpgradeAnalysis {
  return analyzeDetectedProject(
    detectProject(root, onProgress),
    selection,
    rules,
    onProgress,
  );
}

export function analyzeDetectedProject(
  project: ReturnType<typeof detectProject>,
  selection?: UpgradeSelection,
  rules?: UpgradeRule[],
  onProgress?: (event: UpgradeProgress) => void,
): UpgradeAnalysis {
  if (!selection)
    return {
      project,
      findings: [],
      availableRuleCount: 0,
      applicableRuleCount: 0,
    };
  let started = Date.now();
  onProgress?.({ stage: "rules", status: "start", durationMs: 0 });
  const activeRules = rules ?? loadRulePacks(builtInRuleDirectory());
  const applicableRules = getApplicableUpgradeRules(activeRules, selection);
  const raw = runUpgradeRules(project.inventory, activeRules, selection);
  onProgress?.({
    stage: "rules",
    status: "complete",
    durationMs: Date.now() - started,
    detail: `${activeRules.length} rules available · ${applicableRules.length} match this upgrade · ${raw.length} findings`,
  });
  started = Date.now();
  onProgress?.({ stage: "impact", status: "start", durationMs: 0 });
  const findings = enrichFindings(raw, project.analysis);
  onProgress?.({
    stage: "impact",
    status: "complete",
    durationMs: Date.now() - started,
    detail: `${findings.length} findings enriched with static impact`,
  });
  return {
    project,
    selection,
    findings,
    availableRuleCount: activeRules.length,
    applicableRuleCount: applicableRules.length,
  };
}
