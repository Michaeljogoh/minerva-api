import { Global, Module } from '@nestjs/common';
import { MODEL_PROVIDER } from './model-provider';
import { OpenAiProvider } from './openai.provider';

@Global()
@Module({
  providers: [
    OpenAiProvider,
    { provide: MODEL_PROVIDER, useExisting: OpenAiProvider },
  ],
  exports: [MODEL_PROVIDER, OpenAiProvider],
})
export class ModelModule {}
