/** Stagehand page action timeout (navigate, act, observe, extract). */
export const STAGEHAND_ACTION_TIMEOUT_MS = 30_000;

/** Keep browser open after done so humans can inspect live session. */
export const BROWSER_DEFERRED_CLOSE_MS = 30_000;

/** Human approval window (ask_human). */
export const APPROVAL_TTL_MS = 5 * 60 * 1000;

/** Gateway poll interval for single-step idle timeout. */
export const STEP_WATCH_INTERVAL_MS = 15_000;
