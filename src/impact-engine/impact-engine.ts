import type {
  RepositoryAnalysis,
  ChangeGraphNode,
} from "../analyzer/change-graph.js";
import type { RuleFinding } from "../rules/rule-engine.js";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export interface FindingImpact {
  directFile: string;
  affectedFiles: string[];
  affectedSymbols: string[];
  affectedRoutes: string[];
  affectedTests: string[];
  relatedConfiguration: string[];
  blindSpots: string[];
  traversal: Array<{
    from: string;
    fromLabel: string;
    edge: string;
    to: string;
    toLabel: string;
    resolution: string;
  }>;
}
export interface RiskAssessment {
  level: RiskLevel;
  reasons: string[];
}
export interface ImpactFinding extends RuleFinding {
  impact: FindingImpact;
  risk: RiskAssessment;
}

function sourceFileNode(
  analysis: RepositoryAnalysis,
  relativePath: string,
): ChangeGraphNode | undefined {
  return analysis.graph
    .getNodesBySource(relativePath)
    .find((node) => node.type === "FILE" || node.type === "TEST");
}

function computeImpact(
  finding: RuleFinding,
  analysis: RepositoryAnalysis,
): FindingImpact {
  const relativePath = finding.location.file.replaceAll("\\", "/");
  const root = sourceFileNode(analysis, relativePath);
  const related = root ? analysis.graph.traverse(root.id, { depth: 3 }) : [];
  const allNodes = root ? [root, ...related] : [];
  const affectedFiles = [
    ...new Set(
      allNodes
        .filter((node) => node.type === "FILE" || node.type === "TEST")
        .map((node) => node.source),
    ),
  ].sort();
  const affectedSymbols = [
    ...new Set(
      allNodes
        .filter(
          (node) =>
            node.type === "FUNCTION" ||
            node.type === "CLASS" ||
            node.type === "SYMBOL",
        )
        .map((node) => node.name),
    ),
  ].sort();
  const affectedRoutes = [
    ...new Set(
      allNodes
        .filter((node) => node.type === "ENDPOINT")
        .map((node) => node.name),
    ),
  ].sort();
  const affectedTests = [
    ...new Set(
      allNodes
        .filter((node) => node.type === "TEST")
        .map((node) => node.source),
    ),
  ].sort();
  const relatedConfiguration = [
    ...new Set(
      allNodes
        .filter((node) => node.type === "CONFIG")
        .map((node) => node.source),
    ),
  ].sort();
  const ids = new Set(allNodes.map((node) => node.id));
  const traversal = analysis.graph.edgesWithin(ids).flatMap((edge) => {
    const from = analysis.graph.getNode(edge.source);
    const to = analysis.graph.getNode(edge.target);
    if (!from || !to) return [];
    return [
      {
        from: edge.source,
        fromLabel: `${from.type} ${from.name} (${from.source})`,
        edge: edge.type,
        to: edge.target,
        toLabel: `${to.type} ${to.name} (${to.source})`,
        resolution: edge.resolution,
      },
    ];
  });
  const blindSpots = analysis.blindSpots
    .filter((spot) => !spot.location || spot.location.file === relativePath)
    .map((spot) => `${spot.code}: ${spot.message}`);
  return {
    directFile: relativePath,
    affectedFiles,
    affectedSymbols,
    affectedRoutes,
    affectedTests,
    relatedConfiguration,
    blindSpots,
    traversal,
  };
}

function computeRisk(
  finding: RuleFinding,
  impact: FindingImpact,
): RiskAssessment {
  let level: RiskLevel = finding.severity.toUpperCase() as RiskLevel;
  const reasons = [
    `${finding.severity} severity rule ${finding.ruleId} was detected at ${finding.location.file}:${finding.location.line}.`,
  ];
  if (impact.affectedRoutes.length > 0) {
    reasons.push(
      `${impact.affectedRoutes.length} route endpoint(s) are connected to the affected code.`,
    );
    if (level === "MEDIUM") level = "HIGH";
  }
  if (impact.affectedTests.length === 0) {
    reasons.push(
      "No statically connected tests were found; this is not proof that tests do not exist.",
    );
  } else {
    reasons.push(
      `${impact.affectedTests.length} statically connected test file(s) were found.`,
    );
  }
  if (impact.blindSpots.length > 0)
    reasons.push(
      `${impact.blindSpots.length} related static-analysis blind spot(s) remain.`,
    );
  if (finding.codemod)
    reasons.push(
      "This rule names a codemod; a deterministic preview must confirm an edit for this exact finding.",
    );
  return { level, reasons };
}

export function enrichFindings(
  findings: RuleFinding[],
  analysis: RepositoryAnalysis,
): ImpactFinding[] {
  return findings.map((finding) => {
    const impact = computeImpact(finding, analysis);
    return { ...finding, impact, risk: computeRisk(finding, impact) };
  });
}
