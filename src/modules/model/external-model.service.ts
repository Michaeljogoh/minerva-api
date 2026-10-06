import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import {
  EXTERNAL_PROVIDER_LABEL,
  type ExternalModelCheck,
  type ExternalModelConfig,
  type ExternalModelInput,
  type ExternalModelOptions,
  type ExternalModelProvider,
} from './external-model.types';

const KEY_PATTERNS: Record<ExternalModelProvider, RegExp> = {
  openai: /^sk-[A-Za-z0-9_-]{20,}$/,
  gemini: /^AIza[0-9A-Za-z_-]{30,}$/,
};

const SECRET_PATTERNS = [/sk-[A-Za-z0-9_*-]{8,}/g, /AIza[0-9A-Za-z_*-]{8,}/g];

/** Strip anything that looks like a provider key before text reaches logs or users. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (out, pattern) => out.replace(pattern, '[redacted key]'),
    text,
  );
}

@Injectable()
export class ExternalModelService {
  /** Keyed by the run's config object so clients are dropped when the run ends. */
  private readonly clients = new WeakMap<ExternalModelConfig, OpenAI>();

  constructor(private readonly config: ConfigService) {}

  getOptions(): ExternalModelOptions {
    const enabled = this.config.get<boolean>('byok.enabled') ?? false;
    return {
      enabled,
      models: {
        openai: enabled ? this.allowedModels('openai') : [],
        gemini: enabled ? this.allowedModels('gemini') : [],
      },
    };
  }

  /** Policy check (feature flag, allowlist, key shape) then a live call to the provider. */
  async check(input: ExternalModelInput): Promise<ExternalModelCheck> {
    const policy = this.validatePolicy(input);
    if (!policy.ok) {
      return policy;
    }
    try {
      await this.clientFor(policy.config).models.retrieve(policy.config.model, {
        timeout: this.config.get<number>('byok.verifyTimeoutMs') ?? 10_000,
        maxRetries: 0,
      });
      return policy;
    } catch (err) {
      return { ok: false, error: this.describeFailure(err, policy.config) };
    }
  }

  clientFor(config: ExternalModelConfig): OpenAI {
    let client = this.clients.get(config);
    if (!client) {
      client = new OpenAI({
        apiKey: config.apiKey,
        ...(config.provider === 'gemini'
          ? { baseURL: this.config.get<string>('byok.geminiBaseUrl') }
          : {}),
      });
      this.clients.set(config, client);
    }
    return client;
  }

  /**
   * Rewrite errors from a user-key call: auth and model failures get actionable
   * copy (and are not retried); everything else keeps its type for retry logic.
   */
  toRunError(err: unknown, config: ExternalModelConfig): unknown {
    if (isKeyRejected(err) || statusOf(err) === 404) {
      return new Error(this.describeFailure(err, config));
    }
    if (err instanceof Error) {
      err.message = redactSecrets(err.message);
    }
    return err;
  }

  private validatePolicy(input: ExternalModelInput): ExternalModelCheck {
    const label = EXTERNAL_PROVIDER_LABEL[input.provider];
    if (!this.getOptions().enabled) {
      return {
        ok: false,
        error: 'Using your own API key is turned off on this server.',
      };
    }
    if (!this.allowedModels(input.provider).includes(input.model)) {
      return {
        ok: false,
        error: `"${input.model}" isn't an available ${label} model. Pick one from the list.`,
      };
    }
    if (!KEY_PATTERNS[input.provider].test(input.apiKey)) {
      return {
        ok: false,
        error: `That doesn't look like your ${label} API key. Copy the full key and try again.`,
      };
    }
    return {
      ok: true,
      config: {
        provider: input.provider,
        model: input.model,
        apiKey: input.apiKey,
      },
    };
  }

  private allowedModels(provider: ExternalModelProvider): string[] {
    return (
      this.config.get<string[]>(
        provider === 'openai' ? 'byok.openaiModels' : 'byok.geminiModels',
      ) ?? []
    );
  }

  private describeFailure(err: unknown, config: ExternalModelConfig): string {
    const label = EXTERNAL_PROVIDER_LABEL[config.provider];
    if (isKeyRejected(err)) {
      return `Your ${label} API key was rejected. Check the key in Model settings or create a new one.`;
    }
    const status = statusOf(err);
    if (status === 404) {
      return `Your ${label} key can't use "${config.model}". Pick another model in Model settings.`;
    }
    if (status === 429) {
      return `Your ${label} key is out of credit or being throttled. Check billing with ${label}, then try again.`;
    }
    if (err instanceof OpenAI.APIConnectionError) {
      return `Couldn't reach ${label} to check the key. Try again in a moment.`;
    }
    const detail = err instanceof Error ? redactSecrets(err.message) : '';
    return detail
      ? `${label} couldn't verify the key: ${detail.slice(0, 160)}`
      : `${label} couldn't verify the key. Try again in a moment.`;
  }
}

function statusOf(err: unknown): number | undefined {
  if (!(err instanceof OpenAI.APIError)) {
    return undefined;
  }
  const status: unknown = err.status;
  return typeof status === 'number' ? status : undefined;
}

/** Gemini's OpenAI-compatible endpoint reports bad keys as 400 "API key not valid". */
function isKeyRejected(err: unknown): boolean {
  const status = statusOf(err);
  if (status === 401 || status === 403) {
    return true;
  }
  return (
    status === 400 &&
    err instanceof Error &&
    err.message.toLowerCase().includes('api key')
  );
}
