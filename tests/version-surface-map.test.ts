import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildRepositoryInventory } from "../src/project-detector/repository-inventory.js";
import { readPackageManifests } from "../src/project-detector/manifest-reader.js";
import { detectRuntime } from "../src/project-detector/runtime-detector.js";
import { buildVersionSurfaceMap } from "../src/project-detector/version-surface-map.js";

const FIXTURE_ROOT = path.resolve(process.cwd(), "fixtures");

function readFixture(name: string): string {
  return path.join(FIXTURE_ROOT, name);
}

function buildMap(root: string) {
  const inventory = buildRepositoryInventory(root);
  const manifestResult = readPackageManifests(inventory);
  const runtime = detectRuntime(
    root,
    inventory,
    manifestResult.rootManifest?.data,
    manifestResult.manifests.map((manifest) => ({
      relativePath: manifest.relativePath,
      data: manifest.data,
    })),
  );
  return {
    inventory,
    manifestResult,
    map: buildVersionSurfaceMap(
      runtime,
      manifestResult.rootManifest,
      inventory,
      manifestResult.manifests,
    ),
  };
}

describe("Version Surface Map", () => {
  it("maps React and Vite package declarations", () => {
    const { map } = buildMap(readFixture("framework-react-vite"));
    const react = map.groups.find((group) => group.technology === "react");
    const vite = map.groups.find((group) => group.technology === "vite");
    expect(
      react?.surfaces.some(
        (surface) =>
          surface.location.jsonPath === "dependencies.react" &&
          surface.authoritative,
      ),
    ).toBe(true);
    expect(
      react?.surfaces.some(
        (surface) =>
          surface.location.jsonPath === "dependencies.react-dom" &&
          !surface.authoritative,
      ),
    ).toBe(true);
    expect(vite?.surfaces[0]?.location.jsonPath).toBe("devDependencies.vite");
    expect(vite?.surfaces[0]?.authoritative).toBe(true);
  });

  it("maps TypeScript package declarations", () => {
    const { map } = buildMap(readFixture("project-detector-typescript"));
    const group = map.groups.find((item) => item.technology === "typescript");
    expect(group?.surfaces[0]?.location.jsonPath).toBe(
      "devDependencies.typescript",
    );
    expect(group?.surfaces[0]?.authoritative).toBe(true);
  });

  it("keeps lockfile evidence secondary to package manager policy", () => {
    const { inventory, map } = buildMap(readFixture("project-detector-basic"));
    const group = map.groups.find(
      (item) => item.technology === "package-manager",
    );
    expect(inventory.lockfiles.length).toBeGreaterThan(0);
    expect(
      group?.surfaces.some(
        (surface) => surface.source === "lockfile" && !surface.authoritative,
      ),
    ).toBe(true);
  });

  it("maps framework and compatibility declarations from workspace manifests", () => {
    const { map } = buildMap(readFixture("monorepo"));
    const express = map.groups.find((group) => group.technology === "express");
    const node = map.groups.find((group) => group.technology === "node");
    expect(
      express?.surfaces.some(
        (surface) =>
          surface.location.relativePath === "packages/api/package.json",
      ),
    ).toBe(true);
    expect(
      node?.surfaces.some(
        (surface) =>
          surface.location.relativePath === "packages/api/package.json" &&
          surface.location.jsonPath?.includes("@types/node"),
      ),
    ).toBe(true);
    expect(
      node?.surfaces.some(
        (surface) =>
          surface.location.relativePath === "packages/api/package.json" &&
          surface.location.jsonPath?.includes("node-gyp-build"),
      ),
    ).toBe(true);
  });

  it("maps Node.js runtime surfaces", () => {
    const root = readFixture("runtime-node");

    const inventory = buildRepositoryInventory(root);

    const manifestResult = readPackageManifests(inventory);

    const runtime = detectRuntime(
      root,
      inventory,
      manifestResult.rootManifest?.data,
    );

    const map = buildVersionSurfaceMap(runtime, manifestResult.rootManifest);

    const nodeGroup = map.groups.find((group) => group.technology === "node");

    expect(nodeGroup).toBeDefined();

    expect(nodeGroup?.surfaces.length).toBeGreaterThanOrEqual(7);

    expect(
      nodeGroup?.surfaces.some((surface) => surface.source === "nvmrc"),
    ).toBe(true);

    expect(
      nodeGroup?.surfaces.some(
        (surface) => surface.source === "package-engines",
      ),
    ).toBe(true);

    expect(
      nodeGroup?.surfaces.some((surface) => surface.source === "dockerfile"),
    ).toBe(true);

    expect(
      nodeGroup?.surfaces.some(
        (surface) => surface.source === "github-actions",
      ),
    ).toBe(true);
  });

  it("preserves exact source locations", () => {
    const root = readFixture("runtime-node");

    const inventory = buildRepositoryInventory(root);

    const manifestResult = readPackageManifests(inventory);

    const runtime = detectRuntime(
      root,
      inventory,
      manifestResult.rootManifest?.data,
    );

    const map = buildVersionSurfaceMap(runtime, manifestResult.rootManifest);

    const nodeGroup = map.groups.find((group) => group.technology === "node");

    const nvmrc = nodeGroup?.surfaces.find(
      (surface) => surface.source === "nvmrc",
    );

    expect(nvmrc?.location.relativePath).toBe(".nvmrc");

    expect(nvmrc?.location.line).toBe(1);

    expect(nvmrc?.value).toBe("22");

    expect(nvmrc?.rawValue).toBe("22");

    expect(nvmrc?.authoritative).toBe(true);
  });

  it("maps @types/node as a Node compatibility surface", () => {
    const root = readFixture("runtime-node");

    const inventory = buildRepositoryInventory(root);

    const manifestResult = readPackageManifests(inventory);

    const runtime = detectRuntime(
      root,
      inventory,
      manifestResult.rootManifest?.data,
    );

    const map = buildVersionSurfaceMap(runtime, manifestResult.rootManifest);

    const nodeGroup = map.groups.find((group) => group.technology === "node");

    const typesNode = nodeGroup?.surfaces.find(
      (surface) =>
        surface.kind === "compatibility" &&
        surface.location.jsonPath?.includes("@types/node"),
    );

    expect(typesNode).toBeDefined();

    expect(typesNode?.source).toBe("compatibility");

    expect(typesNode?.priority).toBe("secondary");

    expect(typesNode?.authoritative).toBe(false);
  });

  it("maps Express as a package version surface", () => {
    const root = readFixture("framework-express");

    const inventory = buildRepositoryInventory(root);

    const manifestResult = readPackageManifests(inventory);

    const runtime = detectRuntime(
      root,
      inventory,
      manifestResult.rootManifest?.data,
    );

    const map = buildVersionSurfaceMap(runtime, manifestResult.rootManifest);

    const expressGroup = map.groups.find(
      (group) => group.technology === "express",
    );

    expect(expressGroup).toBeDefined();

    expect(
      expressGroup?.surfaces.some(
        (surface) => surface.location.jsonPath === "dependencies.express",
      ),
    ).toBe(true);

    expect(
      expressGroup?.surfaces.some(
        (surface) => surface.technology === "express",
      ),
    ).toBe(true);
  });

  it("maps native modules as secondary Node compatibility surfaces", () => {
    const root = readFixture("runtime-node");

    const inventory = buildRepositoryInventory(root);

    const manifestResult = readPackageManifests(inventory);

    const runtime = detectRuntime(
      root,
      inventory,
      manifestResult.rootManifest?.data,
    );

    const map = buildVersionSurfaceMap(runtime, manifestResult.rootManifest);

    const nodeGroup = map.groups.find((group) => group.technology === "node");

    const nativeSurface = nodeGroup?.surfaces.find(
      (surface) =>
        surface.kind === "compatibility" &&
        surface.evidence.signal.includes("native ABI"),
    );

    expect(nativeSurface).toBeDefined();

    expect(nativeSurface?.authoritative).toBe(false);

    expect(nativeSurface?.priority).toBe("secondary");
  });

  it("maps packageManager as a tooling surface", () => {
    const root = readFixture("runtime-node");

    const inventory = buildRepositoryInventory(root);

    const manifestResult = readPackageManifests(inventory);

    const runtime = detectRuntime(
      root,
      inventory,
      manifestResult.rootManifest?.data,
    );

    const map = buildVersionSurfaceMap(runtime, manifestResult.rootManifest);

    const packageManagerGroup = map.groups.find(
      (group) => group.technology === "package-manager",
    );

    expect(packageManagerGroup).toBeDefined();

    expect(packageManagerGroup?.surfaces[0]?.kind).toBe("tooling");

    expect(packageManagerGroup?.surfaces[0]?.location.jsonPath).toBe(
      "packageManager",
    );
  });

  it("reports map totals correctly", () => {
    const root = readFixture("runtime-node");

    const inventory = buildRepositoryInventory(root);

    const manifestResult = readPackageManifests(inventory);

    const runtime = detectRuntime(
      root,
      inventory,
      manifestResult.rootManifest?.data,
    );

    const map = buildVersionSurfaceMap(runtime, manifestResult.rootManifest);

    const calculatedTotal = map.groups.reduce(
      (total, group) => total + group.surfaces.length,
      0,
    );

    expect(map.totalSurfaces).toBe(calculatedTotal);

    expect(map.totalTechnologies).toBe(map.groups.length);
  });
});
