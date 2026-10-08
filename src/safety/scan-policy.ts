export interface ScanLimits {
  maxFileSizeBytes: number;
  maxFileCount: number;
  maxTotalBytes: number;
}

export const DEFAULT_SCAN_LIMITS: Readonly<ScanLimits> = {
  // Build-Guide-inspired default.
  maxFileSizeBytes: 2 * 1024 * 1024,
  maxFileCount: 50_000,
  maxTotalBytes: 500 * 1024 * 1024,
};

export interface ScanWarning {
  code:
    | "SYMLINK_SKIPPED"
    | "SENSITIVE_FILE"
    | "FILE_TOO_LARGE"
    | "FILE_LIMIT_REACHED"
    | "TOTAL_SIZE_LIMIT_REACHED"
    | "READ_ERROR";

  relativePath: string;
  message: string;
}

export function hasCriticalScanGaps(
  warnings: ScanWarning[],
  blindSpots: Array<{ code: string }>,
): boolean {
  const incompleteWarnings = warnings.some((warning) => {
    if (
      warning.code === "FILE_LIMIT_REACHED" ||
      warning.code === "TOTAL_SIZE_LIMIT_REACHED" ||
      warning.code === "READ_ERROR"
    )
      return true;
    return (
      warning.code === "FILE_TOO_LARGE" &&
      (/\.(?:[cm]?[jt]sx?)$/i.test(warning.relativePath) ||
        /(?:^|[\\/])package\.json$/i.test(warning.relativePath))
    );
  });
  return (
    incompleteWarnings ||
    blindSpots.some((spot) =>
      ["SOURCE_UNREADABLE", "PARSE_FAILURE"].includes(spot.code),
    )
  );
}
