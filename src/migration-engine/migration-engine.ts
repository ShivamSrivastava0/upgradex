import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Node, Project, SyntaxKind } from "ts-morph";
import type { RepositoryInventory } from "../project-detector/types.js";
import type { RuleFinding } from "../rules/rule-engine.js";
import { readProjectTextFile } from "../safety/safe-file-reader.js";
import { buildRepositoryInventory } from "../project-detector/repository-inventory.js";
import { analyzeRepository } from "../analyzer/change-graph.js";

export interface FileMigration {
  file: string;
  original: string;
  updated: string;
  diff: string;
  ruleIds: string[];
  idempotent: true;
}
export interface MigrationPreview {
  id: string;
  files: FileMigration[];
  manual: Array<{
    ruleId: string;
    file: string;
    line: number;
    guidance: string;
  }>;
}
export interface MigrationApplyResult {
  applied: string[];
  backupDirectory?: string;
  blocked?: string;
  rescanned: boolean;
}

type SupportedCodemod =
  | "express-del-to-delete"
  | "express-sendfile-to-sendFile"
  | "node-fs-constants"
  | "node-dirent-path-to-parentPath";

function codemodFor(ruleId: string): SupportedCodemod | undefined {
  if (ruleId === "EXP5-001") return "express-del-to-delete";
  if (ruleId === "EXP5-003") return "express-sendfile-to-sendFile";
  if (["NODE24-002", "NODE24-003", "NODE24-004", "NODE24-005"].includes(ruleId))
    return "node-fs-constants";
  if (ruleId === "NODE24-006") return "node-dirent-path-to-parentPath";
  return undefined;
}

export function transformSource(
  sourceText: string,
  codemods: string[],
  findings: RuleFinding[] = [],
): string {
  const enabled = new Set(codemods);
  if (enabled.size === 0) return sourceText;
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
  });
  const source = project.createSourceFile("migration.ts", sourceText, {
    overwrite: true,
  });
  const locations = new Set(
    findings.map(
      (finding) =>
        `${finding.location.line}:${finding.location.column}:${codemodFor(finding.ruleId)}`,
    ),
  );
  for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression();
    if (!Node.isPropertyAccessExpression(expression)) continue;
    const receiver = expression.getExpression().getText();
    const loc = source.getLineAndColumnAtPos(call.getStart());
    if (
      expression.getName() === "del" &&
      receiver === "app" &&
      enabled.has("express-del-to-delete") &&
      (!findings.length ||
        locations.has(`${loc.line}:${loc.column}:express-del-to-delete`))
    )
      expression.getNameNode().replaceWithText("delete");
    if (
      expression.getName() === "sendfile" &&
      receiver === "res" &&
      enabled.has("express-sendfile-to-sendFile") &&
      (!findings.length ||
        locations.has(`${loc.line}:${loc.column}:express-sendfile-to-sendFile`))
    )
      expression.getNameNode().replaceWithText("sendFile");
  }
  for (const access of source.getDescendantsOfKind(
    SyntaxKind.PropertyAccessExpression,
  )) {
    const loc = source.getLineAndColumnAtPos(access.getStart());
    const member = access.getName();
    const receiver = access.getExpression().getText();
    if (
      receiver === "fs" &&
      ["F_OK", "R_OK", "W_OK", "X_OK"].includes(member) &&
      enabled.has("node-fs-constants") &&
      (!findings.length ||
        locations.has(`${loc.line}:${loc.column}:node-fs-constants`))
    )
      access.replaceWithText(`${receiver}.constants.${member}`);
    if (
      receiver === "dirent" &&
      member === "path" &&
      enabled.has("node-dirent-path-to-parentPath") &&
      (!findings.length ||
        locations.has(
          `${loc.line}:${loc.column}:node-dirent-path-to-parentPath`,
        ))
    )
      access.getNameNode().replaceWithText("parentPath");
  }
  return source.getFullText();
}

function createDiff(file: string, before: string, after: string): string {
  const oldLines = before.split(/\r?\n/);
  const newLines = after.split(/\r?\n/);
  const output = [`--- a/${file}`, `+++ b/${file}`];
  for (
    let index = 0;
    index < Math.max(oldLines.length, newLines.length);
    index += 1
  ) {
    if (oldLines[index] !== newLines[index]) {
      if (oldLines[index] !== undefined) output.push(`-${oldLines[index]}`);
      if (newLines[index] !== undefined) output.push(`+${newLines[index]}`);
    }
  }
  return output.join("\n");
}

export function createMigrationPreview(
  inventory: RepositoryInventory,
  findings: RuleFinding[],
): MigrationPreview {
  const grouped = new Map<string, RuleFinding[]>();
  const manual: MigrationPreview["manual"] = [];
  for (const finding of findings) {
    if (!finding.codemod || !codemodFor(finding.ruleId)) {
      manual.push({
        ruleId: finding.ruleId,
        file: finding.location.file,
        line: finding.location.line,
        guidance: finding.guidance,
      });
      continue;
    }
    const rows = grouped.get(finding.location.file) ?? [];
    rows.push(finding);
    grouped.set(finding.location.file, rows);
  }
  const files: FileMigration[] = [];
  for (const [file, rows] of [...grouped.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const read = readProjectTextFile(inventory.root, file);
    if (!read.ok || read.content === undefined) {
      manual.push({
        ruleId: rows[0]?.ruleId ?? "UNKNOWN",
        file,
        line: rows[0]?.location.line ?? 1,
        guidance: `Automatic migration skipped because the file could not be read safely: ${read.warning ?? "read failed"}`,
      });
      continue;
    }
    const applicableRows = rows.filter((finding) => {
      const codemod = codemodFor(finding.ruleId);
      return Boolean(
        codemod &&
        transformSource(read.content!, [codemod], [finding]) !== read.content,
      );
    });
    const applicableFindingSet = new Set(applicableRows);
    for (const finding of rows.filter((row) => !applicableFindingSet.has(row)))
      manual.push({
        ruleId: finding.ruleId,
        file,
        line: finding.location.line,
        guidance:
          "No deterministic edit matched this exact finding location; review the finding and apply the change manually.",
      });
    if (applicableRows.length === 0) continue;
    const codemods = [
      ...new Set(
        applicableRows
          .map((finding) => codemodFor(finding.ruleId))
          .filter((item): item is SupportedCodemod => Boolean(item)),
      ),
    ];
    const updated = transformSource(read.content, codemods, applicableRows);
    if (updated === read.content) {
      for (const finding of applicableRows)
        manual.push({
          ruleId: finding.ruleId,
          file,
          line: finding.location.line,
          guidance:
            "No deterministic edit matched this exact finding location; review the finding and apply the change manually.",
        });
      continue;
    }
    files.push({
      file,
      original: read.content,
      updated,
      diff: createDiff(file, read.content, updated),
      ruleIds: [...new Set(applicableRows.map((row) => row.ruleId))].sort(),
      idempotent: true,
    });
  }
  return {
    id: `migration-${Date.now().toString(36)}-${randomUUID()}`,
    files,
    manual: manual.sort((a, b) =>
      `${a.file}:${a.line}:${a.ruleId}`.localeCompare(
        `${b.file}:${b.line}:${b.ruleId}`,
      ),
    ),
  };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function hasSafeExistingPath(root: string, relativeFile: string): boolean {
  let current = root;
  for (const part of relativeFile.split(/[\\/]/).filter(Boolean)) {
    current = path.join(current, part);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(current);
    } catch {
      return false;
    }
    if (stats.isSymbolicLink()) return false;
    let real: string;
    try {
      real = fs.realpathSync(current);
    } catch {
      return false;
    }
    if (!isInside(root, real)) return false;
  }
  return true;
}

function ensurePrivateDirectory(
  root: string,
  relativeDirectory: string,
): string {
  let current = root;
  for (const part of relativeDirectory.split(/[\\/]/).filter(Boolean)) {
    current = path.join(current, part);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (!(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error;
    }
    const stats = fs.lstatSync(current);
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      !isInside(root, fs.realpathSync(current))
    )
      throw new Error(`Unsafe backup path: ${relativeDirectory}`);
  }
  return current;
}

function atomicWrite(filePath: string, content: string): void {
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.upgradex-${process.pid}-${randomUUID()}.tmp`,
  );
  const mode = fs.statSync(filePath).mode & 0o777;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", mode);
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, filePath);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the write error while still attempting temp-file cleanup.
      }
    }
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export function applyMigrationPreview(
  projectRoot: string,
  preview: MigrationPreview,
  options: { approved: boolean; allowDirty?: boolean },
): MigrationApplyResult {
  if (!options.approved)
    return {
      applied: [],
      blocked: "Explicit approval is required before any file is changed.",
      rescanned: false,
    };
  if (preview.files.length === 0)
    return {
      applied: [],
      blocked: "The preview contains no automatic changes.",
      rescanned: false,
    };
  const root = fs.realpathSync(path.resolve(projectRoot));
  const filePaths = preview.files.map((file) => path.resolve(root, file.file));
  if (filePaths.some((file) => !isInside(root, file)))
    return {
      applied: [],
      blocked: "A preview path is outside the project root.",
      rescanned: false,
    };
  try {
    const dirty = execFileSync(
      "git",
      [
        "status",
        "--porcelain",
        "--",
        ...preview.files.map((file) => file.file),
      ],
      {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    if (dirty && !options.allowDirty)
      return {
        applied: [],
        blocked:
          "Affected files have uncommitted changes. Commit/stash them or explicitly allow dirty files.",
        rescanned: false,
      };
  } catch {
    if (!options.allowDirty)
      return {
        applied: [],
        blocked:
          "Git state could not be checked; set allowDirty only after reviewing the affected files.",
        rescanned: false,
      };
  }
  for (const file of preview.files) {
    const target = path.resolve(root, file.file);
    if (
      !isInside(root, target) ||
      !hasSafeExistingPath(root, file.file) ||
      !fs.lstatSync(target).isFile()
    )
      return {
        applied: [],
        blocked: `Unsafe migration target: ${file.file}`,
        rescanned: false,
      };
    const current = fs.readFileSync(target, "utf8");
    if (current !== file.original)
      return {
        applied: [],
        blocked: `File changed after preview: ${file.file}. Regenerate the preview.`,
        rescanned: false,
      };
  }
  let backupDirectory: string;
  try {
    backupDirectory = ensurePrivateDirectory(
      root,
      path.join(".upgradex", "backup", preview.id),
    );
  } catch (error) {
    return {
      applied: [],
      blocked:
        error instanceof Error
          ? error.message
          : "Unable to create a safe backup directory.",
      rescanned: false,
    };
  }
  try {
    for (const file of preview.files) {
      const backup = path.join(backupDirectory, file.file);
      ensurePrivateDirectory(root, path.relative(root, path.dirname(backup)));
      fs.writeFileSync(backup, file.original, { flag: "wx", mode: 0o600 });
    }
  } catch (error) {
    return {
      applied: [],
      backupDirectory,
      blocked: `Backup could not be completed; no project files were changed: ${error instanceof Error ? error.message : String(error)}`,
      rescanned: false,
    };
  }
  const applied: string[] = [];
  try {
    for (const file of preview.files) {
      atomicWrite(path.resolve(root, file.file), file.updated);
      applied.push(file.file);
    }
  } catch (error) {
    for (const file of preview.files
      .filter((item) => applied.includes(item.file))
      .reverse())
      atomicWrite(path.resolve(root, file.file), file.original);
    return {
      applied: [],
      backupDirectory,
      blocked: `Write failed; previously changed files were restored: ${error instanceof Error ? error.message : String(error)}`,
      rescanned: false,
    };
  }
  try {
    const rescannedInventory = buildRepositoryInventory(root);
    analyzeRepository(rescannedInventory);
  } catch (error) {
    for (const file of preview.files.slice().reverse())
      atomicWrite(path.resolve(root, file.file), file.original);
    return {
      applied: [],
      backupDirectory,
      blocked: `Rescan failed; changed files were restored: ${error instanceof Error ? error.message : String(error)}`,
      rescanned: false,
    };
  }
  return { applied, backupDirectory, rescanned: true };
}
