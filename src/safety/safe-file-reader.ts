import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const DEFAULT_MAX_BYTES = 256 * 1024;

export interface SafeTextReadResult {
  ok: boolean;
  content?: string;
  warning?: string;
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

export function readProjectTextFile(
  projectRoot: string,
  relativePath: string,
  maxBytes = DEFAULT_MAX_BYTES,
): SafeTextReadResult {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    return {
      ok: false,
      warning: "INVALID_MAX_BYTES",
    };
  }

  let root: string;

  try {
    root = realpathSync(resolve(projectRoot));
  } catch {
    return {
      ok: false,
      warning: "PROJECT_ROOT_UNRESOLVED",
    };
  }

  const candidate = resolve(root, relativePath);

  if (!isPathInsideRoot(root, candidate)) {
    return {
      ok: false,
      warning: `PATH_OUTSIDE_PROJECT: ${relativePath}`,
    };
  }

  try {
    const entryStat = lstatSync(candidate);

    if (entryStat.isSymbolicLink()) {
      return {
        ok: false,
        warning: `SYMLINK_SKIPPED: ${relativePath}`,
      };
    }

    if (!entryStat.isFile()) {
      return {
        ok: false,
        warning: `NOT_A_FILE: ${relativePath}`,
      };
    }

    if (entryStat.size > maxBytes) {
      return {
        ok: false,
        warning: `FILE_TOO_LARGE: ${relativePath}`,
      };
    }

    const realCandidate = realpathSync(candidate);

    if (!isPathInsideRoot(root, realCandidate)) {
      return {
        ok: false,
        warning: `REALPATH_OUTSIDE_PROJECT: ${relativePath}`,
      };
    }

    const fd = openSync(realCandidate, "r");
    try {
      const openedStat = fstatSync(fd);
      // Reject a path replacement between lstat/realpath and opening the file.
      // Some Windows Node releases report lstat.dev as 0 while fstat.dev is set;
      // treat zero as unavailable and use the inode comparison instead.
      if (
        !openedStat.isFile() ||
        (entryStat.dev !== 0 &&
          openedStat.dev !== 0 &&
          openedStat.dev !== entryStat.dev) ||
        openedStat.ino !== entryStat.ino
      ) {
        return {
          ok: false,
          warning: `FILE_CHANGED_DURING_READ: ${relativePath}`,
        };
      }

      if (openedStat.size > maxBytes) {
        return {
          ok: false,
          warning: `FILE_TOO_LARGE: ${relativePath}`,
        };
      }

      const content = Buffer.allocUnsafe(maxBytes + 1);
      let bytesRead = 0;
      while (bytesRead < content.length) {
        const chunkSize = readSync(
          fd,
          content,
          bytesRead,
          content.length - bytesRead,
          bytesRead,
        );
        if (chunkSize === 0) break;
        bytesRead += chunkSize;
      }
      if (bytesRead > maxBytes) {
        return {
          ok: false,
          warning: `FILE_TOO_LARGE: ${relativePath}`,
        };
      }
      const afterReadStat = fstatSync(fd);
      if (
        bytesRead !== openedStat.size ||
        afterReadStat.size !== openedStat.size ||
        afterReadStat.mtimeMs !== openedStat.mtimeMs
      ) {
        return {
          ok: false,
          warning: `FILE_CHANGED_DURING_READ: ${relativePath}`,
        };
      }

      return {
        ok: true,
        content: content.subarray(0, bytesRead).toString("utf8"),
      };
    } finally {
      closeSync(fd);
    }
  } catch {
    return {
      ok: false,
      warning: `READ_ERROR: ${relativePath}`,
    };
  }
}
