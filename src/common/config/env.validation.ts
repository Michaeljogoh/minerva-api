/**
 * Boot validation. Secrets may be empty in test; development and production
 * require GEMINI_API_KEY so ADK + Stagehand can run.
 */
export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const port = Number(config.PORT ?? 3001);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error('PORT must be a positive integer');
  }

  const nodeEnv = String(config.NODE_ENV ?? 'development');
  const allowedEnvs = new Set(['development', 'test', 'production']);
  if (!allowedEnvs.has(nodeEnv)) {
    throw new Error(
      `NODE_ENV must be one of: ${[...allowedEnvs].join(', ')}`,
    );
  }

  if (nodeEnv !== 'test') {
    if (!String(config.GEMINI_API_KEY ?? '').trim()) {
      throw new Error(
        'GEMINI_API_KEY is required. Add it to .env — create a key at https://aistudio.google.com/apikey',
      );
    }
  }

  if (nodeEnv === 'production') {
    const required = [
      'BROWSERBASE_API_KEY',
      'BROWSERBASE_PROJECT_ID',
      'FRONTEND_URL',
      'GATEWAY_API_KEY',
    ] as const;
    for (const key of required) {
      if (!String(config[key] ?? '').trim()) {
        throw new Error(`${key} is required when NODE_ENV=production`);
      }
    }
  }

  return config;
}
