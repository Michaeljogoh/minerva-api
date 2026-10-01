import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const COMPOSIO_API = 'https://backend.composio.dev/api/v3';

const TOOLKIT_LOGIN_URLS: Record<string, string> = {
  shopify: 'https://admin.shopify.com',
  stripe: 'https://dashboard.stripe.com/login',
  gmail: 'https://mail.google.com',
  googledrive: 'https://drive.google.com',
  slack: 'https://app.slack.com',
};

export type ComposioConnectResult =
  | { mode: 'composio'; connectUrl: string; toolkit: string }
  | { mode: 'browser_login'; loginUrl: string; toolkit: string; reason: string };

@Injectable()
export class ComposioService {
  private readonly logger = new Logger(ComposioService.name);

  constructor(private readonly config: ConfigService) {}

  isEnabled(): boolean {
    return Boolean(this.config.get<string>('composio.apiKey')?.trim());
  }

  userId(): string {
    return this.config.get<string>('composio.userId') ?? 'minerva-demo';
  }

  loginUrlFor(toolkit: string): string {
    return TOOLKIT_LOGIN_URLS[toolkit.toLowerCase()] ?? '';
  }

  async requestAccess(toolkit: string): Promise<ComposioConnectResult> {
    const slug = toolkit.toLowerCase().replace(/[\s_-]/g, '');
    const normalized = this.normalizeToolkit(slug);
    const loginUrl = this.loginUrlFor(normalized);

    if (!this.isEnabled()) {
      return {
        mode: 'browser_login',
        loginUrl,
        toolkit: normalized,
        reason: 'COMPOSIO_API_KEY is not set — use live browser login.',
      };
    }

    try {
      const connectUrl = await this.createConnectLink(normalized);
      if (connectUrl) {
        return { mode: 'composio', connectUrl, toolkit: normalized };
      }
    } catch (err) {
      this.logger.warn(
        `Composio connect failed for ${normalized}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return {
      mode: 'browser_login',
      loginUrl,
      toolkit: normalized,
      reason: 'Composio could not start a secure connect link. Log in on the live browser instead.',
    };
  }

  async isConnected(toolkit: string): Promise<boolean> {
    if (!this.isEnabled()) {
      return false;
    }
    const normalized = this.normalizeToolkit(
      toolkit.toLowerCase().replace(/[\s_-]/g, ''),
    );
    try {
      const apiKey = this.config.get<string>('composio.apiKey') ?? '';
      const userId = this.userId();
      const response = await fetch(
        `${COMPOSIO_API}/connected_accounts?user_ids=${encodeURIComponent(userId)}`,
        { headers: { 'x-api-key': apiKey } },
      );
      if (!response.ok) {
        return false;
      }
      const payload = (await response.json()) as {
        items?: Array<{ toolkit?: { slug?: string }; status?: string }>;
        data?: Array<{ toolkit?: { slug?: string }; status?: string }>;
      };
      const rows = payload.items ?? payload.data ?? [];
      return rows.some((row) => {
        const slug = row.toolkit?.slug?.toLowerCase().replace(/[\s_-]/g, '') ?? '';
        return (
          slug.includes(normalized) &&
          (row.status ?? 'ACTIVE').toUpperCase() !== 'EXPIRED'
        );
      });
    } catch (err) {
      this.logger.warn(
        `Composio status check failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  async executeAction(params: {
    toolkit: string;
    action: string;
    argumentsJson?: string;
  }): Promise<{ ok: boolean; data: unknown; observation: string }> {
    if (!this.isEnabled()) {
      return {
        ok: false,
        data: null,
        observation:
          'Composio is not configured. Use the live browser or request_app_connection.',
      };
    }

    const apiKey = this.config.get<string>('composio.apiKey') ?? '';
    const userId = this.userId();
    let parsedArgs: Record<string, unknown> = {};
    if (params.argumentsJson?.trim()) {
      try {
        parsedArgs = JSON.parse(params.argumentsJson) as Record<string, unknown>;
      } catch {
        return {
          ok: false,
          data: null,
          observation: 'argumentsJson is not valid JSON',
        };
      }
    }

    const response = await fetch(`${COMPOSIO_API}/tools/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        tool_slug: params.action,
        arguments: parsedArgs,
        user_id: userId,
        toolkit: this.normalizeToolkit(
          params.toolkit.toLowerCase().replace(/[\s_-]/g, ''),
        ),
      }),
    });

    const bodyText = await response.text();
    let data: unknown = bodyText;
    try {
      data = JSON.parse(bodyText);
    } catch {
      // keep raw text
    }

    if (!response.ok) {
      return {
        ok: false,
        data,
        observation: `Composio execute failed (${response.status}): ${bodyText.slice(0, 400)}`,
      };
    }

    return {
      ok: true,
      data,
      observation: `Composio ${params.action} succeeded.`,
    };
  }

  private normalizeToolkit(raw: string): string {
    if (raw.includes('shopify')) return 'shopify';
    if (raw.includes('stripe')) return 'stripe';
    if (raw.includes('gmail')) return 'gmail';
    if (raw.includes('drive') || raw.includes('google')) return 'googledrive';
    if (raw.includes('slack')) return 'slack';
    return raw;
  }

  private async createConnectLink(toolkit: string): Promise<string | null> {
    const apiKey = this.config.get<string>('composio.apiKey') ?? '';
    const userId = this.userId();
    const response = await fetch(`${COMPOSIO_API}/connected_accounts/link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        user_id: userId,
        toolkit,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Composio link ${response.status}: ${body.slice(0, 240)}`);
    }

    const payload = (await response.json()) as {
      redirect_url?: string;
      redirectUrl?: string;
      connection_url?: string;
    };
    return (
      payload.redirect_url ??
      payload.redirectUrl ??
      payload.connection_url ??
      null
    );
  }
}
