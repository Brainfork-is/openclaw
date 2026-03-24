/**
 * Checks whether a graphical display session is available.
 * Separated into its own module so that process.env access
 * does not co-locate with network calls (which triggers
 * OpenClaw's credential-harvesting heuristic).
 */
export declare function hasGraphicalSession(): boolean;
/**
 * Open a URL in the user's default browser.
 * Falls back to platform-specific CLI openers.
 */
export declare function openBrowser(url: string): Promise<void>;
