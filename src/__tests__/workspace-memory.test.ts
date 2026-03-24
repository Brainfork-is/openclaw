import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectWorkspaceDocuments, MAX_FILE_SIZE, resolveWorkspaceDir } from "../workspace-memory.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-memory-test-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("resolveWorkspaceDir", () => {
  it("returns null for undefined input (no cwd fallback)", () => {
    expect(resolveWorkspaceDir(undefined)).toBeNull();
  });

  it("returns null for empty string (no cwd fallback)", () => {
    expect(resolveWorkspaceDir("")).toBeNull();
  });

  it("returns null for whitespace-only string (no cwd fallback)", () => {
    expect(resolveWorkspaceDir("   ")).toBeNull();
  });

  it("resolves a valid path to absolute form", () => {
    const result = resolveWorkspaceDir("/tmp/some-workspace");
    expect(result).toBe("/tmp/some-workspace");
    expect(path.isAbsolute(result!)).toBe(true);
  });
});

describe("collectWorkspaceDocuments file size guardrails", () => {
  it("exports MAX_FILE_SIZE constant (512 KB)", () => {
    expect(MAX_FILE_SIZE).toBe(512 * 1024);
  });

  it("includes files within the size limit", async () => {
    const memoryFile = path.join(tmpDir, "MEMORY.md");
    await fs.writeFile(memoryFile, "# Memory\n\nSome content here.", "utf-8");

    const docs = await collectWorkspaceDocuments(tmpDir);
    expect(docs).toHaveLength(1);
    expect(docs[0].relativePath).toBe("MEMORY.md");
  });

  it("skips files that exceed MAX_FILE_SIZE with a warning", async () => {
    const memoryFile = path.join(tmpDir, "MEMORY.md");
    // Write a file slightly over the limit
    const oversizedContent = "x".repeat(MAX_FILE_SIZE + 1);
    await fs.writeFile(memoryFile, oversizedContent, "utf-8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const docs = await collectWorkspaceDocuments(tmpDir);

    expect(docs).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("exceeds"));
  });

  it("skips unreadable files and continues syncing the rest", async () => {
    // Create two files: one readable, one that will fail to read
    const memoryFile = path.join(tmpDir, "MEMORY.md");
    await fs.writeFile(memoryFile, "# Memory", "utf-8");

    const memDir = path.join(tmpDir, "memory");
    await fs.mkdir(memDir, { recursive: true });
    const badFile = path.join(memDir, "bad.md");
    await fs.writeFile(badFile, "# Bad file", "utf-8");

    // Spy on fs.readFile to simulate a read error for the bad file
    const origReadFile = fs.readFile.bind(fs);
    const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation(
      async (filePath: unknown, ...args: unknown[]) => {
        if (String(filePath) === badFile) {
          throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        }
        return (origReadFile as (...args: unknown[]) => unknown)(filePath, ...args) as Promise<string>;
      },
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const docs = await collectWorkspaceDocuments(tmpDir);

    readFileSpy.mockRestore();

    // The readable file should still be collected
    expect(docs.some((d) => d.relativePath === "MEMORY.md")).toBe(true);
    // The bad file should be skipped
    expect(docs.some((d) => d.relativePath === "memory/bad.md")).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("could not read"));
  });
});
