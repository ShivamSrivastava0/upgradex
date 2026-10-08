import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function getProductVersion(): string {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const packagePath = [
    "../package.json",
    "../../package.json",
    "../../../package.json",
  ]
    .map((relative) => path.resolve(directory, relative))
    .find((candidate) => fs.existsSync(candidate));
  if (!packagePath)
    throw new Error("Cannot find package metadata for UpgradeX.");
  const metadata: unknown = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !("version" in metadata) ||
    typeof metadata.version !== "string"
  ) {
    throw new Error("UpgradeX package metadata has no valid version.");
  }
  return metadata.version;
}
