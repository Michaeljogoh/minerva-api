export default () => {
  return {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parsePositiveInt(process.env.PORT, 3001),
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:3000',

  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? '',
    model: process.env.OPENAI_MODEL ?? 'gpt-5.6-luna',
    plannerModel:
      process.env.OPENAI_PLANNER_MODEL?.trim() ||
      process.env.OPENAI_MODEL?.trim() ||
      'gpt-5.6-luna',
    reasoningEffort: process.env.OPENAI_REASONING_EFFORT?.trim() ?? '',
    stagehandModel:
      process.env.OPENAI_STAGEHAND_MODEL?.trim() ||
      toStagehandModelId(
        process.env.OPENAI_MODEL?.trim() || 'gpt-5.6-luna',
      ),
  },

  /** Bring-your-own-key: users run jobs on their own OpenAI or Gemini key. */
  byok: {
    enabled: parseBoolean(process.env.BYOK_ENABLED, false),
    openaiModels: parseCsv(process.env.BYOK_OPENAI_MODELS, []),
    geminiModels: parseCsv(process.env.BYOK_GEMINI_MODELS, []),
    geminiBaseUrl:
      process.env.GEMINI_OPENAI_BASE_URL?.trim() ||
      'https://generativelanguage.googleapis.com/v1beta/openai/',
    verifyTimeoutMs: parsePositiveInt(process.env.BYOK_VERIFY_TIMEOUT_MS, 10_000),
  },

  steel: {
    apiKey: process.env.STEEL_API_KEY ?? '',
  },

  pinecone: {
    apiKey: process.env.PINECONE_API_KEY ?? '',
    index: process.env.PINECONE_INDEX ?? '',
    dimension: parsePositiveInt(process.env.PINECONE_DIMENSION, 1536),
  },

  database: {
    url: process.env.DATABASE_URL ?? '',
    host: process.env.DB_HOST ?? 'localhost',
    port: parsePositiveInt(process.env.DB_PORT, 5432),
    username: process.env.DB_USER ?? '',
    password: process.env.DB_PASSWORD ?? '',
    name: process.env.DB_NAME ?? 'minerva_agent',
    synchronize: (process.env.NODE_ENV ?? 'development') === 'development',
    logging: (process.env.NODE_ENV ?? 'development') === 'development',
  },
  
  /** Redis stays off for now (in-memory session store). */
  redis: {
    enabled: false,
    url: 'redis://localhost:6379',
    host: 'localhost',
    port: 6379,
    password: '',
    sessionTtlSeconds: 3600,
  },
  
  security: {
    urlPolicyMode:
      (process.env.URL_POLICY_MODE ?? 'public').trim().toLowerCase() ===
      'allowlist'
        ? 'allowlist'
        : 'public',
    urlAllowlist: parseCsv(process.env.URL_ALLOWLIST, []),
    maxSessionsPerIp: parsePositiveInt(process.env.MAX_SESSIONS_PER_IP, 5),
    maxActionsPerSession: parsePositiveInt(
      process.env.MAX_ACTIONS_PER_SESSION,
      100,
    ),
    maxKeyChecksPerMinute: parsePositiveInt(
      process.env.MAX_KEY_CHECKS_PER_MINUTE,
      10,
    ),
    gatewayApiKey: process.env.GATEWAY_API_KEY ?? '',
    trustProxy: parseBoolean(process.env.TRUST_PROXY, false),
  },

  /** User accounts (Clerk). Tokens are verified against the issuer's JWKS. */
  auth: {
    issuer: process.env.AUTH_ISSUER?.trim() ?? '',
    jwksUrl: process.env.AUTH_JWKS_URL?.trim() ?? '',
    audience: process.env.AUTH_AUDIENCE?.trim() ?? '',
  },

  composio: {
    apiKey: process.env.COMPOSIO_API_KEY ?? '',
    userIdPrefix: process.env.COMPOSIO_USER_ID_PREFIX?.trim() || 'minerva:',
    /** Shopify has no Composio-managed OAuth app; this is your own auth config. */
    shopifyAuthConfigId: process.env.COMPOSIO_SHOPIFY_AUTH_CONFIG_ID?.trim() ?? '',
    /** Where the OAuth popup lands after the user approves. */
    callbackUrl:
      process.env.COMPOSIO_CALLBACK_URL?.trim() ||
      `${process.env.FRONTEND_URL ?? 'http://localhost:3000'}/app/connected`,
  },
  };
};

/** Stagehand expects `openai/<id>` while the Chat Completions API uses bare ids. */
const toStagehandModelId = (model: string): string => {
  const trimmed = model.trim();
  if (!trimmed) {
    return 'openai/gpt-5.6-luna';
  }
  return trimmed.startsWith('openai/') ? trimmed : `openai/${trimmed}`;
};

const parseCsv = (value: string | undefined, fallback: string[]): string[] => {
  if (!value?.trim()) {
    return fallback;
  }
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
};

const parsePositiveInt = (
  value: string | undefined,
  fallback: number,
): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseBoolean = (
  value: string | undefined,
  fallback: boolean,
): boolean => {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  return fallback;
};
