import { describe, expect, it } from "vitest";

import { detectProject } from "../src/project-detector/index.js";

describe("detectProject", () => {
  it("detects a mixed JavaScript and TypeScript repository", () => {
    const result = detectProject("fixtures/project-detector-basic");

    expect(result.language.value).toBe("mixed");

    expect(
      result.language.languages.some(
        (language) => language.language === "typescript",
      ),
    ).toBe(true);

    expect(
      result.language.languages.some(
        (language) => language.language === "javascript",
      ),
    ).toBe(true);

    expect(result.language.evidence.length).toBeGreaterThan(0);
  });

  it("detects TypeScript using multiple evidence sources", () => {
    const result = detectProject("fixtures/project-detector-typescript");

    expect(result.language.value).toBe("typescript");

    expect(result.language.languages).toHaveLength(1);

    expect(result.language.languages[0]?.language).toBe("typescript");

    expect(
      result.language.evidence.some((evidence) =>
        evidence.signal.includes("TypeScript source"),
      ),
    ).toBe(true);

    expect(
      result.language.evidence.some((evidence) =>
        evidence.signal.includes("tsconfig.json"),
      ),
    ).toBe(true);

    expect(
      result.language.evidence.some((evidence) =>
        evidence.signal.includes("typescript dependency"),
      ),
    ).toBe(true);
  });

  it("reports completed scan stages with measured repository counts", () => {
    const progress: Array<{
      stage: string;
      status: string;
      durationMs: number;
      detail?: string;
    }> = [];
    const result = detectProject("fixtures/project-detector-basic", (event) =>
      progress.push(event),
    );
    const completed = progress.filter((event) => event.status === "complete");

    expect(completed.map((event) => event.stage)).toEqual([
      "index",
      "project",
      "versions",
      "source",
    ]);
    expect(completed[0]?.detail).toContain(
      `${result.inventory.files.length} files indexed`,
    );
    expect(completed.every((event) => event.durationMs >= 0)).toBe(true);
  });
});
