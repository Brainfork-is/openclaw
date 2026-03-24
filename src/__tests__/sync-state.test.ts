import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyRemovedResult,
  applyUpsertResult,
  buildSyncPlan,
  createEmptyServerState,
  loadServerState,
  resolveSyncStatePath,
  saveServerState,
} from "../sync-state.js";

function makeDoc(relativePath: string, sha256 = "abc123") {
  return { relativePath, sha256, absolutePath: `/workspace/${relativePath}`, content: "# test" };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-state-test-"));
  process.env.OPENCLAW_STATE_DIR = tmpDir;
});

afterEach(async () => {
  delete process.env.OPENCLAW_STATE_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("buildSyncPlan with deleteMode='delete'", () => {
  it("emits cleanup(delete) actions for removed documents", () => {
    let state = createEmptyServerState();
    state = applyUpsertResult(state, makeDoc("memory/archived.md"), { remoteId: "remote-1" });

    // Document is now removed from workspace
    const actions = buildSyncPlan([], state, "delete");
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: "cleanup",
      mode: "delete",
      entry: { path: "memory/archived.md" },
    });
  });

  it("emits noop_deleted for already-deleted documents with delete cleanup", () => {
    let state = createEmptyServerState();
    state = applyUpsertResult(state, makeDoc("memory/gone.md"), { remoteId: "remote-2" });
    state = applyRemovedResult(state, state.entries["memory/gone.md"], "deleted");

    const actions = buildSyncPlan([], state, "delete");
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("noop_deleted");
  });

  it("upgrades skipped tombstones to cleanup(delete) when mode switches to delete", () => {
    let state = createEmptyServerState();
    state = applyUpsertResult(state, makeDoc("memory/skip.md"));
    // Was previously ignored (skipped cleanup)
    state = applyRemovedResult(state, state.entries["memory/skip.md"], "skipped");

    const actions = buildSyncPlan([], state, "delete");
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "cleanup", mode: "delete" });
  });
});

describe("saveServerState / loadServerState", () => {
  it("round-trips a simple state", async () => {
    const workspaceDir = path.join(tmpDir, "ws1");
    const serverKey = "server-a";
    let state = createEmptyServerState();
    state = applyUpsertResult(state, makeDoc("MEMORY.md"), { remoteId: "doc-1" });

    await saveServerState(workspaceDir, serverKey, state);
    const loaded = await loadServerState(workspaceDir, serverKey);

    expect(loaded.entries["MEMORY.md"]).toBeDefined();
    expect(loaded.entries["MEMORY.md"].remoteId).toBe("doc-1");
    expect(loaded.entries["MEMORY.md"].status).toBe("active");
  });

  it("preserves other server keys on write", async () => {
    const workspaceDir = path.join(tmpDir, "ws2");

    let stateA = createEmptyServerState();
    stateA = applyUpsertResult(stateA, makeDoc("a.md"), { remoteId: "id-a" });
    await saveServerState(workspaceDir, "server-a", stateA);

    let stateB = createEmptyServerState();
    stateB = applyUpsertResult(stateB, makeDoc("b.md"), { remoteId: "id-b" });
    await saveServerState(workspaceDir, "server-b", stateB);

    const reloadedA = await loadServerState(workspaceDir, "server-a");
    const reloadedB = await loadServerState(workspaceDir, "server-b");

    expect(reloadedA.entries["a.md"].remoteId).toBe("id-a");
    expect(reloadedB.entries["b.md"].remoteId).toBe("id-b");
  });

  it("concurrent writes to different server keys both survive (no data loss)", async () => {
    const workspaceDir = path.join(tmpDir, "ws-concurrent");

    // Build states for N different server keys
    const N = 8;
    const saves = Array.from({ length: N }, (_, i) => {
      let state = createEmptyServerState();
      state = applyUpsertResult(state, makeDoc(`doc-${i}.md`), { remoteId: `id-${i}` });
      return saveServerState(workspaceDir, `server-${i}`, state);
    });

    // All writes race concurrently
    await Promise.all(saves);

    // Every server key must be present in the final file
    for (let i = 0; i < N; i++) {
      const loaded = await loadServerState(workspaceDir, `server-${i}`);
      expect(loaded.entries[`doc-${i}.md`], `server-${i} lost its entry`).toBeDefined();
      expect(loaded.entries[`doc-${i}.md`].remoteId).toBe(`id-${i}`);
    }
  });

  it("returns empty state when JSON is corrupt (graceful degradation)", async () => {
    const workspaceDir = path.join(tmpDir, "ws-corrupt");
    await saveServerState(workspaceDir, "server-a", createEmptyServerState());
    const statePath = resolveSyncStatePath(workspaceDir);

    // Overwrite the state file with garbage JSON
    await fs.writeFile(statePath, "{ this is not valid json", "utf-8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const loaded = await loadServerState(workspaceDir, "server-a");
      expect(loaded.entries).toEqual({});
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("corrupt JSON"));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("rethrows permission errors from readStateFile", async () => {
    const workspaceDir = path.join(tmpDir, "ws-perm");
    await saveServerState(workspaceDir, "server-a", createEmptyServerState());
    const statePath = resolveSyncStatePath(workspaceDir);

    // Simulate a permission error by spying on fs.readFile
    const origReadFile = fs.readFile.bind(fs);
    const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation(
      async (filePath: unknown, ...args: unknown[]) => {
        if (String(filePath) === statePath) {
          const err = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
          throw err;
        }
        return (origReadFile as (...args: unknown[]) => unknown)(filePath, ...args) as Promise<string>;
      },
    );

    try {
      await expect(loadServerState(workspaceDir, "server-a")).rejects.toThrow("EACCES");
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it("leaves no temp or lock files after a successful save", async () => {
    const workspaceDir = path.join(tmpDir, "ws-cleanup");
    let state = createEmptyServerState();
    state = applyUpsertResult(state, makeDoc("MEMORY.md"), { remoteId: "x" });
    await saveServerState(workspaceDir, "server-a", state);

    const statePath = resolveSyncStatePath(workspaceDir);
    const stateDir = path.dirname(statePath);
    const files = await fs.readdir(stateDir);
    const leftover = files.filter((f) => f.endsWith(".lock") || f.endsWith(".tmp"));
    expect(leftover).toHaveLength(0);
  });
});
