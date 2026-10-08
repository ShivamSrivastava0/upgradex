import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectLanguage } from "../src/project-detector/language-detector.js";
import { buildRepositoryInventory } from "../src/project-detector/repository-inventory.js";
import { readProjectTextFile } from "../src/safety/safe-file-reader.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

describe("safe project file reads", () => {
  it("rejects paths outside the root and oversized files", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "upgradex-safe-read-"));
    roots.push(root);
    writeFileSync(path.join(root, "small.txt"), "safe", "utf8");
    writeFileSync(path.join(root, "large.txt"), "12345", "utf8");

    expect(readProjectTextFile(root, "small.txt")).toEqual({
      ok: true,
      content: "safe",
    });
    expect(readProjectTextFile(root, "../outside.txt").warning).toMatch(
      /PATH_OUTSIDE_PROJECT/,
    );
    expect(readProjectTextFile(root, "large.txt", 4).warning).toMatch(
      /FILE_TOO_LARGE/,
    );
  });

  it("does not parse an oversized root manifest for language signals", () => {
    const root = mkdtempSync(
      path.join(os.tmpdir(), "upgradex-large-manifest-"),
    );
    roots.push(root);
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        devDependencies: { typescript: "^6.0.0" },
        padding: "x".repeat(300 * 1024),
      }),
      "utf8",
    );

    const language = detectLanguage(buildRepositoryInventory(root));
    expect(
      language.evidence.some((item) =>
        item.signal.includes("typescript dependency detected"),
      ),
    ).toBe(false);
  });

  it("does not follow an external package.json symlink during language detection", ({
    skip,
  }) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "upgradex-safe-link-"));
    roots.push(root);
    const projectRoot = path.join(root, "project");
    const externalManifest = path.join(root, "outside-package.json");
    mkdirSync(projectRoot);
    writeFileSync(
      externalManifest,
      JSON.stringify({ devDependencies: { typescript: "^6.0.0" } }),
      "utf8",
    );
    try {
      symlinkSync(externalManifest, path.join(projectRoot, "package.json"));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(code ?? ""))
        skip();
      throw error;
    }

    const inventory = buildRepositoryInventory(projectRoot);
    const language = detectLanguage(inventory);
    expect(
      language.evidence.some((item) =>
        item.signal.includes("typescript dependency detected"),
      ),
    ).toBe(false);
  });
});
