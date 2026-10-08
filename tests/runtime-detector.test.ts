import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildRepositoryInventory } from "../src/project-detector/repository-inventory.js";
import { readPackageManifests } from "../src/project-detector/manifest-reader.js";
import { detectRuntime } from "../src/project-detector/runtime-detector.js";

describe("Runtime Intelligence", () => {
  const fixtureRoot = path.resolve(process.cwd(), "fixtures", "runtime-node");

  const conflictFixtureRoot = path.resolve(
    process.cwd(),
    "fixtures",
    "runtime-node-conflict",
  );

  function detect(root = fixtureRoot) {
    const inventory = buildRepositoryInventory(root);

    const manifestResult = readPackageManifests(inventory);

    const runtime = detectRuntime(
      root,
      inventory,
      manifestResult.rootManifest?.data,
    );

    return {
      inventory,
      manifestResult,
      runtime,
    };
  }

  it("detects Node runtime surfaces", () => {
    const { runtime } = detect();

    expect(runtime.runtime).toBe("node");

    expect(runtime.surfaces.length).toBeGreaterThanOrEqual(7);
  });

  it("detects all Node.js Docker stages", () => {
    const { runtime } = detect();

    const dockerSurfaces = runtime.surfaces.filter(
      (surface) => surface.source === "dockerfile",
    );

    expect(dockerSurfaces.length).toBeGreaterThanOrEqual(2);
  });

  it("normalizes Docker distribution tags for semantic consistency", () => {
    const { runtime } = detect();
    const dockerSurface = runtime.surfaces.find(
      (surface) => surface.source === "dockerfile",
    );
    expect(dockerSurface?.constraints[0]?.raw).toBe("22-alpine");
    expect(dockerSurface?.constraints[0]?.normalized).toBe("22");
    expect(runtime.consistency.status).toBe("consistent");
  });

  it("accepts a matrix containing the primary runtime", () => {
    const { runtime } = detect();

    const matrixSurface = runtime.surfaces.find(
      (surface) =>
        surface.source === "github-actions" && surface.constraints.length > 1,
    );

    expect(matrixSurface).toBeDefined();

    expect(
      matrixSurface?.constraints.some(
        (constraint) => constraint.normalized === "22",
      ),
    ).toBe(true);
  });

  it("accepts a second matrix-compatible declaration", () => {
    const { runtime } = detect();

    const githubSurfaces = runtime.surfaces.filter(
      (surface) => surface.source === "github-actions",
    );

    expect(githubSurfaces.length).toBeGreaterThanOrEqual(1);

    const hasUsableConstraint = githubSurfaces.some((surface) =>
      surface.constraints.some((constraint) => constraint.normalized),
    );

    expect(hasUsableConstraint).toBe(true);
  });

  it("detects Node.js versions from GitHub Actions matrices", () => {
    const { runtime } = detect();

    const matrixSurface = runtime.surfaces.find(
      (surface) =>
        surface.source === "github-actions" && surface.constraints.length > 1,
    );

    expect(matrixSurface).toBeDefined();

    expect(
      matrixSurface?.constraints.map((constraint) => constraint.normalized),
    ).toEqual(expect.arrayContaining(["20", "22", "24"]));
  });

  it("detects .nvmrc", () => {
    const { runtime } = detect();

    expect(
      runtime.surfaces.some(
        (surface) =>
          surface.source === "nvmrc" && surface.constraints[0]?.raw === "22",
      ),
    ).toBe(true);
  });

  it("detects .node-version", () => {
    const { runtime } = detect();

    expect(
      runtime.surfaces.some(
        (surface) =>
          surface.source === "node-version" &&
          surface.constraints[0]?.raw === "22.14.0",
      ),
    ).toBe(true);
  });

  it("detects .tool-versions", () => {
    const { runtime } = detect();

    expect(
      runtime.surfaces.some(
        (surface) =>
          surface.source === "tool-versions" &&
          surface.constraints[0]?.raw === "22.14.0",
      ),
    ).toBe(true);
  });

  it("detects package engines.node", () => {
    const { runtime } = detect();

    expect(
      runtime.surfaces.some(
        (surface) =>
          surface.source === "package-engines" &&
          surface.constraints[0]?.raw === ">=22",
      ),
    ).toBe(true);
  });

  it("detects Docker Node version", () => {
    const { runtime } = detect();

    expect(
      runtime.surfaces.some(
        (surface) =>
          surface.source === "dockerfile" &&
          surface.constraints.some(
            (constraint) => constraint.raw === "22-alpine",
          ),
      ),
    ).toBe(true);
  });

  it("detects Docker Compose Node version", () => {
    const { runtime } = detect();

    expect(
      runtime.surfaces.some(
        (surface) =>
          surface.source === "docker-compose" &&
          surface.constraints.some((constraint) => constraint.raw === "22"),
      ),
    ).toBe(true);
  });

  it("detects GitHub Actions Node version", () => {
    const { runtime } = detect();

    expect(
      runtime.surfaces.some(
        (surface) =>
          surface.source === "github-actions" &&
          surface.constraints.some((constraint) => constraint.raw === "22"),
      ),
    ).toBe(true);
  });

  it("detects @types/node compatibility", () => {
    const { runtime } = detect();

    expect(
      runtime.compatibilitySignals.some(
        (signal) =>
          signal.kind === "node-types" && signal.packageName === "@types/node",
      ),
    ).toBe(true);
  });

  it("detects native-module signals", () => {
    const { runtime } = detect();

    expect(
      runtime.compatibilitySignals.some(
        (signal) =>
          signal.kind === "native-module" &&
          signal.packageName === "node-gyp-build",
      ),
    ).toBe(true);
  });

  it("marks consistent runtime declarations", () => {
    const { runtime } = detect();

    expect(runtime.consistency.status).toBe("consistent");
  });

  it("detects conflicting runtime declarations", () => {
    const { runtime } = detect(conflictFixtureRoot);

    expect(runtime.consistency.status).toBe("conflicting");

    expect(runtime.consistency.conflicts.length).toBeGreaterThan(0);

    expect(
      runtime.warnings.some((warning) =>
        warning.toLowerCase().includes("inconsistent"),
      ),
    ).toBe(true);
  });

  it("records exact runtime surface locations", () => {
    const { runtime } = detect();

    const nvmrc = runtime.surfaces.find(
      (surface) => surface.source === "nvmrc",
    );

    expect(nvmrc?.location.relativePath).toBe(".nvmrc");

    expect(nvmrc?.location.line).toBe(1);

    expect(nvmrc?.evidence.detector).toBe("runtime-detector");
  });

  it("returns package runtime metadata", () => {
    const { runtime, manifestResult } = detect();

    expect(manifestResult.rootManifest).toBeDefined();

    expect(runtime.package).toBeDefined();

    expect(runtime.package?.packageManager).toBeTruthy();
  });

  it("exposes warnings for native-module compatibility", () => {
    const { runtime } = detect();

    expect(
      runtime.warnings.some((warning) =>
        warning.toLowerCase().includes("native-module"),
      ),
    ).toBe(true);
  });
});
