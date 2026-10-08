#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import semver from "semver";
import {
  confirm,
  isCancel,
  multiselect,
  select,
  spinner,
  text,
} from "@clack/prompts";
import pc from "picocolors";
import {
  analyzeUpgrade,
  analyzeDetectedProject,
  type UpgradeSelection,
} from "../../src/upgrade-pipeline.js";
import {
  createMigrationPreview,
  applyMigrationPreview,
} from "../../src/migration-engine/migration-engine.js";
import {
  verifyProject,
  configuredVerificationKinds,
  createProof,
  writeProof,
  type VerificationKind,
} from "../../src/verifier/verifier.js";
import {
  createScanReport,
  createSarif,
  renderHumanSummary,
  renderHumanReport,
  renderHumanDetailedAnalysis,
  renderHumanImpactAssessment,
  renderHumanMigrationPlan,
  renderHumanVerificationResults,
  wrapHumanReport,
} from "../../src/reporting/reports.js";
import { getProductVersion } from "../../src/product-metadata.js";

interface Arguments {
  command: string;
  root: string;
  format: "human" | "json" | "sarif";
  output?: string;
  selection?: UpgradeSelection;
  allowDirty: boolean;
  timeoutMs: number;
  verifyKinds: VerificationKind[];
  ci: boolean;
  details: boolean;
}
function version(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return `${value}.0.0`;
  if (/^\d+\.\d+$/.test(value)) return `${value}.0`;
  return value;
}
function parseArgs(args: string[]): Arguments {
  const commands = new Set([
    "scan",
    "verify",
    "migrate",
    "help",
    "--help",
    "-h",
  ]);
  const command = commands.has(args[0] ?? "") ? args[0]! : "scan";
  const startIndex = commands.has(args[0] ?? "") ? 1 : 0;
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = startIndex; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equal = token.indexOf("=");
    if (equal > 0) flags.set(token.slice(2, equal), token.slice(equal + 1));
    else if (args[index + 1] && !args[index + 1]!.startsWith("--"))
      flags.set(token.slice(2), args[++index]!);
    else switches.add(token.slice(2));
  }
  if (positionals.length > 1)
    throw new Error(`${command} accepts at most one project path.`);
  const flagsByCommand: Record<string, Set<string>> = {
    scan: new Set(["technology", "from", "to", "format", "output"]),
    verify: new Set(["only", "timeout", "format", "output"]),
    migrate: new Set(["technology", "from", "to", "timeout"]),
  };
  const switchesByCommand: Record<string, Set<string>> = {
    scan: new Set(["ci", "json", "sarif", "details"]),
    verify: new Set(["ci"]),
    migrate: new Set(["ci", "allow-dirty"]),
  };
  for (const flag of flags.keys())
    if (!flagsByCommand[command]?.has(flag))
      throw new Error(`Unknown option --${flag} for ${command}.`);
  for (const option of switches)
    if (!switchesByCommand[command]?.has(option))
      throw new Error(`Unknown option --${option} for ${command}.`);
  const tech = flags.get("technology");
  const from = version(flags.get("from"));
  const to = version(flags.get("to"));
  let selection: UpgradeSelection | undefined;
  if (tech || from || to) {
    if ((tech !== "node" && tech !== "express") || !from || !to)
      throw new Error(
        "Upgrade analysis requires --technology node|express, --from, and --to.",
      );
    selection = { technology: tech, current: from, target: to };
    if (!semver.valid(from) || !semver.valid(to))
      throw new Error(
        "--from and --to must be valid versions or version ranges, such as 22 and 24.",
      );
  }
  const formatValue =
    flags.get("format") ??
    (switches.has("json") ? "json" : switches.has("sarif") ? "sarif" : "human");
  if (
    formatValue !== "human" &&
    formatValue !== "json" &&
    formatValue !== "sarif"
  )
    throw new Error("--format must be human, json, or sarif.");
  const timeout = Number(flags.get("timeout") ?? 120_000);
  if (!Number.isFinite(timeout) || timeout < 1_000 || timeout > 3_600_000)
    throw new Error("--timeout must be between 1000 and 3600000 milliseconds.");
  const onlyValue = flags.get("only");
  const verifyKinds: VerificationKind[] = onlyValue
    ? onlyValue
        .split(",")
        .filter((kind): kind is VerificationKind =>
          ["typecheck", "build", "test"].includes(kind),
        )
    : ["typecheck", "build", "test"];
  if (onlyValue && verifyKinds.length !== onlyValue.split(",").length)
    throw new Error("--only accepts typecheck, build, and test.");
  return {
    command,
    root: path.resolve(positionals[0] ?? process.cwd()),
    format: formatValue,
    output: flags.get("output"),
    selection,
    allowDirty: switches.has("allow-dirty"),
    timeoutMs: timeout,
    verifyKinds,
    ci: switches.has("ci"),
    details: switches.has("details"),
  };
}
function writeOutput(output: string | undefined, content: string): void {
  if (output)
    fs.writeFileSync(path.resolve(output), content, {
      encoding: "utf8",
      mode: 0o600,
    });
  else process.stdout.write(`${content}\n`);
}
/* eslint-disable no-control-regex -- these expressions intentionally remove terminal control sequences */
const TERMINAL_ESCAPE_REGEX =
  /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;
const TERMINAL_CONTROL_REGEX =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/* eslint-enable no-control-regex */
function sanitizeTerminal(text: string): string {
  return text
    .replace(TERMINAL_ESCAPE_REGEX, "")
    .replace(TERMINAL_CONTROL_REGEX, "");
}
function printReport(
  report: ReturnType<typeof createScanReport>,
  format: Arguments["format"],
  output?: string,
  details = false,
): void {
  const humanText = details
    ? renderHumanReport(report)
    : renderHumanSummary(report);
  const terminalReport =
    format === "human" && process.stdout.isTTY
      ? wrapHumanReport(
          humanText,
          Math.max(40, (process.stdout.columns ?? 80) - 2),
        )
      : undefined;
  const raw =
    format === "json"
      ? JSON.stringify(report, null, 2)
      : format === "sarif"
        ? JSON.stringify(createSarif(report.findings), null, 2)
        : sanitizeTerminal(terminalReport ?? humanText);
  const value =
    format === "human" &&
    !output &&
    process.stdout.isTTY &&
    !process.env.NO_COLOR
      ? colorizeReport(raw)
      : raw;
  writeOutput(output, value);
}

function printHumanSection(content: string): void {
  const wrapped = wrapHumanReport(
    content,
    Math.max(40, (process.stdout.columns ?? 80) - 2),
  );
  process.stdout.write(`${colorizeReport(sanitizeTerminal(wrapped))}\n`);
}
async function animateDetailedReportOpening(): Promise<void> {
  const durationMs = 10_000;
  const intervalMs = 250;
  const width = 20;
  const startedAt = Date.now();
  while (true) {
    const elapsed = Math.min(Date.now() - startedAt, durationMs);
    const percentage = Math.floor((elapsed / durationMs) * 100);
    const filled = Math.round((percentage / 100) * width);
    const bar = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
    process.stdout.write(
      `\r\u001B[2K  Opening detailed report  ${pc.cyan(bar)}  ${percentage}%`,
    );
    if (elapsed >= durationMs) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(intervalMs, durationMs - elapsed)),
    );
  }
  process.stdout.write("\n");
}

async function printPacedDetails(rendered: string): Promise<void> {
  const sections = rendered.split(/(?=^◇ )/m);
  for (const [index, section] of sections.entries()) {
    process.stdout.write(
      `${colorizeReport(sanitizeTerminal(section.trimEnd()))}\n`,
    );
    // Reveal completed report sections at a readable pace. Analysis itself has
    // already finished and its measured stage timings are shown separately.
    if (index < sections.length - 1)
      await new Promise((resolve) => setTimeout(resolve, 90));
  }
}

function printExitCard(): void {
  const card = [
    "◆ UpgradeX",
    "│",
    "◇ Analysis complete.",
    "│   Predict • Migrate • Deliver",
    "│",
    `│  Version ${getProductVersion()}`,
    "└─ Thank you for using UpgradeX.",
    "   ◇ Made with ❤️ by Shivam Srivastava",
  ].join("\n");
  process.stdout.write(`\n${colorizeReport(card)}\n`);
}
function colorizeReport(report: string): string {
  return report
    .split("\n")
    .map((line) => {
      if (/^(?:\u25C6|\u25C7)/.test(line.trimStart()))
        return pc.bold(pc.cyan(line));
      if (/\b(?:CRITICAL|HIGH)\b/.test(line)) return pc.red(pc.bold(line));
      if (/\bMEDIUM\b/.test(line)) return pc.yellow(line);
      if (/^(?:Final status:|└─ Status ·)/.test(line))
        return /VERIFIED|READY/.test(line)
          ? pc.green(pc.bold(line))
          : /BLOCKED|NEEDS/.test(line)
            ? pc.yellow(pc.bold(line))
            : pc.dim(line);
      if (/^\u2502\s+at /.test(line))
        return line.replace(/(\S+:\d+:\d+)/g, (location) => pc.cyan(location));
      if (/^\u2502\s+(?:Impact graph:|Reach:)/.test(line)) return pc.dim(line);
      if (/^\u2502\s+Blind spot:/.test(line)) return pc.yellow(line);
      return line;
    })
    .join("\n");
}

const GLOBAL_HELP = `UpgradeX - project upgrade analysis\n\nUsage:\n  upgradex <command> [path] [options]\n\nCommands:\n  scan      Inspect project versions and upgrade findings\n  verify    Run configured typecheck, build, and test scripts\n  migrate   Preview and apply supported migrations\n\nOptions:\n  --help, -h     Show help\n  --version      Show version`;
const COMMAND_HELP: Record<string, string> = {
  scan: `Usage:\n  upgradex scan [path] [options]\n\nOptions:\n  --technology node|express\n  --from VERSION\n  --to VERSION\n  --format human|json|sarif\n  --output FILE\n  --details        Show full findings, impact graph, and evidence\n  --ci             Disable interactive prompts\n  --help, -h       Show scan help`,
  verify: `Usage:\n  upgradex verify [path] [options]\n\nOptions:\n  --only typecheck,build,test\n  --timeout MS\n  --format human|json|sarif\n  --ci             Disable interactive prompts\n  --help, -h       Show verify help`,
  migrate: `Usage:\n  upgradex migrate [path] [options]\n\nOptions:\n  --technology node|express\n  --from VERSION\n  --to VERSION\n  --allow-dirty    Permit changes to affected dirty files\n  --timeout MS\n  --ci             Disable interactive prompts\n  --help, -h       Show migrate help`,
};

function packageVersion(): string {
  return getProductVersion();
}

function helpFor(args: string[]): string | undefined {
  if (args.includes("--version") || args.includes("-v"))
    return packageVersion();
  if (!args.includes("--help") && !args.includes("-h") && args[0] !== "help")
    return undefined;
  const command = args.find((arg) => Object.hasOwn(COMMAND_HELP, arg));
  return command ? COMMAND_HELP[command] : GLOBAL_HELP;
}

function isInteractive(ci: boolean): boolean {
  return !ci && Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function promptScanSelection(
  project: ReturnType<typeof analyzeUpgrade>["project"],
): Promise<UpgradeSelection | undefined | null> {
  type DetectedTechnology =
    "node" | "express" | "react" | "vite" | "typescript";
  const labels: Record<DetectedTechnology, string> = {
    node: "Node.js",
    express: "Express",
    react: "React",
    vite: "Vite",
    typescript: "TypeScript",
  };
  type DetectedGroup = (typeof project.versionSurfaceMap.groups)[number] & {
    technology: DetectedTechnology;
  };
  const groups = new Map(
    project.versionSurfaceMap.groups
      .filter(
        (group): group is DetectedGroup =>
          group.technology !== "package-manager",
      )
      .map((group) => [group.technology, group]),
  );
  const technologies = new Set<DetectedTechnology>([
    ...groups.keys(),
    ...project.frameworks.technologies.map((item) => item.technology),
  ]);
  const orderedTechnologies: DetectedTechnology[] = [
    "node",
    "express",
    "react",
    "vite",
    "typescript",
  ];

  function declaredValues(technology: DetectedTechnology): string[] {
    const group = groups.get(technology);
    if (group) {
      const primary = group.surfaces.filter(
        (surface) => surface.priority === "primary",
      );
      const surfaces = primary.length > 0 ? primary : group.surfaces;
      return [...new Set(surfaces.map((surface) => surface.rawValue))];
    }
    return (
      project.frameworks.technologies.find(
        (item) => item.technology === technology,
      )?.declaredVersionRanges ?? []
    );
  }

  function declaredMajor(technology: "node" | "express"): number | undefined {
    const group = groups.get(technology);
    if (group?.consistency === "conflicting") return undefined;
    const surfaces = (group?.surfaces ?? []).filter(
      (surface) => surface.priority === "primary",
    );
    const values =
      surfaces.length > 0
        ? surfaces.map((surface) => surface.value)
        : declaredValues(technology);
    if (values.length === 0) return undefined;
    const majors = values.map((value) => {
      const range = semver.validRange(value);
      const minimum = range ? semver.minVersion(range) : null;
      return range && minimum && semver.subset(range, `${minimum.major}.x`)
        ? minimum.major
        : undefined;
    });
    const unique = [...new Set(majors)];
    return unique.length === 1 ? unique[0] : undefined;
  }

  const projectTitle =
    project.manifests.find((manifest) => manifest.isRoot)?.data.name ??
    path.basename(project.root);
  process.stdout.write(
    `${pc.bold(pc.cyan("◆ Detected project"))}\n│  Project: ${projectTitle}\n│  Package manager: ${project.packageManager}\n`,
  );
  process.stdout.write(`${pc.bold(pc.cyan("◇ Detected technology stack"))}\n`);
  if (technologies.size === 0) {
    process.stdout.write("└─ No supported version references detected.\n");
  } else {
    for (const [index, technology] of orderedTechnologies
      .filter((item) => technologies.has(item))
      .entries()) {
      const values = declaredValues(technology);
      const group = groups.get(technology);
      const evidence =
        values.length > 0
          ? values.join(", ")
          : "usage detected; version not declared";
      const prefix = index === technologies.size - 1 ? "└─" : "├─";
      process.stdout.write(
        `${prefix} ${labels[technology]} · ${evidence}${group ? ` · ${group.surfaces.length} surface(s)` : ""}\n`,
      );
    }
  }

  const options: Array<{ value: string; label: string; hint: string }> =
    orderedTechnologies
      .filter((technology) => technologies.has(technology))
      .map((technology) => {
        const values = declaredValues(technology);
        const detail =
          values.length > 0 ? values.join(", ") : "version unknown";
        const currentMajor =
          technology === "node" || technology === "express"
            ? declaredMajor(technology)
            : undefined;
        const target =
          technology === "node" ? 24 : technology === "express" ? 5 : undefined;
        const supported =
          (technology === "node" && currentMajor === 22) ||
          (technology === "express" && currentMajor === 4);
        return {
          value: technology,
          label: supported
            ? `${labels[technology]} ${currentMajor} → ${target}`
            : `${labels[technology]} · detected ${detail}`,
          hint:
            technology === "node" || technology === "express"
              ? supported
                ? `${groups.get(technology)?.surfaces.length ?? 0} version reference(s); known upgrade rules available`
                : `Known rules: ${technology === "node" ? "Node.js 22 → 24" : "Express 4 → 5"}; confirm a supported current version to analyze`
              : "Surface detection is available; upgrade rules are not available yet",
        };
      });
  options.push({
    value: "overview",
    label: "View all detected version references",
    hint: "Inspect all upgrade footprint references without running rules",
  });

  const mode = await select({
    message: "What would you like to upgrade?",
    options,
  });
  if (isCancel(mode)) return null;
  if (mode === "overview") return undefined;
  if (mode !== "node" && mode !== "express") {
    const technology = mode as DetectedTechnology;
    const group = groups.get(technology);
    const values = declaredValues(technology);
    process.stdout.write(
      `${pc.bold(pc.cyan(`◇ ${labels[technology]} detected${values.length ? ` · ${values.join(", ")}` : ""}`))}\n  Surface detection is available, but upgrade intelligence for ${labels[technology]} is not available yet.\n`,
    );
    if (group) {
      for (const surface of group.surfaces) {
        const location = `${surface.location.relativePath}${surface.location.line === undefined ? "" : `:${surface.location.line}`}${surface.location.jsonPath ? ` (${surface.location.jsonPath})` : ""}`;
        process.stdout.write(`  ${location} → ${surface.rawValue}\n`);
      }
    }
    return undefined;
  }

  const technology = mode;
  const currentMajor = declaredMajor(technology);
  const supportedMajor = technology === "node" ? 22 : 4;
  const targetMajor = technology === "node" ? 24 : 5;
  if (currentMajor !== undefined && currentMajor !== supportedMajor) {
    process.stdout.write(
      `${pc.yellow(`Upgrade rules currently support ${labels[technology]} ${supportedMajor} → ${targetMajor}; detected declarations do not identify that starting major.`)}\n`,
    );
    return undefined;
  }

  let current = String(currentMajor ?? "");
  if (!current) {
    const from = await text({
      message: `Current ${labels[technology]} major version (needed to select a supported rule pack)`,
      placeholder: String(supportedMajor),
    });
    if (isCancel(from)) return null;
    current = from as string;
  }
  const normalizedCurrent = version(current);
  if (!normalizedCurrent || !semver.valid(normalizedCurrent))
    throw new Error("Enter a valid current major version.");
  if (!semver.satisfies(normalizedCurrent, `${supportedMajor}.x`)) {
    process.stdout.write(
      `${pc.yellow(`Upgrade rules currently support ${labels[technology]} ${supportedMajor} → ${targetMajor}; no matching rule pack is available for ${current}.`)}\n`,
    );
    return undefined;
  }

  const group = groups.get(technology);
  if (group) {
    process.stdout.write(
      `${pc.bold(pc.cyan(`◇ Version Surface Map · ${labels[technology]}`))}\n`,
    );
    for (const surface of group.surfaces) {
      const location = `${surface.location.relativePath}${surface.location.line === undefined ? "" : `:${surface.location.line}${surface.location.column === undefined ? "" : `:${surface.location.column}`}`}${surface.location.jsonPath ? ` (${surface.location.jsonPath})` : ""}`;
      process.stdout.write(
        `├─ Reference · ${location} → ${surface.rawValue} · ${surface.priority}\n`,
      );
    }
    for (const conflict of group.conflicts)
      process.stdout.write(`${pc.yellow(`! Conflict: ${conflict}`)}\n`);
  }

  const proceed = await confirm({
    message: `Analyze ${labels[technology]} ${supportedMajor} → ${targetMajor} using the supported upgrade rules?`,
    initialValue: true,
  });
  if (isCancel(proceed)) return null;
  if (!proceed) return undefined;
  return {
    technology,
    current: String(supportedMajor),
    target: String(targetMajor),
  };
}

async function promptVerificationKinds(): Promise<VerificationKind[] | null> {
  const selected = await multiselect({
    message:
      "Choose project scripts to run (they execute with your current permissions).",
    options: [
      { value: "typecheck", label: "Typecheck" },
      { value: "build", label: "Build" },
      { value: "test", label: "Tests" },
    ],
    initialValues: ["typecheck", "build", "test"],
    required: false,
  });
  return isCancel(selected) ? null : (selected as VerificationKind[]);
}
async function promptMigrationSelection(): Promise<UpgradeSelection | null> {
  const technology = await select({
    message: "Which upgrade should I prepare?",
    options: [
      {
        value: "express",
        label: "Express 4 to 5",
        hint: "Preview supported Express migration rules",
      },
      {
        value: "node",
        label: "Node.js 22 to 24",
        hint: "Preview supported Node.js migration rules",
      },
    ],
  });
  if (isCancel(technology)) return null;
  const defaults = technology === "node" ? ["22", "24"] : ["4", "5"];
  const from = await text({
    message: `Current ${technology} version`,
    placeholder: defaults[0],
    defaultValue: defaults[0],
  });
  if (isCancel(from)) return null;
  const to = await text({
    message: `Target ${technology} version`,
    placeholder: defaults[1],
    defaultValue: defaults[1],
  });
  if (isCancel(to)) return null;
  const current = version(from as string);
  const target = version(to as string);
  if (!current || !target || !semver.valid(current) || !semver.valid(target))
    throw new Error("Enter valid current and target versions.");
  return { technology: technology as "node" | "express", current, target };
}
function projectName(
  project: ReturnType<typeof analyzeUpgrade>["project"],
): string {
  return (
    project.manifests.find((manifest) => manifest.isRoot)?.data.name ??
    project.root
  );
}

function progressStageLabel(stage: string): string {
  const labels: Record<string, string> = {
    index: "Indexing project files",
    project: "Preparing source files",
    versions: "Detecting technologies & mapping versions",
    source: "Analyzing code relationships",
    rules: "Evaluating compatibility rules",
    impact: "Tracing static impact",
    assessment: "Building assessment",
  };
  return labels[stage] ?? stage;
}

function createAnalysisProgress(enabled: boolean) {
  let headerShown = false;
  let stagesFinished = 0;
  let measuredMs = 0;
  const completedRows: string[] = [];
  return {
    onProgress(
      event: Parameters<NonNullable<Parameters<typeof analyzeUpgrade>[3]>>[0],
    ) {
      if (!enabled) return;
      if (!headerShown) {
        process.stdout.write(`${pc.bold(pc.cyan("◇ Analysis progress"))}\n`);
        headerShown = true;
      }
      const label = progressStageLabel(event.stage);
      if (event.status === "start") {
        process.stdout.write(`  ${pc.cyan("⠋")} ${label}…`);
        return;
      }
      process.stdout.write("\r\u001B[2K");
      const duration =
        event.durationMs < 1000
          ? `${event.durationMs} ms`
          : `${(event.durationMs / 1000).toFixed(2)} s`;
      completedRows.push(
        `  ${pc.green("✓")} ${label} · ${event.detail ?? "complete"} · ${duration}`,
      );
      stagesFinished += 1;
      measuredMs += event.durationMs;
    },
    async finish() {
      if (!enabled || !headerShown) return;
      process.stdout.write(
        `${pc.bold(pc.cyan("◇ Completed analysis steps"))}\n`,
      );
      for (const [index, row] of completedRows.entries()) {
        process.stdout.write(`${row}\n`);
        if (index < completedRows.length - 1)
          await new Promise((resolve) => setTimeout(resolve, 85));
      }
      process.stdout.write(
        `${pc.dim(`Analysis work complete · ${stagesFinished} measured stages · ${(measuredMs / 1000).toFixed(2)} s`)}\n\n`,
      );
    },
  };
}

async function runVerificationWithProgress(
  project: Parameters<typeof verifyProject>[0],
  options: Parameters<typeof verifyProject>[1],
  showProgress: boolean,
) {
  let active: ReturnType<typeof spinner> | undefined;
  return verifyProject(project, {
    ...options,
    onCheckProgress(event) {
      if (!showProgress) return;
      const label =
        event.kind === "test"
          ? "Tests"
          : event.kind === "typecheck"
            ? "Typecheck"
            : "Build";
      if (event.status === "start") {
        active = spinner();
        active.start(`Running ${label.toLowerCase()} script…`);
      } else if (event.result) {
        const result = event.result;
        const elapsed =
          result.durationMs >= 1000
            ? `${(result.durationMs / 1000).toFixed(2)} s`
            : `${result.durationMs} ms`;
        const message = `${label} · ${result.status.replaceAll("_", " ").toUpperCase()}${result.durationMs ? ` · ${elapsed}` : ""}`;
        if (["failed", "timed_out", "blocked"].includes(result.status))
          active?.error(message);
        else if (result.status === "passed") active?.stop(message);
        else active?.stop(`${label} · NOT CONFIGURED`);
        active = undefined;
      }
    },
  });
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const help = helpFor(rawArgs);
  if (help) {
    process.stdout.write(`${help}\n`);
    return;
  }
  const args = parseArgs(rawArgs);
  if (
    args.command === "help" ||
    args.command === "--help" ||
    args.command === "-h"
  ) {
    process.stdout.write(`${GLOBAL_HELP}\n`);
    return;
  }
  if (args.command === "scan") {
    const showProgress =
      args.format === "human" &&
      !args.output &&
      isInteractive(args.ci) &&
      !process.env.NO_COLOR;
    const analysisProgress = createAnalysisProgress(showProgress);
    const interactiveScan =
      isInteractive(args.ci) &&
      !args.selection &&
      !rawArgs.some((argument) =>
        ["--format", "--output"].some(
          (option) => argument === option || argument.startsWith(`${option}=`),
        ),
      );
    let result: ReturnType<typeof analyzeUpgrade>;
    if (interactiveScan) {
      const detected = analyzeUpgrade(
        args.root,
        undefined,
        undefined,
        analysisProgress.onProgress,
      );
      const selection = await promptScanSelection(detected.project);
      if (selection === null) {
        process.stdout.write("Cancelled.\n");
        return;
      }
      args.selection = selection;
      result = analyzeDetectedProject(
        detected.project,
        args.selection,
        undefined,
        analysisProgress.onProgress,
      );
    } else {
      result = analyzeUpgrade(
        args.root,
        args.selection,
        undefined,
        analysisProgress.onProgress,
      );
    }
    analysisProgress.onProgress({
      stage: "assessment",
      status: "start",
      durationMs: 0,
    });
    const assessmentStarted = Date.now();
    let scanReport = createScanReport(
      result.project,
      result.findings,
      [],
      result.selection,
      {
        available: result.availableRuleCount,
        applicable: result.applicableRuleCount,
      },
    );
    analysisProgress.onProgress({
      stage: "assessment",
      status: "complete",
      durationMs: Date.now() - assessmentStarted,
      detail: `${scanReport.findings.length} findings · ${scanReport.diagnostics.length} scan notes · ${scanReport.finalStatus}`,
    });
    await analysisProgress.finish();
    printReport(scanReport, args.format, args.output, args.details);
    if (
      isInteractive(args.ci) &&
      args.format === "human" &&
      !args.output &&
      !args.details
    ) {
      let migrationReviewedNoAction = false;
      let migrationPreview = result.selection
        ? createMigrationPreview(result.project.inventory, result.findings)
        : undefined;
      let finished = false;
      while (!finished) {
        const options = [
          { value: "impact", label: "Review Upgrade Impact" },
          {
            value: "migration",
            label: "Review Migration Plan",
            disabled:
              !migrationPreview ||
              (!migrationPreview.files.length &&
                !migrationPreview.manual.length) ||
              migrationReviewedNoAction,
            hint: !result.selection
              ? "Select a supported upgrade path first"
              : migrationPreview?.files.length ||
                  migrationPreview?.manual.length
                ? undefined
                : "No migration findings were detected for this scan",
          },
          { value: "verify", label: "Verify the Upgrade" },
          {
            value: "details",
            label: "View Detailed Analysis & Affected Files",
          },
          { value: "exit", label: "Exit" },
        ];
        const action = await select({
          message: "What would you like to do next?",
          options,
        });
        if (isCancel(action) || action === "exit") {
          finished = true;
          continue;
        }
        if (action === "impact") {
          const text = wrapHumanReport(
            renderHumanImpactAssessment(scanReport),
            Math.max(40, (process.stdout.columns ?? 80) - 2),
          );
          process.stdout.write(`${colorizeReport(sanitizeTerminal(text))}\n`);
        } else if (action === "migration") {
          if (!result.selection || !migrationPreview) continue;
          const preview = migrationPreview;
          const plan = wrapHumanReport(
            renderHumanMigrationPlan(preview),
            Math.max(40, (process.stdout.columns ?? 80) - 2),
          );
          process.stdout.write(`${colorizeReport(sanitizeTerminal(plan))}\n`);
          if (!preview.files.length) {
            migrationReviewedNoAction = true;
            continue;
          }
          let migrationMenu = true;
          while (migrationMenu) {
            const choices = [
              ...(preview.files.length
                ? [
                    { value: "preview", label: "Preview proposed changes" },
                    { value: "apply", label: "Apply approved changes" },
                  ]
                : []),
              { value: "return", label: "Return to main menu" },
            ];
            const migrationAction = await select({
              message: "Review the migration plan",
              options: choices,
            });
            if (isCancel(migrationAction) || migrationAction === "return") {
              migrationMenu = false;
            } else if (migrationAction === "preview") {
              for (const file of preview.files) {
                process.stdout.write(
                  `\n${pc.cyan(file.file)}\n${sanitizeTerminal(file.diff)}\n`,
                );
                await new Promise((resolve) => setTimeout(resolve, 280));
              }
              process.stdout.write("Preview only · no files changed.\n");
            } else if (migrationAction === "apply") {
              const approved = await confirm({
                message: `Apply ${preview.files.length} reviewed file change(s)? A backup will be created first.`,
                initialValue: false,
              });
              if (!isCancel(approved) && approved) {
                const applied = applyMigrationPreview(args.root, preview, {
                  approved: true,
                  allowDirty: args.allowDirty,
                });
                if (applied.blocked) {
                  process.stdout.write(`${pc.red(applied.blocked)}\n`);
                } else {
                  process.stdout.write(
                    `${pc.green(`Updated ${applied.applied.length} file(s).`)}\nBackup · ${applied.backupDirectory}\nRescan · ${applied.rescanned ? "complete" : "not run"}\n`,
                  );
                  const rescanned = analyzeUpgrade(args.root, result.selection);
                  const configured = configuredVerificationKinds(
                    rescanned.project,
                  );
                  const verification = configured.length
                    ? await runVerificationWithProgress(
                        rescanned.project,
                        { kinds: configured, timeoutMs: args.timeoutMs },
                        showProgress,
                      )
                    : [];
                  scanReport = createScanReport(
                    rescanned.project,
                    rescanned.findings,
                    verification,
                    result.selection,
                    {
                      available: rescanned.availableRuleCount,
                      applicable: rescanned.applicableRuleCount,
                    },
                  );
                  result = rescanned;
                  migrationPreview = createMigrationPreview(
                    rescanned.project.inventory,
                    rescanned.findings,
                  );
                  migrationReviewedNoAction = false;
                  const proof = createProof(
                    rescanned.project,
                    rescanned.findings,
                    verification,
                    result.selection,
                    preview.files.map((file) => ({
                      ruleIds: file.ruleIds,
                      files: [file.file],
                      status: "applied" as const,
                    })),
                  );
                  const proofPath = writeProof(args.root, proof);
                  if (verification.length)
                    printHumanSection(
                      renderHumanVerificationResults(verification),
                    );
                  process.stdout.write(
                    `Post-migration · ${rescanned.findings.length} finding(s) remain\nProof saved · ${proofPath}\n`,
                  );
                  if (
                    rescanned.findings.some((finding) =>
                      ["high", "critical"].includes(finding.severity),
                    ) ||
                    verification.some((item) =>
                      ["failed", "timed_out", "blocked"].includes(item.status),
                    )
                  )
                    process.exitCode = 1;
                }
                migrationMenu = false;
              }
            }
          }
        } else if (action === "verify") {
          const kinds = configuredVerificationKinds(result.project);
          if (!kinds.length) {
            process.stdout.write(
              `${pc.yellow("No typecheck, build, or test scripts were found in the root package.json.")}\n`,
            );
            continue;
          }
          const runChecks = await confirm({
            message: `Run configured checks: ${kinds.join(", ")}? Project scripts execute with your current permissions.`,
            initialValue: true,
          });
          if (!isCancel(runChecks) && runChecks) {
            const verification = await runVerificationWithProgress(
              result.project,
              { kinds, timeoutMs: args.timeoutMs },
              showProgress,
            );
            const verificationReport = createScanReport(
              result.project,
              result.findings,
              verification,
              result.selection,
              {
                available: result.availableRuleCount,
                applicable: result.applicableRuleCount,
              },
            );
            scanReport = verificationReport;
            const proof = createProof(
              result.project,
              result.findings,
              verification,
              result.selection,
            );
            const proofPath = writeProof(args.root, proof);
            printHumanSection(
              renderHumanVerificationResults(verificationReport.verification),
            );
            process.stdout.write(`Proof saved · ${proofPath}\n`);
            if (
              verification.some((item) =>
                ["failed", "timed_out", "blocked"].includes(item.status),
              )
            )
              process.exitCode = 1;
          }
        } else if (action === "details") {
          const detailedReport = createScanReport(
            result.project,
            result.findings,
            scanReport.verification,
            result.selection,
            {
              available: result.availableRuleCount,
              applicable: result.applicableRuleCount,
            },
          );
          const preview = result.selection
            ? createMigrationPreview(result.project.inventory, result.findings)
            : undefined;
          const rendered = wrapHumanReport(
            renderHumanDetailedAnalysis(detailedReport, preview),
            Math.max(40, (process.stdout.columns ?? 80) - 2),
          );
          await animateDetailedReportOpening();
          await printPacedDetails(rendered);
        }
      }
      printExitCard();
    }
    if (
      result.findings.some(
        (finding) =>
          finding.severity === "high" || finding.severity === "critical",
      )
    )
      process.exitCode = 1;
    return;
  }
  if (args.command === "verify") {
    if (
      isInteractive(args.ci) &&
      !rawArgs.some((arg) => arg === "--only" || arg.startsWith("--only="))
    ) {
      const verifyKinds = await promptVerificationKinds();
      if (verifyKinds === null) {
        process.stdout.write("Cancelled.\n");
        return;
      }
      args.verifyKinds = verifyKinds;
    }
    const result = analyzeUpgrade(args.root);
    const verification = await runVerificationWithProgress(
      result.project,
      { kinds: args.verifyKinds, timeoutMs: args.timeoutMs },
      args.format === "human" &&
        !args.output &&
        isInteractive(args.ci) &&
        !process.env.NO_COLOR,
    );
    const proof = createProof(result.project, [], verification);
    const proofPath = writeProof(args.root, proof);
    const report = createScanReport(result.project, [], verification);
    if (args.format === "human" && !args.output && process.stdout.isTTY)
      printHumanSection(renderHumanVerificationResults(report.verification));
    else printReport(report, args.format, args.output);
    if (!args.output && args.format === "human")
      process.stdout.write(`\nProof written to ${proofPath}\n`);
    if (
      verification.some((item) =>
        ["failed", "timed_out", "blocked"].includes(item.status),
      )
    )
      process.exitCode = 1;
    return;
  }
  if (args.command === "migrate") {
    if (!args.selection && isInteractive(args.ci)) {
      const selection = await promptMigrationSelection();
      if (selection === null) {
        process.stdout.write("Cancelled.\n");
        return;
      }
      args.selection = selection;
    }
    if (!args.selection)
      throw new Error(
        "migrate requires --technology node|express --from VERSION --to VERSION, or run it interactively in a terminal.",
      );
    if (
      args.selection.technology === "node" &&
      (!semver.satisfies(args.selection.current, "22.x") ||
        !semver.satisfies(args.selection.target, "24.x"))
    )
      throw new Error("migrate currently supports Node.js 22 to 24.");
    const result = analyzeUpgrade(args.root, args.selection);
    if (
      args.selection.technology === "express" &&
      (!semver.satisfies(args.selection.current, "4.x") ||
        !semver.satisfies(args.selection.target, "5.x"))
    )
      throw new Error("migrate currently supports Express 4 -> 5.");
    const preview = createMigrationPreview(
      result.project.inventory,
      result.findings,
    );
    process.stdout.write(`${pc.bold(pc.cyan("* Migration preview"))}\n\n`);
    for (const file of preview.files)
      process.stdout.write(
        `${pc.dim(file.ruleIds.join(", "))} | ${pc.cyan(file.file)}\n${sanitizeTerminal(file.diff)}\n\n`,
      );
    for (const manual of preview.manual)
      process.stdout.write(
        `${pc.yellow("MANUAL")} | ${manual.ruleId} | ${pc.cyan(`${manual.file}:${manual.line}`)}\n  ${sanitizeTerminal(manual.guidance)}\n`,
      );
    if (preview.files.length === 0) {
      process.stdout.write("No deterministic changes are available.\n");
      return;
    }
    if (!isInteractive(args.ci)) {
      process.stdout.write(
        "Preview only. Run migrate in an interactive terminal to review and approve these changes.\n",
      );
      return;
    }
    const response = await confirm({
      message: sanitizeTerminal(
        `Apply ${preview.files.length} file migration(s) to ${projectName(result.project)}? A backup will be created first.`,
      ),
    });
    const approved = !isCancel(response) && response;
    const applied = applyMigrationPreview(args.root, preview, {
      approved,
      allowDirty: args.allowDirty,
    });
    if (applied.blocked) {
      process.stderr.write(`${applied.blocked}\n`);
      process.exitCode = approved ? 2 : 0;
      return;
    }
    process.stdout.write(
      `Updated ${applied.applied.join(", ")}\nBackup: ${applied.backupDirectory}\nRescan: ${applied.rescanned ? "complete" : "not run"}\n`,
    );
    const rescanned = analyzeUpgrade(args.root, args.selection);
    const verification = await runVerificationWithProgress(
      rescanned.project,
      { timeoutMs: args.timeoutMs },
      args.format === "human" &&
        !args.output &&
        isInteractive(args.ci) &&
        !process.env.NO_COLOR,
    );
    const migrationRecords = [
      ...preview.files.map((file) => ({
        ruleIds: file.ruleIds,
        files: [file.file],
        status: "applied" as const,
      })),
      ...preview.manual.map((item) => ({
        ruleIds: [item.ruleId],
        files: [item.file],
        status: "manual" as const,
      })),
    ];
    const proof = createProof(
      rescanned.project,
      rescanned.findings,
      verification,
      args.selection,
      migrationRecords,
    );
    const proofPath = writeProof(args.root, proof);
    printReport(
      createScanReport(
        rescanned.project,
        rescanned.findings,
        verification,
        args.selection,
      ),
      "human",
    );
    process.stdout.write(`\nProof written to ${proofPath}\n`);
    if (
      rescanned.findings.some(
        (finding) =>
          finding.severity === "high" || finding.severity === "critical",
      ) ||
      verification.some((item) =>
        ["failed", "timed_out", "blocked"].includes(item.status),
      )
    )
      process.exitCode = 1;
    return;
  }
  throw new Error(`Unknown command: ${args.command}`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
});
