import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ProjectDetectionResult } from "../project-detector/types.js";
import type { ImpactFinding } from "../impact-engine/impact-engine.js";
import { getProductVersion } from "../product-metadata.js";
import { hasCriticalScanGaps } from "../safety/scan-policy.js";
import { createMigrationPreview } from "../migration-engine/migration-engine.js";

export type VerificationKind = "typecheck" | "build" | "test";
export type VerificationStatus =
  "passed" | "failed" | "skipped" | "timed_out" | "blocked" | "not_configured";
export interface VerificationResult {
  id: string;
  kind: VerificationKind;
  command?: string;
  exitCode?: number;
  status: VerificationStatus;
  durationMs: number;
  stdoutSummary?: string;
  stderrSummary?: string;
  startedAt: string;
  endedAt: string;
}
export interface VerifierOptions {
  kinds?: VerificationKind[];
  timeoutMs?: number;
  onCheckProgress?: (event: {
    status: "start" | "complete";
    result?: VerificationResult;
    kind: VerificationKind;
  }) => void;
}

const SCRIPT_BY_KIND: Record<VerificationKind, string[]> = {
  typecheck: ["typecheck", "type-check", "check:types", "check-types"],
  build: ["build", "compile"],
  test: ["test", "test:unit", "unit"],
};
function findNpmCli(): string | undefined {
  const candidates = [
    process.env.npm_execpath,
    path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  ].filter((item): item is string => Boolean(item));
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function selectedScript(
  scripts: Record<string, string> | undefined,
  kind: VerificationKind,
): string | undefined {
  if (!scripts) return undefined;
  return SCRIPT_BY_KIND[kind].find((name) => typeof scripts[name] === "string");
}

export function configuredVerificationKinds(
  project: ProjectDetectionResult,
): VerificationKind[] {
  const scripts = project.manifests.find((manifest) => manifest.isRoot)?.data
    .scripts;
  return (Object.keys(SCRIPT_BY_KIND) as VerificationKind[]).filter((kind) =>
    selectedScript(scripts, kind),
  );
}

const OUTPUT_CAPTURE_LIMIT = 24 * 1024;

/* eslint-disable no-control-regex -- strip ANSI and terminal control codes from captured child-process output */
function summarizeCommandOutput(output: string): string | undefined {
  const redacted = output
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(
      /((?:password|passwd|token|secret|api[_-]?key|access[_-]?key)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  if (!redacted) return undefined;
  const lines = redacted.split(/\r?\n/).slice(-12);
  let summary = lines.join("\n");
  if (summary.length > 1600) summary = `…${summary.slice(-1599)}`;
  return summary;
}
/* eslint-enable no-control-regex */

function runScript(
  root: string,
  kind: VerificationKind,
  script: string,
  options: Pick<VerifierOptions, "timeoutMs">,
): Promise<VerificationResult> {
  const startedAt = new Date();
  const start = Date.now();
  const npmCli = findNpmCli();
  if (!npmCli)
    return Promise.resolve({
      id: randomUUID(),
      kind,
      command: `npm run ${script}`,
      status: "blocked",
      durationMs: 0,
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
    });
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(process.execPath, [npmCli, "run", script], {
        cwd: root,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      resolve({
        id: randomUUID(),
        kind,
        command: `npm run ${script}`,
        status: "blocked",
        durationMs: Date.now() - start,
        startedAt: startedAt.toISOString(),
        endedAt: new Date().toISOString(),
      });
      return;
    }
    child.stdin.end();
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) {
        const killer = spawn(
          "taskkill",
          ["/PID", String(child.pid), "/T", "/F"],
          { shell: false, windowsHide: true, stdio: "ignore" },
        );
        killer.unref();
      } else if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      }
    }, options.timeoutMs);
    // Keep only a small tail for failure diagnostics. Proof files deliberately
    // discard these summaries, and obvious credential assignments are redacted.
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(
        -OUTPUT_CAPTURE_LIMIT,
      );
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(
        -OUTPUT_CAPTURE_LIMIT,
      );
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        id: randomUUID(),
        kind,
        command: `npm run ${script}`,
        status: "blocked",
        durationMs: Date.now() - start,
        startedAt: startedAt.toISOString(),
        endedAt: new Date().toISOString(),
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        id: randomUUID(),
        kind,
        command: `npm run ${script}`,
        exitCode: code ?? undefined,
        status: timedOut ? "timed_out" : code === 0 ? "passed" : "failed",
        durationMs: Date.now() - start,
        ...(code === 0 && !timedOut
          ? {}
          : {
              ...(summarizeCommandOutput(stdout)
                ? { stdoutSummary: summarizeCommandOutput(stdout) }
                : {}),
              ...(summarizeCommandOutput(stderr)
                ? { stderrSummary: summarizeCommandOutput(stderr) }
                : {}),
            }),
        startedAt: startedAt.toISOString(),
        endedAt: new Date().toISOString(),
      });
    });
  });
}

export async function verifyProject(
  project: ProjectDetectionResult,
  options: VerifierOptions = {},
): Promise<VerificationResult[]> {
  const normalized: Required<Pick<VerifierOptions, "kinds" | "timeoutMs">> = {
    kinds: options.kinds ?? ["typecheck", "build", "test"],
    timeoutMs: options.timeoutMs ?? 120_000,
  };
  const scripts = project.manifests.find((manifest) => manifest.isRoot)?.data
    .scripts;
  const results: VerificationResult[] = [];
  for (const kind of normalized.kinds) {
    options.onCheckProgress?.({ status: "start", kind });
    const script = selectedScript(scripts, kind);
    if (!script) {
      const now = new Date().toISOString();
      const result: VerificationResult = {
        id: randomUUID(),
        kind,
        status: "not_configured",
        durationMs: 0,
        startedAt: now,
        endedAt: now,
      };
      results.push(result);
      options.onCheckProgress?.({ status: "complete", kind, result });
    } else {
      const result = await runScript(project.root, kind, script, normalized);
      results.push(result);
      options.onCheckProgress?.({ status: "complete", kind, result });
    }
  }
  return results;
}

export interface ProofDocument {
  schemaVersion: 1;
  tool: { name: "UpgradeX"; version: string };
  run: {
    id: string;
    timestamp: string;
    status:
      | "VERIFIED FOR OBSERVED CHECKS"
      | "NEEDS MIGRATION"
      | "BLOCKED"
      | "INCONCLUSIVE"
      | "READY TO REVIEW";
  };
  project: { name?: string; root: string };
  selection?: { technology: string; current: string; target: string };
  summary: { surfaces: number; findings: number; blindSpots: number };
  versionSurfaces: ProjectDetectionResult["versionSurfaceMap"];
  findings: ImpactFinding[];
  migrations: Array<{
    ruleIds: string[];
    files: string[];
    status: "available" | "manual" | "applied" | "skipped";
  }>;
  verification: VerificationResult[];
  blindSpots: string[];
}

export function createProof(
  project: ProjectDetectionResult,
  findings: ImpactFinding[],
  verification: VerificationResult[],
  selection?: ProofDocument["selection"],
  migrations?: ProofDocument["migrations"],
): ProofDocument {
  const failed = verification.some((result) =>
    ["failed", "timed_out", "blocked"].includes(result.status),
  );
  const unconfigured = verification.some(
    (result) => result.status === "not_configured",
  );
  const status = failed
    ? "BLOCKED"
    : findings.length
      ? "NEEDS MIGRATION"
      : unconfigured ||
          hasCriticalScanGaps(
            project.inventory.warnings,
            project.analysis.blindSpots,
          )
        ? "INCONCLUSIVE"
        : verification.length === 0
          ? "READY TO REVIEW"
          : "VERIFIED FOR OBSERVED CHECKS";
  const name = project.manifests.find((manifest) => manifest.isRoot)?.data.name;
  const blindSpots = [
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
  ].sort();
  const preview = createMigrationPreview(project.inventory, findings);
  const previewableRules = new Set(
    preview.files.flatMap((file) => file.ruleIds),
  );
  return {
    schemaVersion: 1,
    tool: { name: "UpgradeX", version: getProductVersion() },
    run: { id: randomUUID(), timestamp: new Date().toISOString(), status },
    project: { name, root: project.root },
    ...(selection ? { selection } : {}),
    summary: {
      surfaces: project.versionSurfaceMap.totalSurfaces,
      findings: findings.length,
      blindSpots: blindSpots.length,
    },
    versionSurfaces: project.versionSurfaceMap,
    findings,
    migrations:
      migrations ??
      findings.map((finding) => ({
        ruleIds: [finding.ruleId],
        files: [finding.location.file],
        status: previewableRules.has(finding.ruleId) ? "available" : "manual",
      })),
    verification: verification.map((result) => {
      const safeResult = { ...result };
      delete safeResult.stdoutSummary;
      delete safeResult.stderrSummary;
      return safeResult;
    }),
    blindSpots,
  };
}

export function writeProof(projectRoot: string, proof: ProofDocument): string {
  const root = fs.realpathSync(path.resolve(projectRoot));
  if (!fs.statSync(root).isDirectory())
    throw new Error(`Proof destination is not a directory: ${root}`);
  const output = path.join(root, "upgradex.proof.json");
  try {
    const existing = fs.lstatSync(output);
    if (existing.isSymbolicLink() || !existing.isFile())
      throw new Error(
        `Refusing to replace non-file proof destination: ${output}`,
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = path.join(
    root,
    `.upgradex.proof.${process.pid}.${randomUUID()}.tmp`,
  );
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(temporary, output);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return output;
}
