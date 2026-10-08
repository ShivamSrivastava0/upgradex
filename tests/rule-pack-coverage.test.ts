import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRepositoryInventory } from "../src/project-detector/repository-inventory.js";
import {
  loadRulePacks,
  runUpgradeRules,
  type UpgradeRule,
} from "../src/rules/rule-engine.js";

const temporaryRoots: string[] = [];
function sourceFor(rule: UpgradeRule): string {
  const detector = rule.detector;
  if (detector.type === "import-module")
    return `import value from '${detector.module}';\n`;
  if (detector.type === "member-access")
    return `const ${detector.receiver ?? "object"} = {};\n${detector.receiver ?? "object"}.${detector.member};\n`;
  if (detector.type === "route-path-pattern") {
    const route =
      detector.pattern === "unnamed-wildcard"
        ? "/*"
        : detector.pattern === "optional-marker"
          ? "/:file.:ext?"
          : "/[a|b]/:slug";
    const receiver = detector.receiver?.[0] ?? "app";
    return `const express = require('express');\nconst app = express();\nconst router = express.Router();\n${receiver}.get('${route}', handler);\n`;
  }
  const receiver = detector.receiver?.[0] ?? "object";
  const count = detector.argumentCount ?? (detector.firstArgument ? 1 : 1);
  const first =
    detector.firstArgument === "number"
      ? "200"
      : detector.firstArgument === "function"
        ? "() => {}"
        : detector.firstArgument === "array"
          ? "['id']"
          : detector.firstArgument === "identifier"
            ? "value"
            : detector.firstArgumentPrefix
              ? `'${detector.firstArgumentPrefix}id'`
              : "'value'";
  const args = Array.from({ length: count }, (_, index) =>
    index === 0 ? first : "value",
  ).join(", ");
  return `const express = require('express');\nconst app = express();\nconst router = express.Router();\nconst req = {}; const res = {}; const fs = {}; const dirent = {}; const stream = {}; const tls = {};\n${receiver}.${detector.member}(${args});\n`;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
  temporaryRoots.length = 0;
});

describe("built-in rule fixture coverage", () => {
  it("rejects unknown fields and hides unverified rules unless requested", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "upgradex-rule-schema-"),
    );
    temporaryRoots.push(directory);
    const rule = loadRulePacks(path.resolve(process.cwd(), "rules"))[0]!;
    await writeFile(
      path.join(directory, "unknown.yaml"),
      JSON.stringify([{ ...rule, extraField: true }]),
      "utf8",
    );
    expect(() => loadRulePacks(directory)).toThrow();
    await writeFile(
      path.join(directory, "unknown.yaml"),
      JSON.stringify([{ ...rule, verified: false }]),
      "utf8",
    );
    expect(loadRulePacks(directory)).toEqual([]);
    expect(loadRulePacks(directory, { includeUnverified: true })).toHaveLength(
      1,
    );
  });

  it("has positive, negative, and formatting edge coverage for every verified rule", async () => {
    const rules = loadRulePacks(path.resolve(process.cwd(), "rules"));
    expect(rules).toHaveLength(31);
    for (const rule of rules) {
      const root = await mkdtemp(path.join(os.tmpdir(), "upgradex-rule-"));
      temporaryRoots.push(root);
      const sourcePath = path.join(root, "src", "fixture.js");
      const source = sourceFor(rule);
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, source, "utf8");
      const inventory = buildRepositoryInventory(root);
      const version =
        rule.technology === "node"
          ? { current: "22", target: "24" }
          : { current: "4", target: "5" };
      const selection = { technology: rule.technology, ...version };
      expect(
        runUpgradeRules(inventory, [rule], selection),
        rule.id,
      ).toHaveLength(1);

      await writeFile(
        sourcePath,
        "const unrelated = { safe: true };\n",
        "utf8",
      );
      expect(
        runUpgradeRules(buildRepositoryInventory(root), [rule], selection),
        `${rule.id} negative`,
      ).toHaveLength(0);

      await writeFile(
        sourcePath,
        `// edge formatting\n\n${source.replaceAll(";", "; // trailing comment")}`,
        "utf8",
      );
      expect(
        runUpgradeRules(buildRepositoryInventory(root), [rule], selection),
        `${rule.id} edge`,
      ).toHaveLength(1);
    }
  });
});
