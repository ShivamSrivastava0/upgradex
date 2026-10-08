import { describe, expect, it } from "vitest";
import { ProjectAnalyzer } from "../src/analyzer/project-analyzer.js";
import path from "node:path";
import { buildRepositoryInventory } from "../src/project-detector/repository-inventory.js";
import { analyzeRepository } from "../src/analyzer/change-graph.js";

describe("ProjectAnalyzer", () => {
  it("analyzes a TypeScript source file", () => {
    const analyzer = new ProjectAnalyzer();

    const sourceFile = analyzer.getProject().createSourceFile(
      "fixture.ts",
      `
        import express from 'express';

        const app = express();

        function healthCheck() {
          return 'ok';
        }

        export { healthCheck };
      `,
      {
        overwrite: true,
      },
    );

    const result = analyzer.analyzeSourceFile(sourceFile);

    expect(result.language).toBe("typescript");
    expect(result.importCount).toBe(1);
    expect(result.functionCount).toBe(1);
    expect(result.classCount).toBe(0);
    expect(result.exportCount).toBe(1);
  });
});

describe("change graph", () => {
  it("builds deterministic import and Express route relationships", () => {
    const root = path.resolve(process.cwd(), "fixtures", "framework-express");
    const inventory = buildRepositoryInventory(root);
    const first = analyzeRepository(inventory);
    const second = analyzeRepository(inventory);

    expect(first.graph.serialize()).toEqual(second.graph.serialize());
    expect(
      first.graph.nodes.some(
        (node) => node.type === "ENDPOINT" && node.name === "GET /health",
      ),
    ).toBe(true);
    expect(first.graph.edges.some((edge) => edge.type === "HANDLES")).toBe(
      true,
    );
  });

  it("resolves local imports, test links, and reports dynamic/generated blind spots", () => {
    const root = path.resolve(process.cwd(), "fixtures", "analyzer-graph");
    const result = analyzeRepository(buildRepositoryInventory(root));
    expect(
      result.graph.edges.some(
        (edge) =>
          edge.type === "IMPORTS" &&
          edge.source.includes("src/main.ts") &&
          edge.target.includes("src/helper.ts"),
      ),
    ).toBe(true);
    expect(
      result.graph.edges.some(
        (edge) =>
          edge.type === "TESTED_BY" &&
          edge.target.includes("tests/main.test.ts"),
      ),
    ).toBe(true);
    expect(
      result.graph.nodes.some((node) => node.metadata.generated === true),
    ).toBe(true);
    expect(
      result.graph.nodes.some(
        (node) => node.metadata.kind === "parameter" && node.name === "req",
      ),
    ).toBe(true);
    expect(result.blindSpots.map((spot) => spot.code)).toEqual(
      expect.arrayContaining([
        "DYNAMIC_REQUIRE",
        "DYNAMIC_IMPORT",
        "DYNAMIC_CODE",
        "GENERATED_SOURCE",
      ]),
    );
  });
});
