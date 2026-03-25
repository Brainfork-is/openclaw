import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  saveServerState,
  loadServerState,
  createEmptyServerState,
  resolveSyncStatePath,
  buildSyncPlan,
  applyUpsertResult,
  applyRemovedResult,
} from "../sync-state.js";
import type { WorkspaceDocument } from "../workspace-memory.js";

// Redirect state dir to a temp directory for all tests
let tmpDir: string;
let origStateDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-state-test-"));
  origStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = tmpDir;
});

afterEach(async () => {
  if (origStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = origStateDir;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeDoc(relativePath: string, content: string): WorkspaceDocument {
  const { createHash } = require("node:crypto");
  const sha256 = createHash("sha256").update(content).digest("hex");
  return { relativePath, content, sha256 };
}

// ---------------------------------------------------------------------------
// Atomic write: temp file + rename
// ---------------------------------------------------------------------------
describe("saveServerState – atomic writes", () => {
  it("produces the state file with correct content", async () => {
    const wsDir = path.join(tmpDir, "ws-atomic");
    const serverKey = "test-server";
    const state = applyUpsertResult(createEmptyServerState(), makeDoc("MEMORY.md", "hello"), {
      remoteId: "r1",
    });

    await saveServerState(wsDir, serverKey, state);

    const loaded = await loadServerState(wsDir, serverKey);
    expect(loaded.entries["MEMORY.md"]).toBeDefined();
    expect(loaded.entries["MEMORY.md"].remoteId).toBe("r1");
    expect(loaded.entries["MEMORY.md"].status).toBe("active");
  });

  it("leaves no temp files behind after a successful write", async () => {
    const wsDir = path.join(tmpDir, "ws-noleak");
    await saveServerState(wsDir, "srv", createEmptyServerState());

    const stateDir = path.dirname(resolveSyncStatePath(wsDir));
    const files = await fs.readdir(stateDir);
    const tmpFiles = files.filter((f) => f.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Lock acquisition and release
// ---------------------------------------------------------------------------
describe("saveServerState – locking", () => {
  it("removes the lock directory after a successful save", async () => {
    const wsDir = path.join(tmpDir, "ws-lock");
    await saveServerState(wsDir, "srv", createEmptyServerState());

    const lockDir = `${resolveSyncStatePath(wsDir)}.lock`;
    const lockExists = await fs.access(lockDir).then(() => true).catch(() => false);
    expect(lockExists).toBe(false);
  });

  it("removes the lock directory even after an unexpected error", async () => {
    const wsDir = path.join(tmpDir, "ws-lock-err");
    // Create the state dir so mkdir in saveServerState doesn't fail, but make the
    // state file unreadable — this causes an error inside the lock.
    const statePath = resolveSyncStatePath(wsDir);
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, "not-valid-json", "utf-8");
    // corrupted JSON causes readStateFile to return empty state (no throw), so
    // let's instead make the state file a directory to force a write error.
    await fs.unlink(statePath);
    await fs.mkdir(statePath);

    await expect(saveServerState(wsDir, "srv", createEmptyServerState())).rejects.toThrow();

    const lockDir = `${statePath}.lock`;
    const lockExists = await fs.access(lockDir).then(() => true).catch(() => false);
    expect(lockExists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Concurrent saveServerState calls don't lose data
// ---------------------------------------------------------------------------
describe("saveServerState – concurrency", () => {
  it("does not lose data when called concurrently for different serverKeys", async () => {
    const wsDir = path.join(tmpDir, "ws-concurrent");

    const stateA = applyUpsertResult(createEmptyServerState(), makeDoc("A.md", "aaa"), { remoteId: "rA" });
    const stateB = applyUpsertResult(createEmptyServerState(), makeDoc("B.md", "bbb"), { remoteId: "rB" });

    await Promise.all([
      saveServerState(wsDir, "server-a", stateA),
      saveServerState(wsDir, "server-b", stateB),
    ]);

    const loadedA = await loadServerState(wsDir, "server-a");
    const loadedB = await loadServerState(wsDir, "server-b");

    expect(loadedA.entries["A.md"]?.remoteId).toBe("rA");
    expect(loadedB.entries["B.md"]?.remoteId).toBe("rB");
  });

  it("does not lose data when called concurrently for the same serverKey", async () => {
    const wsDir = path.join(tmpDir, "ws-concurrent-same");
    const serverKey = "shared-server";

    // Sequential baseline: save doc1, then doc2
    const state1 = applyUpsertResult(createEmptyServerState(), makeDoc("one.md", "one"), { remoteId: "r1" });
    await saveServerState(wsDir, serverKey, state1);

    // Now fire two concurrent saves with different docs
    const state2 = applyUpsertResult(
      await loadServerState(wsDir, serverKey),
      makeDoc("two.md", "two"),
      { remoteId: "r2" },
    );
    const state3 = applyUpsertResult(
      await loadServerState(wsDir, serverKey),
      makeDoc("three.md", "three"),
      { remoteId: "r3" },
    );

    await Promise.all([
      saveServerState(wsDir, serverKey, state2),
      saveServerState(wsDir, serverKey, state3),
    ]);

    // one.md was in the state before both concurrent writes; it must still be there
    const final = await loadServerState(wsDir, serverKey);
    expect(final.entries["one.md"]?.remoteId).toBe("r1");
  });
});

// ---------------------------------------------------------------------------
// buildSyncPlan basics
// ---------------------------------------------------------------------------
describe("buildSyncPlan", () => {
  it("emits upsert(new) for documents not in state", () => {
    const doc = makeDoc("MEMORY.md", "hello");
    const plan = buildSyncPlan([doc], createEmptyServerState(), "ignore");
    expect(plan).toHaveLength(1);
    expect(plan[0].type).toBe("upsert");
    if (plan[0].type === "upsert") {
      expect(plan[0].reason).toBe("new");
    }
  });

  it("emits unchanged for documents with matching sha256", () => {
    const doc = makeDoc("MEMORY.md", "hello");
    let state = createEmptyServerState();
    state = applyUpsertResult(state, doc);

    const plan = buildSyncPlan([doc], state, "ignore");
    expect(plan).toHaveLength(1);
    expect(plan[0].type).toBe("unchanged");
  });

  it("emits upsert(changed) when sha256 differs", () => {
    const docV1 = makeDoc("MEMORY.md", "v1");
    const docV2 = makeDoc("MEMORY.md", "v2");
    let state = createEmptyServerState();
    state = applyUpsertResult(state, docV1);

    const plan = buildSyncPlan([docV2], state, "ignore");
    expect(plan).toHaveLength(1);
    expect(plan[0].type).toBe("upsert");
    if (plan[0].type === "upsert") {
      expect(plan[0].reason).toBe("changed");
    }
  });

  it("emits mark_deleted for removed docs when deleteMode is ignore", () => {
    const doc = makeDoc("old.md", "gone");
    let state = createEmptyServerState();
    state = applyUpsertResult(state, doc);

    const plan = buildSyncPlan([], state, "ignore");
    expect(plan).toHaveLength(1);
    expect(plan[0].type).toBe("mark_deleted");
  });

  it("emits cleanup(archive) for removed docs when deleteMode is archive", () => {
    const doc = makeDoc("old.md", "gone");
    let state = createEmptyServerState();
    state = applyUpsertResult(state, doc);

    const plan = buildSyncPlan([], state, "archive");
    expect(plan).toHaveLength(1);
    expect(plan[0].type).toBe("cleanup");
    if (plan[0].type === "cleanup") {
      expect(plan[0].mode).toBe("archive");
    }
  });

  it("emits cleanup(delete) for removed docs when deleteMode is delete", () => {
    const doc = makeDoc("old.md", "gone");
    let state = createEmptyServerState();
    state = applyUpsertResult(state, doc);

    const plan = buildSyncPlan([], state, "delete");
    expect(plan).toHaveLength(1);
    expect(plan[0].type).toBe("cleanup");
    if (plan[0].type === "cleanup") {
      expect(plan[0].mode).toBe("delete");
    }
  });

  it("emits upsert(restored) for previously deleted docs that reappear", () => {
    const doc = makeDoc("MEMORY.md", "hello");
    let state = createEmptyServerState();
    state = applyUpsertResult(state, doc);
    state = applyRemovedResult(state, state.entries["MEMORY.md"], "archived");

    const plan = buildSyncPlan([doc], state, "archive");
    expect(plan).toHaveLength(1);
    expect(plan[0].type).toBe("upsert");
    if (plan[0].type === "upsert") {
      expect(plan[0].reason).toBe("restored");
    }
  });

  it("sorts actions by relativePath for deterministic ordering", () => {
    const docs = [makeDoc("z.md", "z"), makeDoc("a.md", "a"), makeDoc("m.md", "m")];
    const plan = buildSyncPlan(docs, createEmptyServerState(), "ignore");
    const paths = plan.map((a) => ("doc" in a ? a.doc.relativePath : "entry" in a ? a.entry.path : ""));
    expect(paths).toEqual(["a.md", "m.md", "z.md"]);
  });
});
