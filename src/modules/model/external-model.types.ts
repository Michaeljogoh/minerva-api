import { z } from 'zod';

export const EXTERNAL_MODEL_PROVIDERS = ['openai', 'gemini'] as const;

export type ExternalModelProvider = (typeof EXTERNAL_MODEL_PROVIDERS)[number];

/** Wire shape from the client; validated against policy before use. */
export const externalModelInputSchema = z.object({
  provider: z.enum(EXTERNAL_MODEL_PROVIDERS),
  model: z.string().trim().min(1).max(100),
  apiKey: z.string().trim().min(1).max(300),
});

export type ExternalModelInput = z.infer<typeof externalModelInputSchema>;

/** A user-supplied model + key, held in memory for one run only. Never persisted. */
export interface ExternalModelConfig {
  provider: ExternalModelProvider;
  model: string;
  apiKey: string;
}

export type ExternalModelCheck =
  { ok: true; config: ExternalModelConfig } | { ok: false; error: string };

export interface ExternalModelOptions {
  enabled: boolean;
  models: Record<ExternalModelProvider, string[]>;
}

/** Resolves the external model for the run executing in the current async scope. */
export interface ModelRunConfigSource {
  getExternalModel(): ExternalModelConfig | null;
}

export const MODEL_RUN_CONFIG = Symbol('MODEL_RUN_CONFIG');

export const EXTERNAL_PROVIDER_LABEL: Record<ExternalModelProvider, string> = {
  openai: 'OpenAI',
  gemini: 'Gemini',
};
