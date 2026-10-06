import { Global, Module } from '@nestjs/common';
import { MODEL_RUN_CONFIG } from '@modules/model/external-model.types';
import { ApprovalService } from '../approval/approval.service';
import { ToolEventBus } from './tool-event.bus';
import { ToolSessionContext } from './tool-session.context';

@Global()
@Module({
  providers: [
    ToolEventBus,
    ToolSessionContext,
    ApprovalService,
    { provide: MODEL_RUN_CONFIG, useExisting: ToolSessionContext },
  ],
  exports: [
    ToolEventBus,
    ToolSessionContext,
    ApprovalService,
    MODEL_RUN_CONFIG,
  ],
})
export class ToolSupportModule {}
