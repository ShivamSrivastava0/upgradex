import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRepositoryInventory } from "../src/project-detector/repository-inventory.js";
import { loadRulePacks, runUpgradeRules } from "../src/rules/rule-engine.js";
import {
  applyMigrationPreview,
  createMigrationPreview,
} from "../src/migration-engine/migration-engine.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.length = 0;
});

describe("migration engine", () => {
  it("backs up, atomically applies, and rescans an approved change", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "upgradex-migration-"));
    roots.push(root);
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "migration-fixture",
        dependencies: { express: "^4.21.2" },
      }),
      "utf8",
    );
    const sourcePath = path.join(root, "src", "app.js");
    const original =
      "const express = require('express');\nconst app = express();\napp.del('/legacy', handler);\n";
    await writeFile(sourcePath, original, "utf8");
    const originalMode = (await stat(sourcePath)).mode & 0o777;
    const inventory = buildRepositoryInventory(root);
    const rules = loadRulePacks(path.resolve(process.cwd(), "rules"));
    const findings = runUpgradeRules(inventory, rules, {
      technology: "express",
      current: "4.21.2",
      target: "5.0.0",
    });
    const preview = createMigrationPreview(inventory, findings);
    const unsafePreview = {
      ...preview,
      files: preview.files.map((file) => ({ ...file, file: "../outside.js" })),
    };
    expect(
      applyMigrationPreview(root, unsafePreview, {
        approved: true,
        allowDirty: true,
      }).blocked,
    ).toMatch(/outside the project root/i);
    expect(await readFile(sourcePath, "utf8")).toBe(original);
    expect(
      applyMigrationPreview(root, preview, { approved: true }).blocked,
    ).toMatch(/git state/i);

    const result = applyMigrationPreview(root, preview, {
      approved: true,
      allowDirty: true,
    });
    expect(result.applied).toEqual(["src/app.js"]);
    expect(result.rescanned).toBe(true);
    expect(await readFile(sourcePath, "utf8")).toContain("app.delete(");
    expect((await stat(sourcePath)).mode & 0o777).toBe(originalMode);
    expect(
      (await readdir(path.dirname(sourcePath))).some((name) =>
        name.endsWith(".tmp"),
      ),
    ).toBe(false);
    expect(
      await readFile(
        path.join(result.backupDirectory!, "src", "app.js"),
        "utf8",
      ),
    ).toBe(original);
    const rescanned = buildRepositoryInventory(root);
    expect(
      runUpgradeRules(rescanned, rules, {
        technology: "express",
        current: "4.21.2",
        target: "5.0.0",
      }).some((finding) => finding.ruleId === "EXP5-001"),
    ).toBe(false);
  });

  it("previews Node compatibility codemods without changing the source file", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "upgradex-node-migration-"),
    );
    roots.push(root);
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "node-migration-fixture" }),
      "utf8",
    );
    const sourcePath = path.join(root, "src", "legacy.js");
    const original =
      "const fs = require('node:fs');\nfs.access('file.txt', fs.F_OK);\nconsole.log(dirent.path);\n";
    await writeFile(sourcePath, original, "utf8");
    const inventory = buildRepositoryInventory(root);
    const rules = loadRulePacks(path.resolve(process.cwd(), "rules"));
    const findings = runUpgradeRules(inventory, rules, {
      technology: "node",
      current: "22",
      target: "24",
    });
    const preview = createMigrationPreview(inventory, findings);
    expect(preview.files[0]?.updated).toContain("fs.constants.F_OK");
    expect(preview.files[0]?.updated).toContain("dirent.parentPath");
    expect(await readFile(sourcePath, "utf8")).toBe(original);
  });
});
