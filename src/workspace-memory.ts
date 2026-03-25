import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type WorkspaceDocument = {
  absolutePath: string;
  relativePath: string;
  content: string;
  sha256: string;
};

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function toPortableRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

async function walkMarkdownFiles(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkMarkdownFiles(absolutePath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(absolutePath);
    }
  }

  return files;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024; // 1 MB

export async function collectWorkspaceDocuments(workspaceDir: string): Promise<WorkspaceDocument[]> {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const absolutePaths: string[] = [];
  const memoryFile = path.join(resolvedWorkspaceDir, "MEMORY.md");
  if (await pathExists(memoryFile)) {
    absolutePaths.push(memoryFile);
  }

  const memoryDir = path.join(resolvedWorkspaceDir, "memory");
  if (await pathExists(memoryDir)) {
    absolutePaths.push(...(await walkMarkdownFiles(memoryDir)));
  }

  const deduped = Array.from(new Set(absolutePaths)).toSorted((left, right) =>
    left.localeCompare(right),
  );

  const documents: WorkspaceDocument[] = [];
  for (const absolutePath of deduped) {
    try {
      const stat = await fs.stat(absolutePath);
      if (stat.size > MAX_FILE_SIZE_BYTES) {
        continue;
      }
      const content = await fs.readFile(absolutePath, "utf-8");
      documents.push({
        absolutePath,
        relativePath: toPortableRelativePath(path.relative(resolvedWorkspaceDir, absolutePath)),
        content,
        sha256: hashContent(content),
      });
    } catch {
      // skip unreadable files so one bad file doesn't abort the whole collection
    }
  }

  return documents;
}

export function resolveWorkspaceDir(workspaceDir?: string): string | null {
  const target = workspaceDir?.trim();
  return target ? path.resolve(target) : null;
}
