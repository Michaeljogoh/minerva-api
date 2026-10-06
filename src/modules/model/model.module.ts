import { Global, Module } from '@nestjs/common';
import { ExternalModelService } from './external-model.service';
import { ModelController } from './model.controller';
import { MODEL_PROVIDER } from './model-provider';
import { OpenAiProvider } from './openai.provider';

@Global()
@Module({
  controllers: [ModelController],
  providers: [
    OpenAiProvider,
    ExternalModelService,
    { provide: MODEL_PROVIDER, useExisting: OpenAiProvider },
  ],
  exports: [MODEL_PROVIDER, OpenAiProvider, ExternalModelService],
})
export class ModelModule {}
