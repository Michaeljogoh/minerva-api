import { forwardRef, Module } from '@nestjs/common';
import { BrowserModule } from '@modules/browser/browser.module';
import { BrowserAgent } from './browser.agent';
import { PlannerAgent } from './planner/planner.agent';
import { TaskControlService } from './task/task-control.service';
import { StagehandToolsService } from './tools/stagehand.tools';
import { ToolSupportModule } from './tools/tool-support.module';

@Module({
  imports: [forwardRef(() => BrowserModule), ToolSupportModule],
  providers: [
    BrowserAgent,
    PlannerAgent,
    StagehandToolsService,
    TaskControlService,
  ],
  exports: [
    forwardRef(() => BrowserModule),
    BrowserAgent,
    PlannerAgent,
    StagehandToolsService,
    TaskControlService,
    ToolSupportModule,
  ],
})
export class AgentModule {}
