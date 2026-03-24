import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEmptyServerState,
  loadServerState,
  saveServerState,
  applyUpsertResult,
  resolveSyncStatePath,
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
