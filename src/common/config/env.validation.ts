/**
 * Boot validation. Secrets may be empty in test; development and production
 * require OPENAI_API_KEY so the agent + Stagehand can run.
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
    if (!String(config.OPENAI_API_KEY ?? '').trim()) {
      throw new Error(
        'OPENAI_API_KEY is required. Add it to .env — create a key at https://platform.openai.com/api-keys',
      );
    }
    if (!String(config.OPENAI_MODEL ?? '').trim()) {
      throw new Error('OPENAI_MODEL is required.');
    }
  }

  if (nodeEnv === 'production') {
    const required = [
      'STEEL_API_KEY',
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
