import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lookup } from 'dns/promises';
import { isIP } from 'net';

@Injectable()
export class UrlAllowlistService {
  constructor(private readonly config: ConfigService) {}

  policyMode(): 'public' | 'allowlist' {
    const mode = this.config.get<string>('security.urlPolicyMode');
    return mode === 'allowlist' ? 'allowlist' : 'public';
  }

  /** Optional deployment lock-down hosts from URL_ALLOWLIST. */
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
    const parsed = this.publicHttpUrl(url);
    if (!parsed) {
      return false;
    }

    const host = parsed.hostname.toLowerCase();
    if (this.hasUnsafeHostSyntax(host)) {
      return false;
    }
    if (isIP(host) && this.isUnsafeAddress(host)) {
      return false;
    }

    if (this.policyMode() !== 'allowlist') {
      return true;
    }

    const allowed = this.getAllowedHosts();
    return allowed.length > 0 && this.hostMatches(host, allowed);
  }

  /** Throws if navigation target is outside the public-web policy. */
  async assertUrlAllowed(url: string): Promise<void> {
    const parsed = this.publicHttpUrl(url);
    if (!parsed) {
      throw new Error(
        `Blocked URL: ${url}. Use a public http/https website.`,
      );
    }

    const host = parsed.hostname.toLowerCase();
    if (this.policyMode() === 'allowlist') {
      const allowed = this.getAllowedHosts();
      if (allowed.length === 0 || !this.hostMatches(host, allowed)) {
        throw new Error(
          `URL not allowed by deployment policy: ${url}. Add the host to URL_ALLOWLIST.`,
        );
      }
    }

    if (this.hasUnsafeHostSyntax(host)) {
      throw new Error(`Blocked unsafe host: ${host}`);
    }

    const records = await this.resolveHost(host);
    if (records.some((address) => this.isUnsafeAddress(address))) {
      throw new Error(`Blocked private or internal host: ${host}`);
    }
  }

  private publicHttpUrl(raw: string | undefined): URL | null {
    if (!raw?.trim()) {
      return null;
    }
    try {
      const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return null;
      }
      if (parsed.username || parsed.password) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private hostMatches(host: string, allowed: string[]): boolean {
    return allowed.some(
      (entry) => host === entry || host.endsWith(`.${entry}`),
    );
  }

  private hasUnsafeHostSyntax(host: string): boolean {
    const normalized = host.toLowerCase().replace(/\.$/, '');
    return (
      normalized === 'localhost' ||
      normalized.endsWith('.localhost') ||
      normalized.endsWith('.local')
    );
  }

  private async resolveHost(host: string): Promise<string[]> {
    if (isIP(host)) {
      return [host];
    }
    const records = await lookup(host, { all: true, verbatim: true });
    return records.map((record) => record.address);
  }

  private isUnsafeAddress(address: string): boolean {
    const ipVersion = isIP(address);
    if (ipVersion === 4) {
      return this.isUnsafeIpv4(address);
    }
    if (ipVersion === 6) {
      return this.isUnsafeIpv6(address);
    }
    return true;
  }

  private isUnsafeIpv4(address: string): boolean {
    const parts = address.split('.').map((part) => Number.parseInt(part, 10));
    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
      return true;
    }
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 2) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      a >= 224
    );
  }

  private isUnsafeIpv6(address: string): boolean {
    const normalized = address.toLowerCase();
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80:') ||
      normalized.startsWith('::ffff:127.') ||
      normalized.startsWith('::ffff:10.') ||
      normalized.startsWith('::ffff:192.168.')
    );
  }
}
