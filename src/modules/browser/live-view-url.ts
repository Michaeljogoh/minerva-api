export type LiveViewDebugInfo = {
  debuggerFullscreenUrl?: string | null;
  pages?: Array<{
    url?: string | null;
    debuggerFullscreenUrl?: string | null;
  }> | null;
};

function trimmed(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Pick the inspector URL for the page Stagehand is actually on.
 * Session-level debuggerFullscreenUrl is often pinned to about:blank.
 */
export function pickDebuggerFullscreenUrl(
  live: LiveViewDebugInfo,
  currentPageUrl?: string | null,
): string | null {
  const pages = live.pages ?? [];
  const current = trimmed(currentPageUrl);

  if (current) {
    const exact = pages.find(
      (page) => trimmed(page.url) === current && trimmed(page.debuggerFullscreenUrl),
    );
    const exactUrl = trimmed(exact?.debuggerFullscreenUrl);
    if (exactUrl) {
      return exactUrl;
    }

    const currentHost = hostnameOf(current);
    if (currentHost) {
      for (let i = pages.length - 1; i >= 0; i--) {
        const page = pages[i];
        const pageUrl = trimmed(page?.debuggerFullscreenUrl);
        if (!pageUrl) {
          continue;
        }
        if (hostnameOf(trimmed(page?.url)) === currentHost) {
          return pageUrl;
        }
      }
    }
  }

  for (let i = pages.length - 1; i >= 0; i--) {
    const pageUrl = trimmed(pages[i]?.debuggerFullscreenUrl);
    if (pageUrl) {
      return pageUrl;
    }
  }

  const sessionUrl = trimmed(live.debuggerFullscreenUrl);
  return sessionUrl || null;
}
