import { Global, Module } from '@nestjs/common';
import { ApprovalService } from '../approval/approval.service';
import { ToolEventBus } from './tool-event.bus';
import { ToolSessionContext } from './tool-session.context';

@Global()
@Module({
  providers: [ToolEventBus, ToolSessionContext, ApprovalService],
  exports: [ToolEventBus, ToolSessionContext, ApprovalService],
})
export class ToolSupportModule {}
