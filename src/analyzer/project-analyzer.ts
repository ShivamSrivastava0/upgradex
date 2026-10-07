import { Project, SourceFile } from 'ts-morph';

export interface AnalyzedSourceFile {
  filePath: string;
  language: 'typescript' | 'javascript';
  statementCount: number;
  functionCount: number;
  classCount: number;
  importCount: number;
  exportCount: number;
}

export class ProjectAnalyzer {
  private readonly project: Project;

  constructor() {
    this.project = new Project({
      skipAddingFilesFromTsConfig: true,
      useInMemoryFileSystem: false,
    });
  }

  addSourceFile(filePath: string): SourceFile {
    return this.project.addSourceFileAtPath(filePath);
  }

  analyzeSourceFile(sourceFile: SourceFile): AnalyzedSourceFile {
    const extension = sourceFile.getExtension();

    const language =
      extension === '.ts' || extension === '.tsx'
        ? 'typescript'
        : 'javascript';

    return {
      filePath: sourceFile.getFilePath(),
      language,
      statementCount: sourceFile.getStatements().length,
      functionCount: sourceFile.getFunctions().length,
      classCount: sourceFile.getClasses().length,
      importCount: sourceFile.getImportDeclarations().length,
      exportCount: sourceFile.getExportDeclarations().length,
    };
  }

  getProject(): Project {
    return this.project;
  }
}