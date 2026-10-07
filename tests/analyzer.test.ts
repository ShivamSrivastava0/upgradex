import { describe, expect, it } from 'vitest';
import { ProjectAnalyzer } from '../src/analyzer/project-analyzer.js';

describe('ProjectAnalyzer', () => {
  it('analyzes a TypeScript source file', () => {
    const analyzer = new ProjectAnalyzer();

    const sourceFile = analyzer.getProject().createSourceFile(
      'fixture.ts',
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

    expect(result.language).toBe('typescript');
    expect(result.importCount).toBe(1);
    expect(result.functionCount).toBe(1);
    expect(result.classCount).toBe(0);
    expect(result.exportCount).toBe(1);
  });
});