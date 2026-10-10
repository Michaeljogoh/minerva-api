/**
 * Shopify store handle parsing. The handle ends up in an OAuth URL, so it is
 * validated strictly: lowercase letters, digits and hyphens only.
 */
const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

/**
 * Accepts "acme", "acme.myshopify.com", "https://acme.myshopify.com/admin" or
 * "https://admin.shopify.com/store/acme" and returns "acme", or null when the
 * input is not a Shopify store handle (custom domains are rejected).
 */
export function parseShopifyHandle(input: string): string | null {
  const raw = input.trim().toLowerCase();
  if (!raw || raw.length > 300) {
    return null;
  }

  let candidate = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(raw) || raw.includes('/')) {
    let url: URL;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null;
    }
    if (url.hostname === 'admin.shopify.com') {
      const match = /^\/store\/([^/]+)/.exec(url.pathname);
      if (!match) {
        return null;
      }
      candidate = match[1];
    } else if (url.hostname.endsWith('.myshopify.com')) {
      candidate = url.hostname;
    } else {
      return null;
    }
  }

  if (candidate.endsWith('.myshopify.com')) {
    candidate = candidate.slice(0, -'.myshopify.com'.length);
  }
  return HANDLE_PATTERN.test(candidate) ? candidate : null;
}
