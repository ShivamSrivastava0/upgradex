import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_SCAN_LIMITS,
  type ScanLimits,
  type ScanWarning,
} from "../safety/scan-policy.js";

import type {
  RepositoryFile,
  RepositoryFileCategory,
  RepositoryInventory,
} from "./types.js";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".upgradex",
  "node_modules",
  "bower_components",
  "jspm_packages",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".vite",
  ".output",
  ".svelte-kit",
  "out",
  "target",
  ".gradle",
  ".venv",
  "venv",
  "env",
  ".env",
  ".tox",
  "site-packages",
  "dist-packages",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".hypothesis",
  ".idea",
  ".vscode",
]);

const SENSITIVE_FILE_PATTERNS = [
  /^\.env(?:\..*)?$/i,
  /^\.npmrc$/i,
  /^\.yarnrc(?:\.yml)?$/i,
  /^\.netrc$/i,
  /^id_rsa(?:\..*)?$/i,
  /^id_ed25519(?:\..*)?$/i,
  /^id_ecdsa(?:\..*)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.crt$/i,
  /\.cer$/i,
  /^credentials(?:\..*)?$/i,
  /^secrets?(?:\..*)?$/i,
];

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

const CONFIG_FILE_NAMES = new Set([
  ".nvmrc",
  ".node-version",
  ".tool-versions",
  ".editorconfig",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  ".prettierrc.ts",
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.mjs",
  ".eslintignore",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "tsconfig.json",
  "tsconfig.base.json",
  "tsconfig.build.json",
  "tsconfig.node.json",
  "tsconfig.app.json",
  "vite.config.js",
  "vite.config.ts",
  "vite.config.mjs",
  "vite.config.cjs",
  "vitest.config.js",
  "vitest.config.ts",
  "vitest.config.mjs",
  "vitest.config.cjs",
  "jest.config.js",
  "jest.config.ts",
  "jest.config.mjs",
  "jest.config.cjs",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "nuxt.config.ts",
  "nuxt.config.js",
  "astro.config.js",
  "astro.config.ts",
  "svelte.config.js",
  "svelte.config.ts",
  "vercel.json",
  "serverless.yml",
  "serverless.yaml",
  "serverless.json",
  "fly.toml",
  "railway.json",
  "railway.toml",
  "render.yaml",
  "netlify.toml",
  "devcontainer.json",
]);

const CI_PATH_PREFIXES = [
  ".github/workflows/",
  ".gitlab/",
  ".circleci/",
  ".buildkite/",
];

const CI_FILE_NAMES = new Set(["jenkinsfile", ".travis.yml", ".travis.yaml"]);

const DOCKER_FILE_NAMES = new Set([
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
]);

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);

const TEST_FILE_PATTERNS = [
  /\.test\.[cm]?[jt]sx?$/i,
  /\.spec\.[cm]?[jt]sx?$/i,
  /^test[s]?[/\\]/i,
  /^__tests__[/\\]/i,
  /[/\\]__tests__[/\\]/i,
  /[/\\]tests?[/\\]/i,
];

const GENERATED_PATH_PATTERNS = [
  /^dist[/\\]/i,
  /^build[/\\]/i,
  /^coverage[/\\]/i,
  /^out[/\\]/i,
  /^generated[/\\]/i,
];

function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);

  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function isSensitiveFile(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  const baseName = path.basename(normalized);

  if (SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(baseName))) {
    return true;
  }

  const lowerPath = normalized.toLowerCase();

  return (
    lowerPath.includes("/.env/") ||
    lowerPath.includes("/secrets/") ||
    lowerPath.includes("/credentials/")
  );
}

function isCiFile(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  const lowerPath = normalized.toLowerCase();
  const baseName = path.basename(lowerPath);

  if (
    CI_PATH_PREFIXES.some((prefix) =>
      lowerPath.startsWith(prefix.toLowerCase()),
    )
  ) {
    return true;
  }

  return CI_FILE_NAMES.has(baseName);
}

function isDockerFile(relativePath: string): boolean {
  const baseName = path
    .basename(normalizeRelativePath(relativePath))
    .toLowerCase();

  return DOCKER_FILE_NAMES.has(baseName);
}

function isLockfile(relativePath: string): boolean {
  const baseName = path
    .basename(normalizeRelativePath(relativePath))
    .toLowerCase();

  return LOCKFILE_NAMES.has(baseName);
}

function isConfigFile(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  const baseName = path.basename(normalized).toLowerCase();

  if (CONFIG_FILE_NAMES.has(baseName)) {
    return true;
  }

  if (normalized.startsWith(".github/")) {
    return false;
  }

  return (
    baseName.endsWith(".config.js") ||
    baseName.endsWith(".config.cjs") ||
    baseName.endsWith(".config.mjs") ||
    baseName.endsWith(".config.ts") ||
    baseName.endsWith(".config.json")
  );
}

function isTestFile(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);

  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isSourceFile(relativePath: string): boolean {
  const extension = path.extname(relativePath).toLowerCase();

  return SOURCE_EXTENSIONS.has(extension);
}

function isGeneratedFile(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);

  return GENERATED_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function getRepositoryFileCategory(
  relativePath: string,
  fileName: string,
): RepositoryFileCategory {
  if (isSensitiveFile(relativePath)) {
    return "sensitive";
  }

  if (isGeneratedFile(relativePath)) {
    return "generated";
  }

  if (isLockfile(relativePath)) {
    return "lockfile";
  }

  if (fileName === "package.json") {
    return "manifest";
  }

  if (isCiFile(relativePath)) {
    return "ci";
  }

  if (isDockerFile(relativePath)) {
    return "docker";
  }

  if (isTestFile(relativePath)) {
    return "test";
  }

  if (isSourceFile(relativePath)) {
    return "source";
  }

  if (isConfigFile(relativePath)) {
    return "config";
  }

  return "unknown";
}

function createWarning(
  code: ScanWarning["code"],
  relativePath: string,
  message: string,
): ScanWarning {
  return {
    code,
    relativePath,
    message,
  };
}

function safeRealpath(targetPath: string): string | undefined {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return undefined;
  }
}

function safeStat(filePath: string): fs.Stats | undefined {
  try {
    return fs.statSync(filePath);
  } catch {
    return undefined;
  }
}

function shouldIgnoreDirectory(directoryName: string): boolean {
  return IGNORED_DIRECTORIES.has(directoryName);
}

interface InventoryState {
  files: RepositoryFile[];
  warnings: ScanWarning[];
  extensions: Record<string, number>;
  lockfiles: string[];
  configFiles: string[];
  ciFiles: string[];
  dockerFiles: string[];

  sourceFileCount: number;
  testFileCount: number;
  configFileCount: number;
  sensitiveFileCount: number;

  totalBytesScanned: number;

  fileLimitReached: boolean;
  totalSizeLimitReached: boolean;
}

function incrementExtension(
  extensions: Record<string, number>,
  extension: string,
): void {
  const key = extension || "[no-extension]";
  extensions[key] = (extensions[key] ?? 0) + 1;
}

function addCategorizedFile(
  state: InventoryState,
  repositoryFile: RepositoryFile,
): void {
  state.files.push(repositoryFile);

  incrementExtension(state.extensions, repositoryFile.extension);

  switch (repositoryFile.category) {
    case "source":
      state.sourceFileCount += 1;
      break;

    case "test":
      state.testFileCount += 1;
      break;

    case "config":
      state.configFileCount += 1;
      break;

    case "sensitive":
      state.sensitiveFileCount += 1;
      break;

    default:
      break;
  }

  if (repositoryFile.category === "lockfile") {
    state.lockfiles.push(repositoryFile.relativePath);
  }

  if (repositoryFile.category === "config") {
    state.configFiles.push(repositoryFile.relativePath);
  }

  if (repositoryFile.category === "ci") {
    state.ciFiles.push(repositoryFile.relativePath);
  }

  if (repositoryFile.category === "docker") {
    state.dockerFiles.push(repositoryFile.relativePath);
  }
}

function createRepositoryFile(
  root: string,
  absolutePath: string,
  relativePath: string,
  sizeBytes: number,
): RepositoryFile {
  return {
    absolutePath,
    relativePath,
    extension: path.extname(relativePath).toLowerCase(),
    sizeBytes,
    category: getRepositoryFileCategory(
      relativePath,
      path.basename(relativePath).toLowerCase(),
    ),
  };
}

function walkDirectory(
  root: string,
  currentDirectory: string,
  state: InventoryState,
  limits: ScanLimits,
): void {
  if (state.fileLimitReached || state.totalSizeLimitReached) {
    return;
  }

  let entries: fs.Dirent[];

  try {
    entries = fs.readdirSync(currentDirectory, {
      withFileTypes: true,
    });
  } catch (error) {
    const relativePath = normalizeRelativePath(
      path.relative(root, currentDirectory),
    );

    state.warnings.push(
      createWarning(
        "READ_ERROR",
        relativePath,
        `Failed to read directory: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );

    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (state.fileLimitReached || state.totalSizeLimitReached) {
      return;
    }

    const absolutePath = path.resolve(currentDirectory, entry.name);

    const relativePath = normalizeRelativePath(
      path.relative(root, absolutePath),
    );

    if (!isPathInside(root, absolutePath)) {
      state.warnings.push(
        createWarning(
          "SYMLINK_SKIPPED",
          relativePath,
          "Path leaves the repository root and was skipped.",
        ),
      );

      continue;
    }

    if (entry.isSymbolicLink()) {
      const resolvedPath = safeRealpath(absolutePath);

      if (!resolvedPath || !isPathInside(root, resolvedPath)) {
        state.warnings.push(
          createWarning(
            "SYMLINK_SKIPPED",
            relativePath,
            "Symlink skipped because it is outside the repository root or could not be resolved safely.",
          ),
        );
        continue;
      }

      state.warnings.push(
        createWarning(
          "SYMLINK_SKIPPED",
          relativePath,
          "Symlink skipped for scan safety.",
        ),
      );

      continue;
    }

    if (entry.isDirectory()) {
      if (shouldIgnoreDirectory(entry.name)) {
        continue;
      }

      walkDirectory(root, absolutePath, state, limits);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (state.files.length >= limits.maxFileCount) {
      state.fileLimitReached = true;

      state.warnings.push(
        createWarning(
          "FILE_LIMIT_REACHED",
          relativePath,
          `Maximum file count of ${limits.maxFileCount} reached.`,
        ),
      );

      return;
    }

    const stats = safeStat(absolutePath);

    if (!stats) {
      state.warnings.push(
        createWarning(
          "READ_ERROR",
          relativePath,
          "Unable to read file metadata.",
        ),
      );

      continue;
    }

    if (stats.size > limits.maxFileSizeBytes) {
      const repositoryFile = createRepositoryFile(
        root,
        absolutePath,
        relativePath,
        stats.size,
      );

      if (repositoryFile.category === "sensitive") {
        addCategorizedFile(state, repositoryFile);

        state.warnings.push(
          createWarning(
            "SENSITIVE_FILE",
            relativePath,
            "Sensitive file detected; contents were not read.",
          ),
        );
      }

      state.warnings.push(
        createWarning(
          "FILE_TOO_LARGE",
          relativePath,
          `File exceeds the maximum scan size of ${limits.maxFileSizeBytes} bytes; contents were not read.`,
        ),
      );

      continue;
    }

    if (state.totalBytesScanned + stats.size > limits.maxTotalBytes) {
      state.totalSizeLimitReached = true;

      state.warnings.push(
        createWarning(
          "TOTAL_SIZE_LIMIT_REACHED",
          relativePath,
          `Total scan size limit of ${limits.maxTotalBytes} bytes would be exceeded; scanning stopped.`,
        ),
      );

      return;
    }

    state.totalBytesScanned += stats.size;

    const repositoryFile = createRepositoryFile(
      root,
      absolutePath,
      relativePath,
      stats.size,
    );

    addCategorizedFile(state, repositoryFile);

    if (repositoryFile.category === "sensitive") {
      state.warnings.push(
        createWarning(
          "SENSITIVE_FILE",
          relativePath,
          "Sensitive file detected; contents were not read.",
        ),
      );
    }
  }
}

function createEmptyState(): InventoryState {
  return {
    files: [],
    warnings: [],
    extensions: {},
    lockfiles: [],
    configFiles: [],
    ciFiles: [],
    dockerFiles: [],

    sourceFileCount: 0,
    testFileCount: 0,
    configFileCount: 0,
    sensitiveFileCount: 0,

    totalBytesScanned: 0,

    fileLimitReached: false,
    totalSizeLimitReached: false,
  };
}

export function buildRepositoryInventory(
  projectRoot: string,
  options: { limits?: Partial<ScanLimits> } = {},
): RepositoryInventory {
  const root = safeRealpath(path.resolve(projectRoot));

  if (!root) {
    throw new Error(`Unable to resolve project root: ${projectRoot}`);
  }

  const rootStats = safeStat(root);

  if (!rootStats?.isDirectory()) {
    throw new Error(`Project root is not a directory: ${projectRoot}`);
  }

  const state = createEmptyState();

  const limits: ScanLimits = {
    ...DEFAULT_SCAN_LIMITS,
    ...options.limits,
  };

  walkDirectory(root, root, state, limits);

  state.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  state.lockfiles.sort();
  state.configFiles.sort();
  state.ciFiles.sort();
  state.dockerFiles.sort();

  const packageJson = state.files.find(
    (file) =>
      file.relativePath === "package.json" && file.category === "manifest",
  );

  return {
    root,

    files: state.files,

    sourceFileCount: state.sourceFileCount,
    testFileCount: state.testFileCount,
    configFileCount: state.configFileCount,
    sensitiveFileCount: state.sensitiveFileCount,

    extensions: state.extensions,

    hasPackageJson: Boolean(packageJson),
    hasLockfile: state.lockfiles.length > 0,

    packageJsonPath: packageJson?.absolutePath,

    lockfiles: state.lockfiles,
    configFiles: state.configFiles,
    ciFiles: state.ciFiles,
    dockerFiles: state.dockerFiles,

    totalBytesScanned: state.totalBytesScanned,

    warnings: state.warnings,
  };
}
