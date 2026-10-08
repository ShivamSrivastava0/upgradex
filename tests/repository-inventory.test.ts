import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildRepositoryInventory } from "../src/project-detector/repository-inventory.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );

  temporaryDirectories.length = 0;
});

async function createFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "upgradex-inventory-"));

  temporaryDirectories.push(directory);

  return directory;
}

describe("buildRepositoryInventory", () => {
  it("recursively inventories source files", async () => {
    const root = await createFixture();

    await mkdir(join(root, "src", "nested"), {
      recursive: true,
    });

    await writeFile(
      join(root, "src", "index.ts"),
      "export const value = 1;",
      "utf8",
    );

    await writeFile(
      join(root, "src", "nested", "helper.js"),
      "export const helper = true;",
      "utf8",
    );

    const inventory = buildRepositoryInventory(root);

    expect(inventory.sourceFileCount).toBe(2);
    expect(inventory.extensions[".ts"]).toBe(1);
    expect(inventory.extensions[".js"]).toBe(1);
  });

  it("skips ignored directories", async () => {
    const root = await createFixture();

    await mkdir(join(root, "node_modules"), {
      recursive: true,
    });

    await writeFile(
      join(root, "node_modules", "fake.ts"),
      "export const fake = true;",
      "utf8",
    );

    const inventory = buildRepositoryInventory(root);

    expect(inventory.sourceFileCount).toBe(0);
  });

  it("ignores Python virtual environments without hiding project source", async () => {
    const root = await createFixture();
    const environment = join(
      root,
      "ml-service",
      "venv",
      "Lib",
      "site-packages",
      "shap",
      "plots",
      "resources",
    );
    await mkdir(environment, { recursive: true });
    await writeFile(join(root, "src.js"), "export const app = true;", "utf8");
    await writeFile(
      join(environment, "bundle.js"),
      "export const generatedVendorBundle = true;",
      "utf8",
    );

    const inventory = buildRepositoryInventory(root);

    expect(inventory.files.map((file) => file.relativePath)).toEqual([
      "src.js",
    ]);
    expect(inventory.warnings).toEqual([]);
  });

  it("detects sensitive files without reading their contents", async () => {
    const root = await createFixture();

    await writeFile(join(root, ".env"), "SUPER_SECRET=do-not-read", "utf8");

    const inventory = buildRepositoryInventory(root);

    expect(inventory.sensitiveFileCount).toBe(1);

    expect(
      inventory.warnings.some((warning) => warning.code === "SENSITIVE_FILE"),
    ).toBe(true);
  });

  it("enforces the per-file size limit", async () => {
    const root = await createFixture();

    await writeFile(join(root, "huge.ts"), "x".repeat(100), "utf8");

    const inventory = buildRepositoryInventory(root, {
      limits: {
        maxFileSizeBytes: 50,
      },
    });

    expect(inventory.sourceFileCount).toBe(0);

    expect(
      inventory.warnings.some((warning) => warning.code === "FILE_TOO_LARGE"),
    ).toBe(true);
  });

  it("enforces the file count limit", async () => {
    const root = await createFixture();

    await writeFile(join(root, "one.ts"), "export const one = 1;", "utf8");

    await writeFile(join(root, "two.ts"), "export const two = 2;", "utf8");

    const inventory = buildRepositoryInventory(root, {
      limits: {
        maxFileCount: 1,
      },
    });

    expect(inventory.files.length).toBe(1);

    expect(
      inventory.warnings.some(
        (warning) => warning.code === "FILE_LIMIT_REACHED",
      ),
    ).toBe(true);
  });
});
