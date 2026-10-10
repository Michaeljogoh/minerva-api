import { Global, Module } from '@nestjs/common';
import { PersistenceModule } from '@modules/persistence/persistence.module';
import { ConnectionsController } from './connections.controller';
import { ComposioService } from './composio.service';

@Global()
@Module({
  imports: [PersistenceModule],
  controllers: [ConnectionsController],
  providers: [ComposioService],
  exports: [ComposioService],
})
export class ComposioModule {}
