import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class UrlAllowlistService {
  constructor(private readonly config: ConfigService) {}

  /** Hostnames from URL_ALLOWLIST. */
  getAllowedHosts(): string[] {
    const fromConfig =
      this.config.get<string[]>('security.urlAllowlist') ?? [];
    return [
      ...new Set(
        fromConfig.map((h) => h.toLowerCase().trim()).filter(Boolean),
      ),
    ];
  }

  isUrlAllowed(url: string): boolean {
    const host = this.hostnameFromUrl(url);
    if (!host) {
      return false;
    }

    const allowed = this.getAllowedHosts();
    return allowed.some(
      (entry) => host === entry || host.endsWith(`.${entry}`),
    );
  }

  /** Throws if navigation target is outside the allowlist. */
  assertUrlAllowed(url: string): void {
    if (!this.isUrlAllowed(url)) {
      throw new Error(
        `URL not allowlisted: ${url}. Add the host to URL_ALLOWLIST.`,
      );
    }
  }

  private hostnameFromUrl(raw: string | undefined): string | null {
    if (!raw?.trim()) {
      return null;
    }
    try {
      const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
      return parsed.hostname.toLowerCase();
    } catch {
      return null;
    }
  }
}
