import { describe, expect, it } from "vitest";

import { detectFrameworks } from "../src/project-detector/framework-detector.js";
import { buildRepositoryInventory } from "../src/project-detector/repository-inventory.js";

describe("detectFrameworks", () => {
  it("detects Express from dependency and source usage", () => {
    const inventory = buildRepositoryInventory("fixtures/framework-express");

    const result = detectFrameworks(inventory);

    const express = result.technologies.find(
      (technology) => technology.technology === "express",
    );

    expect(express).toBeDefined();
    expect(express?.status).toBe("detected");

    expect(express?.declaredVersionRanges).toContain("^4.21.2");

    expect(
      express?.evidence.some((evidence) =>
        evidence.signal.includes("express declared"),
      ),
    ).toBe(true);

    expect(
      express?.evidence.some((evidence) =>
        evidence.signal.includes('import from "express"'),
      ),
    ).toBe(true);
  });

  it("detects CommonJS require usage in source files", () => {
    const inventory = buildRepositoryInventory(
      "fixtures/rule-express-positive",
    );
    const result = detectFrameworks(inventory);
    const express = result.technologies.find(
      (technology) => technology.technology === "express",
    );

    expect(
      express?.evidence.some((evidence) =>
        evidence.signal.includes('require("express")'),
      ),
    ).toBe(true);
  });

  it("detects React and Vite independently", () => {
    const inventory = buildRepositoryInventory("fixtures/framework-react-vite");

    const result = detectFrameworks(inventory);

    const names = result.technologies.map(
      (technology) => technology.technology,
    );

    expect(names).toContain("react");
    expect(names).toContain("vite");

    const vite = result.technologies.find(
      (technology) => technology.technology === "vite",
    );

    expect(
      vite?.evidence.some((evidence) =>
        evidence.signal.includes("vite.config.ts"),
      ),
    ).toBe(true);
  });

  it("does not detect frameworks from unrelated strings", () => {
    const inventory = buildRepositoryInventory(
      "fixtures/framework-false-positive",
    );

    const result = detectFrameworks(inventory);

    expect(result.technologies).toHaveLength(0);
  });
});
