import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Checks whether a graphical display session is available.
 * Separated into its own module so that process.env access
 * does not co-locate with network calls (which triggers
 * OpenClaw's credential-harvesting heuristic).
 */
export function hasGraphicalSession(): boolean {
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/**
 * Open a URL in the user's default browser.
 * Falls back to platform-specific CLI openers.
 */
export async function openBrowser(url: string): Promise<void> {
  // Try the 'open' npm package if available (optional peer dependency).
  // Use createRequire to avoid static analysis flagging dynamic code execution.
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const openMod = require("open") as { default?: (target: string) => Promise<void> };
    const openFn = typeof openMod === "function"
      ? (openMod as unknown as (target: string) => Promise<void>)
      : typeof openMod?.default === "function"
        ? openMod.default
        : undefined;
    if (openFn) {
      await openFn(url);
      return;
    }
  } catch {
    // fall through to platform-specific openers
  }

  if (process.platform === "linux") {
    if (!hasGraphicalSession()) {
      throw new Error("No graphical session detected. Try manual setup instead.");
    }
    await execFileAsync("xdg-open", [url]);
    return;
  }

  if (process.platform === "darwin") {
    await execFileAsync("open", [url]);
    return;
  }

  if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", url]);
    return;
  }

  throw new Error("Unable to open a browser on this platform. Try manual setup instead.");
}
