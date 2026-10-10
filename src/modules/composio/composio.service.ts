import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AppConnectionStatus,
  UserAppConnectionEntity,
} from '@modules/persistence/entities/user-app-connection.entity';

const COMPOSIO_API = 'https://backend.composio.dev/api/v3';
const REQUEST_TIMEOUT_MS = 20_000;

/** OAuth callbacks can land a moment after the user approves. */
const CONNECTION_POLL_INTERVAL_MS = 1500;
const CONNECTION_POLL_TIMEOUT_MS = 12_000;
const ACCOUNT_CACHE_TTL_MS = 30_000;

/**
 * Toolkits that have no Composio auth config yet keep the old live-browser
 * login. Shopify is deliberately absent: it is OAuth-only.
 */
const LEGACY_LOGIN_URLS: Record<string, string> = {
  stripe: 'https://dashboard.stripe.com/login',
  quickbooks: 'https://qbo.intuit.com',
  gmail: 'https://mail.google.com',
  googledrive: 'https://drive.google.com',
  slack: 'https://app.slack.com',
};

/** Read-only action slugs the agent may run per toolkit. Anything else is refused. */
const READ_ONLY_ACTIONS: Record<string, RegExp> = {
  shopify: /^SHOPIFY_(GET|COUNT|LIST|SEARCH)_[A-Z0-9_]+$/,
};

export type ComposioConnectResult =
  | {
      mode: 'composio';
      connectUrl: string;
      toolkit: string;
      connectedAccountId: string | null;
    }
  | { mode: 'browser_login'; loginUrl: string; toolkit: string; reason: string }
  | { mode: 'unavailable'; toolkit: string; reason: string };

export interface AppConnectionSummary {
  toolkit: string;
  status: AppConnectionStatus;
  metadata: Record<string, string>;
  updatedAt: Date;
}

interface ComposioAccountRow {
  id?: string;
  status?: string;
  toolkit?: { slug?: string };
}

@Injectable()
export class ComposioService {
  private readonly logger = new Logger(ComposioService.name);
  private readonly accountCache = new Map<
    string,
    { id: string | null; at: number }
  >();

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(UserAppConnectionEntity)
    private readonly connections: Repository<UserAppConnectionEntity>,
  ) {}

  isEnabled(): boolean {
    return Boolean(this.apiKey());
  }

  /** Composio's id for one of our users, so each account has its own connections. */
  composioUserId(userId: string): string {
    const prefix = this.config.get<string>('composio.userIdPrefix') ?? 'minerva:';
    return `${prefix}${userId}`;
  }

  /** True when this toolkit connects through Composio OAuth (has an auth config). */
  supportsOAuth(toolkit: string): boolean {
    return Boolean(this.authConfigId(this.normalizeToolkit(toolkit)));
  }

  loginUrlFor(toolkit: string): string {
    return LEGACY_LOGIN_URLS[this.normalizeToolkit(toolkit)] ?? '';
  }

  /**
   * Start a connection for one user. Shopify needs the store handle, passed
   * to Composio as `subdomain`.
   */
  async requestAccess(
    userId: string,
    toolkit: string,
    connectionData: Record<string, string> = {},
  ): Promise<ComposioConnectResult> {
    const normalized = this.normalizeToolkit(toolkit);

    if (!this.supportsOAuth(normalized)) {
      const loginUrl = this.loginUrlFor(normalized);
      if (!loginUrl) {
        return {
          mode: 'unavailable',
          toolkit: normalized,
          reason: `${normalized} cannot be connected yet.`,
        };
      }
      return {
        mode: 'browser_login',
        loginUrl,
        toolkit: normalized,
        reason: `${normalized} has no secure connection set up yet — sign in on the live browser.`,
      };
    }

    try {
      const link = await this.createConnectLink(
        userId,
        normalized,
        connectionData,
      );
      await this.saveConnection(userId, normalized, {
        status: 'pending',
        composioAccountId: link.connectedAccountId,
        metadata: connectionData,
      });
      this.accountCache.delete(this.cacheKey(userId, normalized));
      return {
        mode: 'composio',
        connectUrl: link.redirectUrl,
        toolkit: normalized,
        connectedAccountId: link.connectedAccountId,
      };
    } catch (err) {
      this.logger.warn(
        `Composio connect failed for ${normalized}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return {
        mode: 'unavailable',
        toolkit: normalized,
        reason: `Could not start a secure ${normalized} connection. Try again in a moment.`,
      };
    }
  }

  /** ACTIVE connected account id for this user and toolkit, or null. */
  async findActiveAccountId(
    userId: string,
    toolkit: string,
  ): Promise<string | null> {
    if (!this.isEnabled()) {
      return null;
    }
    const normalized = this.normalizeToolkit(toolkit);
    const key = this.cacheKey(userId, normalized);
    const cached = this.accountCache.get(key);
    if (cached && Date.now() - cached.at < ACCOUNT_CACHE_TTL_MS) {
      return cached.id;
    }

    try {
      const query = new URLSearchParams({
        user_ids: this.composioUserId(userId),
        toolkit_slugs: normalized,
        statuses: 'ACTIVE',
        limit: '10',
      });
      const response = await this.api(`/connected_accounts?${query}`);
      if (!response.ok) {
        return null;
      }
      const payload = (await response.json()) as {
        items?: ComposioAccountRow[];
      };
      // Exact match only; a pending link is INITIATED and does not count.
      const row = (payload.items ?? []).find(
        (item) =>
          item.toolkit?.slug?.toLowerCase() === normalized &&
          (item.status ?? '').toUpperCase() === 'ACTIVE',
      );
      const id = row?.id ?? null;
      this.accountCache.set(key, { id, at: Date.now() });
      if (id) {
        await this.saveConnection(userId, normalized, {
          status: 'active',
          composioAccountId: id,
        });
      }
      return id;
    } catch (err) {
      this.logger.warn(
        `Composio status check failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  async isConnected(userId: string, toolkit: string): Promise<boolean> {
    return (await this.findActiveAccountId(userId, toolkit)) !== null;
  }

  /** Poll until the user has an ACTIVE connection or the timeout passes. */
  async waitUntilConnected(
    userId: string,
    toolkit: string,
    timeoutMs = CONNECTION_POLL_TIMEOUT_MS,
  ): Promise<boolean> {
    const normalized = this.normalizeToolkit(toolkit);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // Skip the cache: the point is to notice a change.
      this.accountCache.delete(this.cacheKey(userId, normalized));
      if (await this.isConnected(userId, normalized)) {
        return true;
      }
      if (Date.now() + CONNECTION_POLL_INTERVAL_MS > deadline) {
        return false;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, CONNECTION_POLL_INTERVAL_MS),
      );
    }
  }

  async getStoredConnection(
    userId: string,
    toolkit: string,
  ): Promise<UserAppConnectionEntity | null> {
    return this.connections.findOne({
      where: { userId, toolkit: this.normalizeToolkit(toolkit) },
    });
  }

  async listConnections(userId: string): Promise<AppConnectionSummary[]> {
    const rows = await this.connections.find({
      where: { userId },
      order: { toolkit: 'ASC' },
    });
    const summaries: AppConnectionSummary[] = [];
    for (const row of rows) {
      // Composio is the source of truth for whether a token is still valid.
      const active = await this.isConnected(userId, row.toolkit);
      let status = row.status;
      if (!active && row.status === 'active') {
        status = 'disconnected';
        await this.saveConnection(userId, row.toolkit, { status });
      }
      summaries.push({
        toolkit: row.toolkit,
        status: active ? 'active' : status,
        metadata: row.metadata ?? {},
        updatedAt: row.updatedAt,
      });
    }
    return summaries;
  }

  async disconnect(userId: string, toolkit: string): Promise<boolean> {
    const normalized = this.normalizeToolkit(toolkit);
    const stored = await this.getStoredConnection(userId, normalized);
    const accountId =
      (await this.findActiveAccountId(userId, normalized)) ??
      stored?.composioAccountId ??
      null;

    if (accountId && this.isEnabled()) {
      try {
        const response = await this.api(`/connected_accounts/${accountId}`, {
          method: 'DELETE',
        });
        if (!response.ok && response.status !== 404) {
          this.logger.warn(
            `Composio disconnect ${normalized} failed (${response.status})`,
          );
          return false;
        }
      } catch (err) {
        this.logger.warn(
          `Composio disconnect failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
    }

    this.accountCache.delete(this.cacheKey(userId, normalized));
    if (stored) {
      await this.connections.delete({ id: stored.id });
    }
    return true;
  }

  async executeAction(params: {
    userId: string;
    toolkit: string;
    action: string;
    argumentsJson?: string;
  }): Promise<{ ok: boolean; data: unknown; observation: string }> {
    const toolkit = this.normalizeToolkit(params.toolkit);
    if (!this.isEnabled()) {
      return {
        ok: false,
        data: null,
        observation: 'Composio is not configured.',
      };
    }

    const allowed = READ_ONLY_ACTIONS[toolkit];
    if (!allowed || !allowed.test(params.action)) {
      return {
        ok: false,
        data: null,
        observation: `Action ${params.action} is not allowed for ${toolkit}. Only read-only actions are enabled.`,
      };
    }

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

    const accountId = await this.findActiveAccountId(params.userId, toolkit);
    if (!accountId) {
      return {
        ok: false,
        data: null,
        observation: `${toolkit} is not connected for this user.`,
      };
    }

    try {
      const response = await this.api(
        `/tools/execute/${encodeURIComponent(params.action)}`,
        {
          method: 'POST',
          body: JSON.stringify({
            connected_account_id: accountId,
            user_id: this.composioUserId(params.userId),
            arguments: parsedArgs,
          }),
        },
      );
      const bodyText = await response.text();
      let data: unknown = bodyText;
      try {
        data = JSON.parse(bodyText);
      } catch {
        // keep raw text
      }

      const reportedFailure =
        typeof data === 'object' &&
        data !== null &&
        (data as { successful?: boolean }).successful === false;
      if (!response.ok || reportedFailure) {
        return {
          ok: false,
          data,
          observation: `Composio ${params.action} failed (${response.status}): ${bodyText.slice(0, 400)}`,
        };
      }
      return {
        ok: true,
        data,
        observation: `Composio ${params.action} succeeded.`,
      };
    } catch (err) {
      return {
        ok: false,
        data: null,
        observation: `Composio ${params.action} request failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  normalizeToolkit(toolkit: string): string {
    const raw = toolkit.toLowerCase().replace(/[\s_-]/g, '');
    if (raw.includes('shopify')) return 'shopify';
    if (raw.includes('stripe')) return 'stripe';
    if (raw.includes('quickbooks') || raw === 'qbo') return 'quickbooks';
    if (raw.includes('gmail')) return 'gmail';
    if (raw.includes('drive') || raw.includes('google')) return 'googledrive';
    if (raw.includes('slack')) return 'slack';
    return raw;
  }

  private apiKey(): string {
    return this.config.get<string>('composio.apiKey')?.trim() ?? '';
  }

  private authConfigId(toolkit: string): string {
    if (toolkit === 'shopify') {
      return this.config.get<string>('composio.shopifyAuthConfigId') ?? '';
    }
    return '';
  }

  private cacheKey(userId: string, toolkit: string): string {
    return `${userId}:${toolkit}`;
  }

  private api(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${COMPOSIO_API}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey(),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  private async saveConnection(
    userId: string,
    toolkit: string,
    patch: {
      status?: AppConnectionStatus;
      composioAccountId?: string | null;
      metadata?: Record<string, string>;
    },
  ): Promise<void> {
    const existing = await this.connections.findOne({
      where: { userId, toolkit },
    });
    const row =
      existing ??
      this.connections.create({
        userId,
        toolkit,
        status: 'pending',
        composioAccountId: null,
        metadata: {},
      });
    if (patch.status) row.status = patch.status;
    if (patch.composioAccountId !== undefined) {
      row.composioAccountId = patch.composioAccountId;
    }
    if (patch.metadata && Object.keys(patch.metadata).length > 0) {
      row.metadata = { ...row.metadata, ...patch.metadata };
    }
    await this.connections.save(row);
  }

  private async createConnectLink(
    userId: string,
    toolkit: string,
    connectionData: Record<string, string>,
  ): Promise<{ redirectUrl: string; connectedAccountId: string | null }> {
    const body: Record<string, unknown> = {
      auth_config_id: this.authConfigId(toolkit),
      user_id: this.composioUserId(userId),
      callback_url: this.config.get<string>('composio.callbackUrl'),
    };
    if (Object.keys(connectionData).length > 0) {
      body.connection_data = connectionData;
    }

    const response = await this.api('/connected_accounts/link', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Composio link ${response.status}: ${text.slice(0, 240)}`);
    }
    const payload = (await response.json()) as {
      redirect_url?: string;
      connected_account_id?: string;
    };
    if (!payload.redirect_url) {
      throw new Error('Composio link response had no redirect_url');
    }
    return {
      redirectUrl: payload.redirect_url,
      connectedAccountId: payload.connected_account_id ?? null,
    };
  }
}
