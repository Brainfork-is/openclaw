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
export type SyncPlanAction = {
    type: "upsert";
    doc: WorkspaceDocument;
    previous?: SyncStateEntry;
    reason: "new" | "changed" | "restored";
} | {
    type: "unchanged";
    doc: WorkspaceDocument;
    previous: SyncStateEntry;
} | {
    type: "mark_deleted";
    entry: SyncStateEntry;
    reason: "removed";
} | {
    type: "cleanup";
    entry: SyncStateEntry;
    mode: Exclude<DeleteMode, "ignore">;
    reason: "removed";
} | {
    type: "noop_deleted";
    entry: SyncStateEntry;
};
export declare function createEmptyServerState(): SyncStateServer;
export declare function resolveSyncStatePath(workspaceDir: string): string;
export declare function loadServerState(workspaceDir: string, serverKey: string): Promise<SyncStateServer>;
export declare function saveServerState(workspaceDir: string, serverKey: string, state: SyncStateServer): Promise<void>;
export declare function buildSyncPlan(docs: WorkspaceDocument[], state: SyncStateServer, deleteMode: DeleteMode): SyncPlanAction[];
export declare function applyUpsertResult(state: SyncStateServer, doc: WorkspaceDocument, metadata?: {
    remoteId?: string;
    remoteUrl?: string;
    title?: string;
}): SyncStateServer;
export declare function applyRemovedResult(state: SyncStateServer, entry: SyncStateEntry, cleanupStatus: Exclude<SyncCleanupStatus, "none">): SyncStateServer;
export declare function summarizeSyncState(state: SyncStateServer): {
    active: number;
    deleted: number;
    archived: number;
    skipped: number;
};
