import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { DeleteMode } from "./config.js";
import type { WorkspaceDocument } from "./workspace-memory.js";

export type SyncCleanupStatus = "none" | "skipped" | "archived" | "deleted";

export type SyncStateEntry = {
  path: string;
  sha256?: string;
  remoteId?: string;
  remoteUrl?: string;
  title?: string;
  status: "active" | "deleted";
  cleanupStatus: SyncCleanupStatus;
  lastIndexedAt?: string;
  lastRemovedAt?: string;
};

export type SyncStateServer = {
  updatedAt?: string;
  entries: Record<string, SyncStateEntry>;
};

type SyncStateFile = {
  version: 1;
  servers: Record<string, SyncStateServer>;
};

export type SyncPlanAction =
  | {
      type: "upsert";
      doc: WorkspaceDocument;
      previous?: SyncStateEntry;
      reason: "new" | "changed" | "restored";
    }
  | {
      type: "unchanged";
      doc: WorkspaceDocument;
      previous: SyncStateEntry;
    }
  | {
      type: "mark_deleted";
      entry: SyncStateEntry;
      reason: "removed";
    }
  | {
      type: "cleanup";
      entry: SyncStateEntry;
      mode: Exclude<DeleteMode, "ignore">;
      reason: "removed";
    }
  | {
      type: "noop_deleted";
      entry: SyncStateEntry;
    };

function createEmptyStateFile(): SyncStateFile {
  return {
    version: 1,
    servers: {},
  };
}

export function createEmptyServerState(): SyncStateServer {
  return {
    entries: {},
  };
}

function stateRootDir(): string {
  return process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
}

function workspaceKey(workspaceDir: string): string {
  return createHash("sha256").update(path.resolve(workspaceDir)).digest("hex").slice(0, 16);
}

export function resolveSyncStatePath(workspaceDir: string): string {
  return path.join(
    stateRootDir(),
    "memory",
    "brainfork",
    workspaceKey(workspaceDir),
    "sync-state.json",
  );
}

async function readStateFile(workspaceDir: string): Promise<SyncStateFile> {
  const statePath = resolveSyncStatePath(workspaceDir);
  let raw: string;
  try {
    raw = await fs.readFile(statePath, "utf-8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return createEmptyStateFile();
    }
    throw err;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<SyncStateFile>;
    if (parsed.version !== 1 || !parsed.servers || typeof parsed.servers !== "object") {
      return createEmptyStateFile();
    }
    return {
      version: 1,
      servers: parsed.servers,
    };
  } catch {
    console.warn(`[brainfork-openclaw] sync-state: failed to parse state file at ${statePath}, starting fresh`);
    return createEmptyStateFile();
  }
}

export async function loadServerState(
  workspaceDir: string,
  serverKey: string,
): Promise<SyncStateServer> {
  const file = await readStateFile(workspaceDir);
  return file.servers[serverKey] ?? createEmptyServerState();
}

const LOCK_TIMEOUT_MS = 30_000;
const LOCK_POLL_MS = 50;

async function acquireLock(lockDir: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await fs.mkdir(lockDir);
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;

      // Check if lock is stale
      try {
        const stat = await fs.stat(lockDir);
        if (Date.now() - stat.mtimeMs > LOCK_TIMEOUT_MS) {
          await fs.rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Lock disappeared between EEXIST and stat — retry
        continue;
      }

      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(`saveServerState: timed out waiting for lock at ${lockDir}`);
      }

      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
}

async function releaseLock(lockDir: string): Promise<void> {
  try {
    await fs.rm(lockDir, { recursive: true, force: true });
  } catch {
    // Ignore errors releasing lock
  }
}

export async function saveServerState(
  workspaceDir: string,
  serverKey: string,
  state: SyncStateServer,
): Promise<void> {
  const statePath = resolveSyncStatePath(workspaceDir);
  const lockDir = `${statePath}.lock`;
  const tmpPath = `${statePath}.tmp.${process.pid}.${Date.now()}`;

  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await acquireLock(lockDir);
  try {
    const file = await readStateFile(workspaceDir);
    file.servers[serverKey] = state;
    await fs.writeFile(tmpPath, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
    await fs.rename(tmpPath, statePath);
  } catch (err) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // temp file may not exist
    }
    throw err;
  } finally {
    await releaseLock(lockDir);
  }
}

export function buildSyncPlan(
  docs: WorkspaceDocument[],
  state: SyncStateServer,
  deleteMode: DeleteMode,
): SyncPlanAction[] {
  const actions: SyncPlanAction[] = [];
  const seenPaths = new Set<string>();

  for (const doc of docs.toSorted((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    seenPaths.add(doc.relativePath);
    const previous = state.entries[doc.relativePath];

    if (!previous) {
      actions.push({ type: "upsert", doc, reason: "new" });
      continue;
    }
    if (previous.status !== "active") {
      actions.push({ type: "upsert", doc, previous, reason: "restored" });
      continue;
    }
    if (previous.sha256 !== doc.sha256) {
      actions.push({ type: "upsert", doc, previous, reason: "changed" });
      continue;
    }
    actions.push({ type: "unchanged", doc, previous });
  }

  for (const relativePath of Object.keys(state.entries).toSorted((left, right) =>
    left.localeCompare(right),
  )) {
    if (seenPaths.has(relativePath)) {
      continue;
    }

    const entry = state.entries[relativePath];
    if (deleteMode === "ignore") {
      if (entry.status === "deleted" && entry.cleanupStatus === "skipped") {
        actions.push({ type: "noop_deleted", entry });
      } else {
        actions.push({ type: "mark_deleted", entry, reason: "removed" });
      }
      continue;
    }

    const desiredCleanupStatus = deleteMode === "archive" ? "archived" : "deleted";
    if (entry.status === "deleted" && entry.cleanupStatus === desiredCleanupStatus) {
      actions.push({ type: "noop_deleted", entry });
      continue;
    }

    actions.push({
      type: "cleanup",
      entry,
      mode: deleteMode,
      reason: "removed",
    });
  }

  return actions;
}

function cloneState(state: SyncStateServer): SyncStateServer {
  return {
    updatedAt: state.updatedAt,
    entries: { ...state.entries },
  };
}

export function applyUpsertResult(
  state: SyncStateServer,
  doc: WorkspaceDocument,
  metadata: { remoteId?: string; remoteUrl?: string; title?: string } = {},
): SyncStateServer {
  const next = cloneState(state);
  const timestamp = new Date().toISOString();
  next.updatedAt = timestamp;
  next.entries[doc.relativePath] = {
    path: doc.relativePath,
    sha256: doc.sha256,
    remoteId: metadata.remoteId ?? next.entries[doc.relativePath]?.remoteId,
    remoteUrl: metadata.remoteUrl ?? next.entries[doc.relativePath]?.remoteUrl,
    title: metadata.title ?? next.entries[doc.relativePath]?.title ?? path.basename(doc.relativePath),
    status: "active",
    cleanupStatus: "none",
    lastIndexedAt: timestamp,
  };
  return next;
}

export function applyRemovedResult(
  state: SyncStateServer,
  entry: SyncStateEntry,
  cleanupStatus: Exclude<SyncCleanupStatus, "none">,
): SyncStateServer {
  const next = cloneState(state);
  const timestamp = new Date().toISOString();
  next.updatedAt = timestamp;
  next.entries[entry.path] = {
    ...entry,
    status: "deleted",
    cleanupStatus,
    lastRemovedAt: timestamp,
  };
  return next;
}

export function summarizeSyncState(state: SyncStateServer): {
  active: number;
  deleted: number;
  archived: number;
  skipped: number;
} {
  let active = 0;
  let deleted = 0;
  let archived = 0;
  let skipped = 0;

  for (const entry of Object.values(state.entries)) {
    if (entry.status === "active") {
      active += 1;
      continue;
    }
    deleted += 1;
    if (entry.cleanupStatus === "archived") {
      archived += 1;
    }
    if (entry.cleanupStatus === "skipped") {
      skipped += 1;
    }
  }

  return { active, deleted, archived, skipped };
}
