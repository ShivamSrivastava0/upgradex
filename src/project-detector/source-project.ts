import { Project } from "ts-morph";
import type { RepositoryInventory } from "./types.js";
import { readProjectTextFile } from "../safety/safe-file-reader.js";

export function createSourceProject(inventory: RepositoryInventory): Project {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      skipLibCheck: true,
      target: 99,
    },
  });
  for (const file of inventory.files) {
    if (
      (file.category !== "source" && file.category !== "test") ||
      !/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file.relativePath)
    )
      continue;
    const read = readProjectTextFile(inventory.root, file.relativePath);
    if (!read.ok || read.content === undefined) continue;
    try {
      project.createSourceFile(file.absolutePath, read.content, {
        overwrite: true,
      });
    } catch {
      // The analyzer reports the unreadable or unindexable file as a blind spot.
    }
  }
  return project;
}
