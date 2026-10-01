/** Stagehand page action timeout (navigate, act, observe, extract). */
export const STAGEHAND_ACTION_TIMEOUT_MS = 30_000;

/**
 * Budget for Stagehand's internal DOM/network quiet wait (act) and our
 * post-navigation settle. Keep short — long waits dominate demo latency.
 */
export const STAGEHAND_DOM_SETTLE_MS = 2_500;

/** Brief pause after load so transient iframes can finish attaching/detaching. */
export const STAGEHAND_POST_NAV_QUIET_MS = 250;

/** Keep browser open after done so humans can inspect live session. */
export const BROWSER_DEFERRED_CLOSE_MS = 30_000;

/** Human approval window (ask_human). */
export const APPROVAL_TTL_MS = 5 * 60 * 1000;

/** Gateway poll interval for single-step idle timeout. */
export const STEP_WATCH_INTERVAL_MS = 15_000;

/** Min interval between client-initiated live-view debug URL refreshes. */
export const LIVE_VIEW_CLIENT_REFRESH_MIN_MS = 2_000;

/** Max wait for Browserbase sessions.debug + page URL resolution. */
export const LIVE_VIEW_FETCH_TIMEOUT_MS = 8_000;
