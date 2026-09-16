export default () => {
  const geminiApiKey = process.env.GEMINI_API_KEY ?? '';
  syncGeminiProcessEnv(geminiApiKey);

  return {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parsePositiveInt(process.env.PORT, 3001),
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:3000',

  // Agent browser is always Browserbase cloud Chromium (no local Chromium mode).
  browserbase: {
    apiKey: process.env.BROWSERBASE_API_KEY ?? '',
    projectId: process.env.BROWSERBASE_PROJECT_ID ?? '',
  },

  gemini: {
    apiKey: geminiApiKey,
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
  
  redis: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parsePositiveInt(process.env.REDIS_PORT, 6379),
    password: process.env.REDIS_PASSWORD ?? '',
    sessionTtlSeconds: parsePositiveInt(process.env.SESSION_TTL_SECONDS, 3600),
  },
  
  security: {
    urlAllowlist: parseCsv(process.env.URL_ALLOWLIST, [
      'irs.gov',
      'www.irs.gov',
    ]),
    maxSessionsPerIp: parsePositiveInt(process.env.MAX_SESSIONS_PER_IP, 5),
    maxActionsPerSession: parsePositiveInt(
      process.env.MAX_ACTIONS_PER_SESSION,
      100,
    ),
    gatewayApiKey: process.env.GATEWAY_API_KEY ?? '',
    trustProxy: parseBoolean(process.env.TRUST_PROXY, false),
  },
  };
};

/** ADK + Stagehand read GEMINI_API_KEY / GOOGLE_API_KEY from process.env. */
function syncGeminiProcessEnv(apiKey: string): void {
  if (!apiKey) {
    return;
  }
  if (!process.env.GEMINI_API_KEY) {
    process.env.GEMINI_API_KEY = apiKey;
  }
  // @google/genai warns when both are set; keep a single canonical key.
  if (process.env.GOOGLE_API_KEY && process.env.GEMINI_API_KEY) {
    delete process.env.GOOGLE_API_KEY;
  }
}

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