import { forwardRef, Module } from '@nestjs/common';
import { BrowserModule } from '@modules/browser/browser.module';
import { ComposioModule } from '@modules/composio/composio.module';
import { ModelModule } from '@modules/model/model.module';
import { PersistenceModule } from '@modules/persistence/persistence.module';
import { RagModule } from '@modules/rag/rag.module';
import { BrowserAgent } from './browser.agent';
import { PlannerAgent } from './planner/planner.agent';
import { TaskControlService } from './task/task-control.service';
import { StagehandToolsService } from './tools/stagehand.tools';
import { ToolSupportModule } from './tools/tool-support.module';
import { ToolCallingOrchestrator } from './orchestrator/tool-calling.orchestrator';

@Module({
  imports: [
    ModelModule,
    RagModule,
    PersistenceModule,
    forwardRef(() => BrowserModule),
    ToolSupportModule,
    ComposioModule,
  ],
  providers: [
    BrowserAgent,
    PlannerAgent,
    StagehandToolsService,
    TaskControlService,
    ToolCallingOrchestrator,
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
