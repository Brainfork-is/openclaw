import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "./index.js";
import { brainforkConfigSchema } from "./src/config.js";
import {
  applyRemovedResult,
  applyUpsertResult,
  buildSyncPlan,
  createEmptyServerState,
  loadServerState,
  resolveSyncStatePath,
  saveServerState,
} from "./src/sync-state.js";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `brainfork-openclaw-${Date.now()}-${Math.random()}`);
  tempDirs.push(dir);
  return fs.mkdir(dir, { recursive: true }).then(() => dir);
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("brainfork-openclaw config", () => {
  it("parses required fields and applies defaults", () => {
    const config = brainforkConfigSchema.parse({
      baseUrl: "https://api.brainfork.is",
      endpoint: "memory-server",
      apiKey: "bfk_123",
    });

    expect(config.autoRecall).toBe(true);
    expect(config.autoIndex).toBe(true);
    expect(config.captureDecisions).toBe(true);
    expect(config.maxResults).toBe(5);
    expect(config.similarityThreshold).toBe(0.2);
    expect(config.maxTokens).toBe(600);
    expect(config.deleteMode).toBe("archive");
    expect(config.requestTimeoutMs).toBe(20_000);
  });
});

describe("brainfork-openclaw package contract", () => {
  it("keeps installable metadata compatible with openclaw plugins install", async () => {
    const packageJson = JSON.parse(
      await fs.readFile(new URL("./package.json", import.meta.url), "utf-8"),
    ) as Record<string, unknown>;
    const manifest = JSON.parse(
      await fs.readFile(new URL("./openclaw.plugin.json", import.meta.url), "utf-8"),
    ) as Record<string, unknown>;

    expect(packageJson.main).toBe("./dist/index.js");
    expect(packageJson.types).toBe("./dist/index.d.ts");
    expect(packageJson.scripts).toMatchObject({
      build: "tsc -p ./tsconfig.json",
      prepack: "npm run clean && npm run build",
      test: "vitest run --config ./vitest.config.ts ./index.test.ts",
    });
    expect(packageJson.dependencies).toMatchObject({
      openclaw: expect.not.stringContaining("workspace:"),
    });
    expect((packageJson.devDependencies as Record<string, string>).openclaw).toBeUndefined();
    expect(packageJson.openclaw).toMatchObject({
      extensions: ["./dist/index.js"],
      install: {
        npmSpec: "@brainfork/brainfork-openclaw",
        localPath: "extensions/brainfork-openclaw",
        defaultChoice: "npm",
      },
    });
    expect((manifest.uiHints as Record<string, unknown>).similarityThreshold).toBeTruthy();
    expect((manifest.uiHints as Record<string, unknown>).requestTimeoutMs).toBeTruthy();
    expect(path.basename(String(packageJson.main))).toBe("index.js");
  });

  it("ships the built extension entry and README for publishing", async () => {
    const distEntry = new URL("./dist/index.js", import.meta.url);
    const readme = new URL("./README.md", import.meta.url);
    const manifest = new URL("./openclaw.plugin.json", import.meta.url);

    await expect(fs.access(distEntry)).resolves.toBeUndefined();
    await expect(fs.access(readme)).resolves.toBeUndefined();
    await expect(fs.access(manifest)).resolves.toBeUndefined();
  });
});

describe("brainfork-openclaw plugin registration", () => {
  it("registers expected tools, hooks, CLI, and service", () => {
    const registeredTools: Array<{ name?: string; names?: string[] }> = [];
    const registeredHooks: string[] = [];
    const registeredCli: string[][] = [];
    const registeredServices: string[] = [];

    plugin.register({
      id: "brainfork-openclaw",
      name: "Brainfork Memory",
      source: "test",
      config: {},
      pluginConfig: {
        baseUrl: "https://api.brainfork.is",
        endpoint: "memory-server",
        apiKey: "bfk_123",
      },
      runtime: {} as never,
      logger: {
        info() {},
        warn() {},
        error() {},
        debug() {},
      },
      registerTool(_tool, opts) {
        registeredTools.push(opts ?? {});
      },
      registerHook() {},
      registerHttpHandler() {},
      registerHttpRoute() {},
      registerChannel() {},
      registerGatewayMethod() {},
      registerCli(_registrar, opts) {
        registeredCli.push(opts?.commands ?? []);
      },
      registerService(service) {
        registeredServices.push(service.id);
      },
      registerProvider() {},
      registerCommand() {},
      resolvePath(input: string) {
        return input;
      },
      on(hookName) {
        registeredHooks.push(hookName);
      },
    } as never);

    expect(registeredTools.map((entry) => entry.name)).toEqual([
      "brainfork_search",
      "brainfork_fetch",
      "brainfork_get_decisions",
      "brainfork_log_decision",
      "brainfork_push_document",
    ]);
    expect(registeredCli).toContainEqual(["brainfork"]);
    expect(registeredHooks).toContain("before_agent_start");
    expect(registeredHooks).toContain("agent_end");
    expect(registeredServices).toContain("brainfork-openclaw");
  });
});

describe("brainfork-openclaw sync state", () => {
  it("builds deterministic plans for changed, new, unchanged, and removed docs", () => {
    let state = createEmptyServerState();
    state = applyUpsertResult(state, {
      absolutePath: "/tmp/MEMORY.md",
      relativePath: "MEMORY.md",
      content: "old",
      sha256: "hash-old",
    });
    state = applyUpsertResult(state, {
      absolutePath: "/tmp/memory/old.md",
      relativePath: "memory/old.md",
      content: "remove me",
      sha256: "hash-remove",
    });

    const actions = buildSyncPlan(
      [
        {
          absolutePath: "/tmp/MEMORY.md",
          relativePath: "MEMORY.md",
          content: "new",
          sha256: "hash-new",
        },
        {
          absolutePath: "/tmp/memory/new.md",
          relativePath: "memory/new.md",
          content: "fresh",
          sha256: "hash-fresh",
        },
      ],
      state,
      "archive",
    );

    expect(actions.map((action) => action.type)).toEqual(["upsert", "upsert", "cleanup"]);
    expect(actions[0]).toMatchObject({ type: "upsert", reason: "changed" });
    expect(actions[1]).toMatchObject({ type: "upsert", reason: "new" });
    expect(actions[2]).toMatchObject({
      type: "cleanup",
      mode: "archive",
      entry: { path: "memory/old.md" },
    });
  });

  it("retries ignored tombstones when deleteMode changes", () => {
    const ignoredState = applyRemovedResult(
      createEmptyServerState(),
      {
        path: "memory/deleted.md",
        sha256: "hash-deleted",
        status: "active",
        cleanupStatus: "none",
      },
      "skipped",
    );

    const actions = buildSyncPlan([], ignoredState, "delete");
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: "cleanup",
      mode: "delete",
      entry: { path: "memory/deleted.md", cleanupStatus: "skipped" },
    });
  });

  it("persists per-server state to disk", async () => {
    const workspaceDir = await makeTempDir();
    let state = createEmptyServerState();
    state = applyUpsertResult(state, {
      absolutePath: path.join(workspaceDir, "MEMORY.md"),
      relativePath: "MEMORY.md",
      content: "alpha",
      sha256: "hash-alpha",
    }, { remoteId: "doc-1" });

    await saveServerState(workspaceDir, "https://api.brainfork.is/server-a", state);

    const loaded = await loadServerState(workspaceDir, "https://api.brainfork.is/server-a");
    expect(loaded.entries["MEMORY.md"]?.remoteId).toBe("doc-1");
    expect(loaded.entries["MEMORY.md"]?.status).toBe("active");
  });

  it("stores sync state under the global openclaw memory directory", async () => {
    const workspaceDir = await makeTempDir();
    const statePath = resolveSyncStatePath(workspaceDir);

    expect(statePath).toContain(`${path.sep}.openclaw${path.sep}memory${path.sep}brainfork${path.sep}`);
    expect(statePath.endsWith(`${path.sep}sync-state.json`)).toBe(true);
    expect(statePath.includes(workspaceDir)).toBe(false);
  });
});
