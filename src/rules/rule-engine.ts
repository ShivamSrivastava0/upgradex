import fs from "node:fs";
import path from "node:path";
import semver from "semver";
import { parse } from "yaml";
import { z } from "zod";
import { Node, Project, SyntaxKind } from "ts-morph";
import type { RepositoryInventory } from "../project-detector/types.js";
import { readProjectTextFile } from "../safety/safe-file-reader.js";

const detectorSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("call-member"),
      member: z.string().min(1),
      receiver: z.array(z.string()).optional(),
      receiverKind: z
        .enum(["express-app", "express-router", "express-route"])
        .optional(),
      argumentCount: z.number().int().nonnegative().optional(),
      firstArgument: z
        .enum(["number", "function", "string", "array", "identifier"])
        .optional(),
      firstArgumentPrefix: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("member-access"),
      member: z.string().min(1),
      receiver: z.string().optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("import-module"), module: z.string().min(1) })
    .strict(),
  z
    .object({
      type: z.literal("route-path-pattern"),
      pattern: z.enum([
        "unnamed-wildcard",
        "optional-marker",
        "regexp-character",
      ]),
      receiver: z.array(z.string()).optional(),
      receiverKind: z
        .enum(["express-app", "express-router", "express-route"])
        .optional(),
    })
    .strict(),
]);
const ruleSchema = z
  .object({
    id: z.string().regex(/^[A-Z0-9]+-[A-Z0-9-]+$/),
    title: z.string().min(1),
    technology: z.enum(["node", "express"]),
    from: z.string().min(1),
    to: z.string().min(1),
    severity: z.enum(["low", "medium", "high", "critical"]),
    detector: detectorSchema,
    why: z.string().min(1),
    guidance: z.string().min(1),
    codemod: z.string().optional(),
    source: z.string().url(),
    verified: z.boolean(),
  })
  .strict();

export type UpgradeRule = z.infer<typeof ruleSchema>;
export interface RuleFinding {
  id: string;
  ruleId: string;
  technology: "node" | "express";
  severity: UpgradeRule["severity"];
  title: string;
  message: string;
  location: { file: string; line: number; column: number };
  symbol?: string;
  evidence: {
    tier: "DETECTED";
    resolution: "resolved" | "heuristic";
    detector: string;
  };
  guidance: string;
  codemod?: string;
  references: string[];
}

export function loadRulePacks(
  directory: string,
  options: { includeUnverified?: boolean } = {},
): UpgradeRule[] {
  const files = fs
    .readdirSync(directory)
    .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
    .sort();
  const rules: UpgradeRule[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const parsed: unknown = parse(
      fs.readFileSync(path.join(directory, file), "utf8"),
    );
    const rows = z.array(ruleSchema).parse(parsed);
    for (const rule of rows) {
      if (seen.has(rule.id)) throw new Error(`Duplicate rule id: ${rule.id}`);
      seen.add(rule.id);
      if (rule.verified || options.includeUnverified) rules.push(rule);
    }
  }
  return rules;
}

function applies(rule: UpgradeRule, current: string, target: string): boolean {
  const from = semver.validRange(rule.from);
  const to = semver.validRange(rule.to);
  const currentVersion =
    semver.valid(current) ??
    (/^\d+$/.test(current) ? semver.valid(`${current}.0.0`) : undefined);
  const targetVersion =
    semver.valid(target) ??
    (/^\d+$/.test(target) ? semver.valid(`${target}.0.0`) : undefined);
  return Boolean(
    from &&
    to &&
    currentVersion &&
    targetVersion &&
    semver.satisfies(currentVersion, from) &&
    semver.satisfies(targetVersion, to),
  );
}

export function getApplicableUpgradeRules(
  rules: UpgradeRule[],
  selection: {
    technology: UpgradeRule["technology"];
    current: string;
    target: string;
  },
): UpgradeRule[] {
  return rules.filter(
    (rule) =>
      rule.technology === selection.technology &&
      applies(rule, selection.current, selection.target),
  );
}

export function runUpgradeRules(
  inventory: RepositoryInventory,
  rules: UpgradeRule[],
  selection: {
    technology: UpgradeRule["technology"];
    current: string;
    target: string;
  },
): RuleFinding[] {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true, checkJs: false, target: 99 },
  });
  const applicable = getApplicableUpgradeRules(rules, selection);
  const findings: RuleFinding[] = [];
  for (const file of inventory.files) {
    if (file.category !== "source" && file.category !== "test") continue;
    if (!/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file.relativePath)) continue;
    const read = readProjectTextFile(inventory.root, file.relativePath);
    if (!read.ok || read.content === undefined) continue;
    let source;
    try {
      source = project.createSourceFile(
        path.resolve(inventory.root, file.relativePath),
        read.content,
        { overwrite: true },
      );
    } catch {
      continue;
    }
    const calls = source.getDescendantsOfKind(SyntaxKind.CallExpression);
    const callsByMember = new Map<string, typeof calls>();
    const accessesByMember = new Map<
      string,
      ReturnType<
        typeof source.getDescendantsOfKind<
          typeof SyntaxKind.PropertyAccessExpression
        >
      >
    >();
    const importsByModule = new Map<
      string,
      ReturnType<typeof source.getImportDeclarations>
    >();
    const routeMethods = new Set([
      "get",
      "post",
      "put",
      "patch",
      "delete",
      "all",
      "use",
      "route",
    ]);
    const routeCalls: typeof calls = [];
    for (const call of calls) {
      const expression = call.getExpression();
      if (!Node.isPropertyAccessExpression(expression)) continue;
      const member = expression.getName();
      const matchingCalls = callsByMember.get(member) ?? [];
      matchingCalls.push(call);
      callsByMember.set(member, matchingCalls);
      const first = call.getArguments()[0];
      if (routeMethods.has(member) && first && Node.isStringLiteral(first))
        routeCalls.push(call);
    }
    const propertyAccesses = source.getDescendantsOfKind(
      SyntaxKind.PropertyAccessExpression,
    );
    for (const access of propertyAccesses) {
      const matchingAccesses = accessesByMember.get(access.getName()) ?? [];
      matchingAccesses.push(access);
      accessesByMember.set(access.getName(), matchingAccesses);
    }
    const importDeclarations = source.getImportDeclarations();
    for (const declaration of importDeclarations) {
      const module = declaration.getModuleSpecifierValue();
      const matchingImports = importsByModule.get(module) ?? [];
      matchingImports.push(declaration);
      importsByModule.set(module, matchingImports);
    }
    const expressFactories = new Set<string>();
    for (const declaration of importDeclarations) {
      if (
        declaration.getModuleSpecifierValue() === "express" &&
        declaration.getDefaultImport()
      )
        expressFactories.add(declaration.getDefaultImport()!.getText());
    }
    const expressApps = new Set<string>();
    const expressRouters = new Set<string>();
    const expressAppDeclarations = new Set<Node>();
    const expressRouterDeclarations = new Set<Node>();
    for (const declaration of source.getDescendantsOfKind(
      SyntaxKind.VariableDeclaration,
    )) {
      const initializer = declaration.getInitializer();
      if (!initializer || !Node.isCallExpression(initializer)) continue;
      const expression = initializer.getExpression().getText();
      const firstArgument = initializer.getArguments()[0];
      if (
        expression === "require" &&
        firstArgument &&
        Node.isStringLiteral(firstArgument) &&
        firstArgument.getLiteralValue() === "express"
      )
        expressFactories.add(declaration.getName());
      if (expressFactories.has(expression)) {
        expressApps.add(declaration.getName());
        expressAppDeclarations.add(declaration);
      }
      if (
        [...expressFactories].some(
          (factory) => expression === `${factory}.Router`,
        )
      ) {
        expressRouters.add(declaration.getName());
        expressRouterDeclarations.add(declaration);
      }
    }
    const receiverIsExpressApp = (receiverNode: Node): boolean =>
      receiverNode
        .getSymbol()
        ?.getDeclarations()
        .some((declaration) => expressAppDeclarations.has(declaration)) ??
      false;
    const receiverIsExpressRouter = (receiverNode: Node): boolean =>
      receiverNode
        .getSymbol()
        ?.getDeclarations()
        .some((declaration) => expressRouterDeclarations.has(declaration)) ??
      false;
    for (const rule of applicable) {
      const candidates: Array<{
        node: Node;
        symbol?: string;
        resolution: "resolved" | "heuristic";
      }> = [];
      if (rule.detector.type === "call-member") {
        for (const call of callsByMember.get(rule.detector.member) ?? []) {
          const expression = call.getExpression();
          if (!Node.isPropertyAccessExpression(expression)) continue;
          const receiver = expression.getExpression().getText();
          if (
            rule.detector.receiver &&
            !rule.detector.receiver.includes(receiver)
          )
            continue;
          if (
            rule.detector.receiverKind === "express-app" &&
            !receiverIsExpressApp(expression.getExpression())
          )
            continue;
          if (
            rule.detector.receiverKind === "express-router" &&
            !receiverIsExpressRouter(expression.getExpression())
          )
            continue;
          if (
            rule.detector.receiverKind === "express-route" &&
            !receiverIsExpressApp(expression.getExpression()) &&
            !receiverIsExpressRouter(expression.getExpression())
          )
            continue;
          const args = call.getArguments();
          if (
            rule.detector.argumentCount !== undefined &&
            args.length !== rule.detector.argumentCount
          )
            continue;
          const first = args[0];
          if (
            rule.detector.firstArgument === "number" &&
            (!first || !Node.isNumericLiteral(first))
          )
            continue;
          if (
            rule.detector.firstArgument === "function" &&
            (!first ||
              (!Node.isArrowFunction(first) &&
                !Node.isFunctionExpression(first)))
          )
            continue;
          if (
            rule.detector.firstArgument === "string" &&
            (!first || !Node.isStringLiteral(first))
          )
            continue;
          if (
            rule.detector.firstArgument === "array" &&
            (!first || !Node.isArrayLiteralExpression(first))
          )
            continue;
          if (
            rule.detector.firstArgument === "identifier" &&
            (!first || !Node.isIdentifier(first))
          )
            continue;
          if (
            rule.detector.firstArgumentPrefix &&
            (!first ||
              !Node.isStringLiteral(first) ||
              !first
                .getLiteralValue()
                .startsWith(rule.detector.firstArgumentPrefix))
          )
            continue;
          candidates.push({
            node: call,
            symbol: receiver,
            resolution: rule.detector.receiverKind
              ? "resolved"
              : rule.detector.receiver
                ? "heuristic"
                : "resolved",
          });
        }
      } else if (rule.detector.type === "member-access") {
        for (const access of accessesByMember.get(rule.detector.member) ?? []) {
          const receiver = access.getExpression().getText();
          if (rule.detector.receiver && receiver !== rule.detector.receiver)
            continue;
          candidates.push({
            node: access,
            symbol: receiver,
            resolution: "heuristic",
          });
        }
      } else if (rule.detector.type === "import-module") {
        for (const declaration of importsByModule.get(rule.detector.module) ??
          [])
          candidates.push({ node: declaration, resolution: "resolved" });
      } else {
        for (const call of routeCalls) {
          const expression = call.getExpression();
          const first = call.getArguments()[0];
          if (
            !Node.isPropertyAccessExpression(expression) ||
            !first ||
            !Node.isStringLiteral(first)
          )
            continue;
          const receiver = expression.getExpression().getText();
          if (
            rule.detector.receiver &&
            !rule.detector.receiver.includes(receiver)
          )
            continue;
          const route = first.getLiteralValue();
          const matched =
            rule.detector.pattern === "unnamed-wildcard"
              ? /(?:^|\/)\*(?:\/|$)/.test(route)
              : rule.detector.pattern === "optional-marker"
                ? /:[A-Za-z_$][\w$]*(?:\.[^/]+)?\?/.test(route)
                : /[()[\]]/.test(route);
          if (matched)
            candidates.push({
              node: call,
              symbol: receiver,
              resolution: "heuristic",
            });
        }
      }
      for (const candidate of candidates) {
        const loc = source.getLineAndColumnAtPos(candidate.node.getStart());
        const finding: RuleFinding = {
          id: `${rule.id}:${file.relativePath}:${loc.line}:${loc.column}`,
          ruleId: rule.id,
          technology: rule.technology,
          severity: rule.severity,
          title: rule.title,
          message: rule.why,
          location: {
            file: file.relativePath.replaceAll("\\", "/"),
            line: loc.line,
            column: loc.column,
          },
          evidence: {
            tier: "DETECTED",
            resolution: candidate.resolution,
            detector: rule.detector.type,
          },
          guidance: rule.guidance,
          references: [rule.source],
        };
        if (candidate.symbol) finding.symbol = candidate.symbol;
        if (rule.codemod) finding.codemod = rule.codemod;
        findings.push(finding);
      }
    }
  }
  return findings.sort((a, b) =>
    `${a.location.file}:${a.location.line}:${a.ruleId}`.localeCompare(
      `${b.location.file}:${b.location.line}:${b.ruleId}`,
    ),
  );
}
