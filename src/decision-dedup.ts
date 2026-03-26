import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const DEDUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEDUP_FILE = path.join(os.homedir(), ".openclaw", "memory", "brainfork", "decision-fingerprints.json");

type FingerprintStore = Record<string, number>;

/** Generate a SHA-256 fingerprint for a decision */
export function decisionFingerprint(decision: { decisionMade: string; reasoning: string }): string {
  const normalized = `${decision.decisionMade}::${decision.reasoning}`
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalized).digest("hex");
}

async function loadFingerprints(): Promise<FingerprintStore> {
  try {
    const raw = await fs.readFile(DEDUP_FILE, "utf-8");
    return JSON.parse(raw) as FingerprintStore;
  } catch {
    return {};
  }
}

async function saveFingerprints(store: FingerprintStore): Promise<void> {
  await fs.mkdir(path.dirname(DEDUP_FILE), { recursive: true });
  await fs.writeFile(DEDUP_FILE, JSON.stringify(store), "utf-8");
}

/** Check if a decision was already logged. If not, records its fingerprint. */
export async function isDuplicateDecision(decision: { decisionMade: string; reasoning: string }): Promise<boolean> {
  const fingerprint = decisionFingerprint(decision);
  const now = Date.now();
  const store = await loadFingerprints();

  // Prune old entries
  for (const [key, timestamp] of Object.entries(store)) {
    if (now - timestamp > DEDUP_WINDOW_MS) {
      delete store[key];
    }
  }

  if (store[fingerprint]) {
    return true;
  }
  store[fingerprint] = now;
  await saveFingerprints(store);
  return false;
}
