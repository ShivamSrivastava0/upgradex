import path from "node:path";
import { Node, SyntaxKind, type Project, type SourceFile } from "ts-morph";
import type {
  RepositoryFile,
  RepositoryInventory,
} from "../project-detector/types.js";
import { readProjectTextFile } from "../safety/safe-file-reader.js";
import { createSourceProject } from "../project-detector/source-project.js";

export type GraphNodeType =
  "FILE" | "FUNCTION" | "CLASS" | "SYMBOL" | "ENDPOINT" | "TEST" | "CONFIG";
export type GraphEdgeType =
  | "IMPORTS"
  | "CALLS"
  | "EXPOSES"
  | "HANDLES"
  | "TESTED_BY"
  | "CONFIGURED_BY"
  | "REFERENCES";
export type Resolution = "resolved" | "heuristic" | "unresolved";

export interface GraphLocation {
  file: string;
  line?: number;
  column?: number;
}
export interface ChangeGraphNode {
  id: string;
  type: GraphNodeType;
  name: string;
  source: string;
  location?: GraphLocation;
  metadata: Record<string, string | number | boolean | undefined>;
}
export interface ChangeGraphEdge {
  source: string;
  target: string;
  type: GraphEdgeType;
  resolution: Resolution;
  metadata: Record<string, string | number | boolean | undefined>;
}
export interface AnalysisBlindSpot {
  code: string;
  message: string;
  location?: GraphLocation;
}

export class ChangeGraph {
  private readonly nodesById = new Map<string, ChangeGraphNode>();
  private readonly nodesBySource = new Map<
    string,
    Map<string, ChangeGraphNode>
  >();
  private readonly edgesByKey = new Map<string, ChangeGraphEdge>();
  private readonly outgoingByNode = new Map<string, ChangeGraphEdge[]>();
  private readonly incomingByNode = new Map<string, ChangeGraphEdge[]>();

  addNode(node: ChangeGraphNode): void {
    const previous = this.nodesById.get(node.id);
    if (previous && previous.source !== node.source)
      this.nodesBySource.get(previous.source)?.delete(node.id);
    this.nodesById.set(node.id, node);
    const sourceNodes =
      this.nodesBySource.get(node.source) ?? new Map<string, ChangeGraphNode>();
    sourceNodes.set(node.id, node);
    this.nodesBySource.set(node.source, sourceNodes);
  }
  addEdge(edge: ChangeGraphEdge): void {
    if (!this.nodesById.has(edge.source) || !this.nodesById.has(edge.target))
      return;
    const key = `${edge.source}\0${edge.type}\0${edge.target}\0${JSON.stringify(edge.metadata)}`;
    if (this.edgesByKey.has(key)) return;
    this.edgesByKey.set(key, edge);
    const outgoing = this.outgoingByNode.get(edge.source) ?? [];
    outgoing.push(edge);
    this.outgoingByNode.set(edge.source, outgoing);
    const incoming = this.incomingByNode.get(edge.target) ?? [];
    incoming.push(edge);
    this.incomingByNode.set(edge.target, incoming);
  }
  getNode(id: string): ChangeGraphNode | undefined {
    return this.nodesById.get(id);
  }
  getNodesBySource(source: string): ChangeGraphNode[] {
    return [...(this.nodesBySource.get(source)?.values() ?? [])].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  }
  get nodes(): ChangeGraphNode[] {
    return [...this.nodesById.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  }
  get edges(): ChangeGraphEdge[] {
    return [...this.edgesByKey.values()].sort((a, b) =>
      `${a.source}:${a.type}:${a.target}`.localeCompare(
        `${b.source}:${b.type}:${b.target}`,
      ),
    );
  }
  outgoing(id: string, types?: GraphEdgeType[]): ChangeGraphEdge[] {
    return (this.outgoingByNode.get(id) ?? [])
      .filter((edge) => !types || types.includes(edge.type))
      .sort(compareEdges);
  }
  incoming(id: string, types?: GraphEdgeType[]): ChangeGraphEdge[] {
    return (this.incomingByNode.get(id) ?? [])
      .filter((edge) => !types || types.includes(edge.type))
      .sort(compareEdges);
  }
  edgesWithin(nodeIds: ReadonlySet<string>): ChangeGraphEdge[] {
    const included = new Map<string, ChangeGraphEdge>();
    for (const id of nodeIds) {
      for (const edge of this.outgoingByNode.get(id) ?? []) {
        if (nodeIds.has(edge.target))
          included.set(
            `${edge.source}\0${edge.type}\0${edge.target}\0${JSON.stringify(edge.metadata)}`,
            edge,
          );
      }
    }
    return [...included.values()].sort(compareEdges);
  }
  traverse(
    start: string,
    options: {
      depth?: number;
      edgeTypes?: GraphEdgeType[];
      direction?: "outgoing" | "incoming" | "both";
    } = {},
  ): ChangeGraphNode[] {
    const depth = Math.max(0, options.depth ?? 3);
    const direction = options.direction ?? "both";
    const seen = new Set([start]);
    let frontier = [start];
    for (let level = 0; level < depth && frontier.length; level += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        const edges = [
          ...(direction !== "incoming"
            ? this.outgoing(id, options.edgeTypes)
            : []),
          ...(direction !== "outgoing"
            ? this.incoming(id, options.edgeTypes)
            : []),
        ];
        for (const edge of edges) {
          const adjacent = edge.source === id ? edge.target : edge.source;
          if (!seen.has(adjacent)) {
            seen.add(adjacent);
            next.push(adjacent);
          }
        }
      }
      frontier = next;
    }
    return [...seen]
      .filter((id) => id !== start)
      .map((id) => this.nodesById.get(id))
      .filter((node): node is ChangeGraphNode => Boolean(node))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  serialize(): { nodes: ChangeGraphNode[]; edges: ChangeGraphEdge[] } {
    return { nodes: this.nodes, edges: this.edges };
  }
}

function compareEdges(a: ChangeGraphEdge, b: ChangeGraphEdge): number {
  return `${a.source}:${a.type}:${a.target}`.localeCompare(
    `${b.source}:${b.type}:${b.target}`,
  );
}

export interface RepositoryAnalysis {
  graph: ChangeGraph;
  analyzedSourceFiles: number;
  analyzedTestFiles: number;
  files: Array<{
    id: string;
    relativePath: string;
    language: "typescript" | "javascript";
    size: number;
    isTest: boolean;
    isGenerated: boolean;
  }>;
  blindSpots: AnalysisBlindSpot[];
}

function normalize(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}
function location(
  sourceFile: SourceFile,
  node: Node,
  root: string,
): GraphLocation {
  const line = sourceFile.getLineAndColumnAtPos(node.getStart());
  return {
    file: normalize(path.relative(root, sourceFile.getFilePath())),
    line: line.line,
    column: line.column,
  };
}
function isTest(file: RepositoryFile): boolean {
  return (
    file.category === "test" ||
    /(?:^|\/)(?:__tests__\/|tests?\/)|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(
      normalize(file.relativePath),
    )
  );
}
function isGenerated(file: RepositoryFile): boolean {
  return (
    file.category === "generated" ||
    /(?:^|\/)(?:dist|build|generated|coverage)\//i.test(
      normalize(file.relativePath),
    )
  );
}
function sourceCandidates(inventory: RepositoryInventory): RepositoryFile[] {
  return inventory.files.filter(
    (file) =>
      ["source", "test", "generated"].includes(file.category) &&
      /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file.relativePath),
  );
}
function stableId(
  kind: string,
  relative: string,
  line?: number,
  column?: number,
  name = "",
): string {
  return `${kind.toLowerCase()}:${normalize(relative)}:${line ?? 0}:${column ?? 0}:${name}`;
}
function symbolName(node: Node): string | undefined {
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isClassDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isPropertyDeclaration(node) ||
    Node.isVariableDeclaration(node) ||
    Node.isParameterDeclaration(node) ||
    Node.isInterfaceDeclaration(node) ||
    Node.isTypeAliasDeclaration(node) ||
    Node.isEnumDeclaration(node)
  )
    return node.getName();
  return undefined;
}
function localImportTarget(
  specifier: string,
  fromPath: string,
  knownFiles: Set<string>,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = normalize(
    path.posix.normalize(
      path.posix.join(path.posix.dirname(fromPath), specifier),
    ),
  );
  const substitutions = base.endsWith(".js")
    ? [base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx"]
    : base.endsWith(".mjs")
      ? [base.slice(0, -4) + ".mts"]
      : base.endsWith(".cjs")
        ? [base.slice(0, -4) + ".cts"]
        : [];
  const candidates = [
    base,
    ...substitutions,
    ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"].map(
      (ext) => `${base}${ext}`,
    ),
    ...["index.ts", "index.tsx", "index.js", "index.jsx"].map(
      (name) => `${base}/${name}`,
    ),
  ];
  return candidates.find((candidate) => knownFiles.has(candidate));
}

export function analyzeRepository(
  inventory: RepositoryInventory,
  project: Project = createSourceProject(inventory),
): RepositoryAnalysis {
  const graph = new ChangeGraph();
  const blindSpots: AnalysisBlindSpot[] = [];
  const candidates = sourceCandidates(inventory).sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );
  const knownFiles = new Set(
    candidates.map((file) => normalize(file.relativePath)),
  );
  const sourceByPath = new Map<string, SourceFile>();
  const fileNodeIds = new Map<string, string>();
  const functionNodes = new Map<
    string,
    Array<{ id: string; file: string; name: string }>
  >();
  const testFilePaths = new Set<string>();

  for (const file of candidates) {
    const rel = normalize(file.relativePath);
    const fileId = stableId(isTest(file) ? "TEST" : "FILE", rel);
    fileNodeIds.set(rel, fileId);
    if (isTest(file)) testFilePaths.add(rel);
    graph.addNode({
      id: fileId,
      type: isTest(file) ? "TEST" : "FILE",
      name: path.posix.basename(rel),
      source: rel,
      metadata: { size: file.sizeBytes, generated: isGenerated(file) },
    });
    if (isGenerated(file)) {
      blindSpots.push({
        code: "GENERATED_SOURCE",
        message:
          "Generated code is indexed but its source ownership and regeneration process are unknown.",
        location: { file: rel },
      });
      continue;
    }
    const absolute = path.resolve(inventory.root, rel);
    const sourceFile = project.getSourceFile(absolute);
    if (!sourceFile) {
      const knownSkip = inventory.warnings.some(
        (warning) =>
          warning.relativePath === rel &&
          ["FILE_TOO_LARGE", "READ_ERROR"].includes(warning.code),
      );
      if (!knownSkip) {
        const read = readProjectTextFile(inventory.root, rel);
        blindSpots.push({
          code: read.ok ? "PARSE_FAILURE" : "SOURCE_UNREADABLE",
          message: read.ok
            ? "Source file could not be added to the analysis project."
            : `Source file could not be parsed: ${read.warning ?? "read failed"}`,
          location: { file: rel },
        });
      }
      continue;
    }
    sourceByPath.set(rel, sourceFile);
  }

  const routeReceivers = new Map<string, Set<string>>();
  const configNodeIds = new Map<string, string>();
  for (const [rel, sourceFile] of sourceByPath) {
    const register = (name: string, node: Node): void => {
      const loc = location(sourceFile, node, inventory.root);
      const id = stableId("FUNCTION", rel, loc.line, loc.column, name);
      graph.addNode({
        id,
        type: "FUNCTION",
        name,
        source: rel,
        location: loc,
        metadata: {},
      });
      const rows = functionNodes.get(name) ?? [];
      if (!rows.some((row) => row.id === id))
        rows.push({ id, file: rel, name });
      functionNodes.set(name, rows);
    };
    for (const node of sourceFile.getDescendants()) {
      if (Node.isFunctionDeclaration(node)) {
        const name = node.getName();
        if (name) register(name, node);
      } else if (Node.isClassDeclaration(node)) {
        const className = node.getName();
        if (!className) continue;
        for (const method of node.getMethods())
          register(`${className}.${method.getName()}`, method);
      } else if (Node.isVariableDeclaration(node)) {
        const initializer = node.getInitializer();
        if (
          initializer &&
          (Node.isArrowFunction(initializer) ||
            Node.isFunctionExpression(initializer))
        )
          register(node.getName(), node);
      }
    }
  }
  for (const [rel, sourceFile] of sourceByPath) {
    const descendants = sourceFile.getDescendants();
    const fileId = fileNodeIds.get(rel);
    if (!fileId) continue;
    const localSymbols = new Map<string, string>();
    const importedLocalFiles = new Set<string>();
    for (const variable of descendants.filter(Node.isVariableDeclaration)) {
      const name = variable.getName();
      const initializer = variable.getInitializer();
      if (!name || !initializer || !Node.isCallExpression(initializer))
        continue;
      const callee = initializer.getExpression().getText();
      if (callee === "express" || callee.endsWith(".Router")) {
        const receivers = routeReceivers.get(rel) ?? new Set<string>();
        receivers.add(name);
        routeReceivers.set(rel, receivers);
      }
    }
    for (const node of descendants.filter(Node.isFunctionDeclaration)) {
      const name = node.getName();
      if (!name) continue;
      const loc = location(sourceFile, node, inventory.root);
      const id = stableId("FUNCTION", rel, loc.line, loc.column, name);
      graph.addNode({
        id,
        type: "FUNCTION",
        name,
        source: rel,
        location: loc,
        metadata: { exported: node.isExported() },
      });
      const rows = functionNodes.get(name) ?? [];
      if (!rows.some((row) => row.id === id))
        rows.push({ id, file: rel, name });
      functionNodes.set(name, rows);
      localSymbols.set(name, id);
    }
    for (const node of descendants.filter(Node.isClassDeclaration)) {
      const name = node.getName();
      if (!name) continue;
      const loc = location(sourceFile, node, inventory.root);
      const id = stableId("CLASS", rel, loc.line, loc.column, name);
      graph.addNode({
        id,
        type: "CLASS",
        name,
        source: rel,
        location: loc,
        metadata: { exported: node.isExported() },
      });
      localSymbols.set(name, id);
      for (const method of node.getMethods()) {
        const methodName = method.getName();
        const methodLoc = location(sourceFile, method, inventory.root);
        const methodId = stableId(
          "FUNCTION",
          rel,
          methodLoc.line,
          methodLoc.column,
          `${name}.${methodName}`,
        );
        graph.addNode({
          id: methodId,
          type: "FUNCTION",
          name: `${name}.${methodName}`,
          source: rel,
          location: methodLoc,
          metadata: { container: name },
        });
        const rows = functionNodes.get(methodName) ?? [];
        if (!rows.some((row) => row.id === methodId))
          rows.push({ id: methodId, file: rel, name: methodName });
        functionNodes.set(methodName, rows);
      }
    }
    for (const node of descendants) {
      if (
        Node.isVariableDeclaration(node) &&
        node.getInitializer() &&
        (Node.isArrowFunction(node.getInitializer()!) ||
          Node.isFunctionExpression(node.getInitializer()!))
      ) {
        const name = node.getName();
        if (name) {
          const loc = location(sourceFile, node, inventory.root);
          const id = stableId("FUNCTION", rel, loc.line, loc.column, name);
          graph.addNode({
            id,
            type: "FUNCTION",
            name,
            source: rel,
            location: loc,
            metadata: { exported: node.isExported() },
          });
          const rows = functionNodes.get(name) ?? [];
          if (!rows.some((row) => row.id === id))
            rows.push({ id, file: rel, name });
          functionNodes.set(name, rows);
          localSymbols.set(name, id);
        }
      } else if (
        Node.isVariableDeclaration(node) ||
        Node.isInterfaceDeclaration(node) ||
        Node.isTypeAliasDeclaration(node) ||
        Node.isEnumDeclaration(node)
      ) {
        const name = symbolName(node);
        if (!name) continue;
        if (localSymbols.has(name)) continue;
        const loc = location(sourceFile, node, inventory.root);
        const id = stableId("SYMBOL", rel, loc.line, loc.column, name);
        graph.addNode({
          id,
          type: "SYMBOL",
          name,
          source: rel,
          location: loc,
          metadata: {
            kind: Node.isVariableDeclaration(node) ? "variable" : "type",
          },
        });
        localSymbols.set(name, id);
      }
    }
    for (const parameter of descendants.filter(Node.isParameterDeclaration)) {
      const name = parameter.getName();
      if (!name) continue;
      const loc = location(sourceFile, parameter, inventory.root);
      const container = parameter.getFirstAncestor((ancestor) =>
        Node.isFunctionLikeDeclaration(ancestor),
      );
      const containerName = container
        ? (symbolName(container) ?? "anonymous")
        : "anonymous";
      const id = stableId("SYMBOL", rel, loc.line, loc.column, name);
      graph.addNode({
        id,
        type: "SYMBOL",
        name,
        source: rel,
        location: loc,
        metadata: { kind: "parameter", container: containerName },
      });
      localSymbols.set(name, id);
    }
    for (const imp of sourceFile.getImportDeclarations()) {
      const importLoc = location(sourceFile, imp, inventory.root);
      const importName =
        imp.getDefaultImport()?.getText() ??
        imp.getNamespaceImport()?.getText() ??
        imp
          .getNamedImports()
          .map((item) => item.getName())
          .join(", ") ??
        imp.getModuleSpecifierValue();
      graph.addNode({
        id: stableId(
          "SYMBOL",
          rel,
          importLoc.line,
          importLoc.column,
          `import:${importName}`,
        ),
        type: "SYMBOL",
        name: importName,
        source: rel,
        location: importLoc,
        metadata: { kind: "import", module: imp.getModuleSpecifierValue() },
      });
      const target = localImportTarget(
        imp.getModuleSpecifierValue(),
        rel,
        knownFiles,
      );
      if (target) {
        importedLocalFiles.add(target);
        const targetId = fileNodeIds.get(target);
        if (targetId) {
          graph.addEdge({
            source: fileId,
            target: targetId,
            type: "IMPORTS",
            resolution: "resolved",
            metadata: { module: imp.getModuleSpecifierValue() },
          });
          if (testFilePaths.has(rel))
            graph.addEdge({
              source: targetId,
              target: fileId,
              type: "TESTED_BY",
              resolution: "heuristic",
              metadata: { basis: "test import" },
            });
        }
      }
    }
    for (const declaration of sourceFile.getExportDeclarations()) {
      const exportLoc = location(sourceFile, declaration, inventory.root);
      const exportName =
        declaration.getModuleSpecifierValue() ??
        declaration
          .getNamedExports()
          .map((item) => item.getName())
          .join(", ") ??
        "*";
      graph.addNode({
        id: stableId(
          "SYMBOL",
          rel,
          exportLoc.line,
          exportLoc.column,
          `export:${exportName}`,
        ),
        type: "SYMBOL",
        name: exportName,
        source: rel,
        location: exportLoc,
        metadata: {
          kind: "export",
          module: declaration.getModuleSpecifierValue(),
        },
      });
    }
    for (const call of descendants.filter(Node.isCallExpression)) {
      const expression = call.getExpression();
      const callText = expression.getText();
      if (callText === "eval" || callText === "Function")
        blindSpots.push({
          code: "DYNAMIC_CODE",
          message: `${callText} creates behavior that static analysis cannot resolve.`,
          location: location(sourceFile, call, inventory.root),
        });
      if (callText === "require") {
        const arg = call.getArguments()[0];
        if (arg && !Node.isStringLiteral(arg))
          blindSpots.push({
            code: "DYNAMIC_REQUIRE",
            message: "Variable require() target could not be resolved.",
            location: location(sourceFile, call, inventory.root),
          });
        if (arg && Node.isStringLiteral(arg)) {
          const target = localImportTarget(
            arg.getLiteralValue(),
            rel,
            knownFiles,
          );
          const targetId = target ? fileNodeIds.get(target) : undefined;
          if (targetId)
            graph.addEdge({
              source: fileId,
              target: targetId,
              type: "IMPORTS",
              resolution: "resolved",
              metadata: { module: arg.getLiteralValue(), loader: "require" },
            });
        }
      }
      if (Node.isImportExpression(expression) || callText === "import") {
        const arg = call.getArguments()[0];
        if (arg && !Node.isStringLiteral(arg))
          blindSpots.push({
            code: "DYNAMIC_IMPORT",
            message: "Dynamic import target could not be resolved statically.",
            location: location(sourceFile, call, inventory.root),
          });
      }
      const simpleName = Node.isIdentifier(expression)
        ? expression.getText()
        : undefined;
      if (simpleName) {
        const targets = functionNodes.get(simpleName) ?? [];
        const sameFile = targets.filter((target) => target.file === rel);
        const target =
          sameFile.length === 1
            ? sameFile[0]
            : targets.length === 1 && importedLocalFiles.has(targets[0]!.file)
              ? targets[0]
              : undefined;
        if (target) {
          const caller = call.getFirstAncestor((ancestor) =>
            Node.isFunctionLikeDeclaration(ancestor),
          );
          const variableCaller = caller?.getFirstAncestorByKind(
            SyntaxKind.VariableDeclaration,
          );
          const callerName =
            (variableCaller && Node.isVariableDeclaration(variableCaller)
              ? variableCaller.getName()
              : undefined) ??
            (caller && symbolName(caller));
          const callerTarget = callerName
            ? (functionNodes.get(callerName) ?? []).find(
                (item) => item.file === rel,
              )
            : undefined;
          graph.addEdge({
            source: callerTarget?.id ?? fileId,
            target: target.id,
            type: "CALLS",
            resolution: target.file === rel ? "resolved" : "heuristic",
            metadata: { call: simpleName },
          });
        } else if (targets.length > 1) {
          blindSpots.push({
            code: "AMBIGUOUS_CALL",
            message: `Call to ${simpleName} has multiple possible declarations.`,
            location: location(sourceFile, call, inventory.root),
          });
        }
      }
      const property = Node.isPropertyAccessExpression(expression)
        ? expression
        : undefined;
      if (
        property &&
        /^(get|post|put|patch|delete|all|use|route)$/.test(property.getName())
      ) {
        const receiver = property.getExpression().getText();
        const routeSet = routeReceivers.get(rel) ?? new Set<string>();
        if (routeSet.has(receiver)) {
          const args = call.getArguments();
          const pathArg = args[0];
          const verb = property.getName().toUpperCase();
          const routePath =
            pathArg && Node.isStringLiteral(pathArg)
              ? pathArg.getLiteralValue()
              : "<dynamic>";
          const routeLoc = location(sourceFile, call, inventory.root);
          const endpointId = stableId(
            "ENDPOINT",
            rel,
            routeLoc.line,
            routeLoc.column,
            `${verb} ${routePath}`,
          );
          graph.addNode({
            id: endpointId,
            type: "ENDPOINT",
            name: `${verb} ${routePath}`,
            source: rel,
            location: routeLoc,
            metadata: { method: verb, path: routePath },
          });
          graph.addEdge({
            source: fileId,
            target: endpointId,
            type: "EXPOSES",
            resolution:
              pathArg && Node.isStringLiteral(pathArg)
                ? "resolved"
                : "heuristic",
            metadata: {},
          });
          for (const arg of args.slice(1)) {
            const handlerName = Node.isIdentifier(arg)
              ? arg.getText()
              : undefined;
            const handler = handlerName
              ? (functionNodes.get(handlerName) ?? []).find(
                  (item) => item.file === rel,
                )
              : undefined;
            if (handler)
              graph.addEdge({
                source: endpointId,
                target: handler.id,
                type: "HANDLES",
                resolution: "resolved",
                metadata: {},
              });
          }
          if (routePath === "<dynamic>")
            blindSpots.push({
              code: "DYNAMIC_ROUTE",
              message: "Route path is computed dynamically.",
              location: routeLoc,
            });
        }
      }
    }
  }

  for (const configPath of inventory.configFiles) {
    const rel = normalize(configPath);
    const id = stableId("CONFIG", rel);
    graph.addNode({
      id,
      type: "CONFIG",
      name: path.posix.basename(rel),
      source: rel,
      metadata: {},
    });
    configNodeIds.set(rel, id);
  }
  for (const [sourcePath, sourceId] of fileNodeIds) {
    if (sourcePath.endsWith(".ts") || sourcePath.endsWith(".tsx")) {
      const tsconfig = configNodeIds.get("tsconfig.json");
      if (tsconfig)
        graph.addEdge({
          source: sourceId,
          target: tsconfig,
          type: "CONFIGURED_BY",
          resolution: "heuristic",
          metadata: { basis: "TypeScript source" },
        });
    }
  }
  return {
    graph,
    analyzedSourceFiles: [...sourceByPath.keys()].filter(
      (relativePath) => !testFilePaths.has(relativePath),
    ).length,
    analyzedTestFiles: [...sourceByPath.keys()].filter((relativePath) =>
      testFilePaths.has(relativePath),
    ).length,
    files: candidates.map((file) => {
      const relativePath = normalize(file.relativePath);
      const ext = path.extname(relativePath).toLowerCase();
      return {
        id: fileNodeIds.get(relativePath)!,
        relativePath,
        language: ext.includes("ts") ? "typescript" : "javascript",
        size: file.sizeBytes,
        isTest: testFilePaths.has(relativePath),
        isGenerated: isGenerated(file),
      };
    }),
    blindSpots: blindSpots.sort((a, b) =>
      `${a.location?.file}:${a.location?.line}:${a.code}`.localeCompare(
        `${b.location?.file}:${b.location?.line}:${b.code}`,
      ),
    ),
  };
}
