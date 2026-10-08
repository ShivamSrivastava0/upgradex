import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const metadata = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const missing = [];
const realRoot = fs.realpathSync(root);

function isSafeRegularFile(candidate) {
  try {
    const entry = fs.lstatSync(candidate);
    if (!entry.isFile() || entry.isSymbolicLink()) return false;
    const realPath = fs.realpathSync(candidate);
    const relative = path.relative(realRoot, realPath);
    return (
      relative !== "" &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative) &&
      fs.statSync(realPath).isFile()
    );
  } catch {
    return false;
  }
}

if (
  typeof metadata.license !== "string" ||
  !metadata.license.trim() ||
  metadata.license.trim().toUpperCase() === "UNLICENSED"
) {
  missing.push(
    "package.json license (choose an owner-approved public license)",
  );
} else if (metadata.license.startsWith("SEE LICENSE IN ")) {
  const relative = metadata.license.slice("SEE LICENSE IN ".length);
  const licensePath = path.resolve(root, relative);
  if (!isSafeRegularFile(licensePath)) {
    missing.push(`the custom license file named by package.json (${relative})`);
  }
} else if (
  !["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING", "COPYING.txt"].some(
    (name) => isSafeRegularFile(path.join(root, name)),
  )
) {
  missing.push("a LICENSE or COPYING file matching package.json license");
}

const authorName =
  typeof metadata.author === "string"
    ? metadata.author.trim()
    : metadata.author && typeof metadata.author.name === "string"
      ? metadata.author.name.trim()
      : "";
if (!authorName) missing.push("package.json author/maintainer name");

const repositoryUrl =
  typeof metadata.repository === "string"
    ? metadata.repository
    : metadata.repository && typeof metadata.repository.url === "string"
      ? metadata.repository.url
      : "";
if (!repositoryUrl || !/^(?:git\+)?https:\/\//i.test(repositoryUrl)) {
  missing.push("package.json repository URL (public HTTPS URL)");
}

if (missing.length) {
  process.stderr.write(
    `Public release preflight blocked. Add the following owner-approved metadata:\n${missing.map((item) => `  - ${item}`).join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write("Public release metadata is complete.\n");
}
