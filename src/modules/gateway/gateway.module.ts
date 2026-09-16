import { forwardRef, Module } from '@nestjs/common';
import { AgentModule } from '@modules/agent/agent.module';
import { BrowserModule } from '@modules/browser/browser.module';
import { PersistenceModule } from '@modules/persistence/persistence.module';
import { AgentGateway } from './agent.gateway';
import { GatewayEventBridge } from './gateway-event.bridge';
import { TaskRunCoordinator } from './task-run.coordinator';

@Module({
  imports: [
    forwardRef(() => AgentModule),
    forwardRef(() => BrowserModule),
    PersistenceModule,
  ],
  providers: [AgentGateway, GatewayEventBridge, TaskRunCoordinator],
  exports: [AgentGateway],
})
export class GatewayModule {}
