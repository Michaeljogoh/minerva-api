import { forwardRef, Module } from '@nestjs/common';
import { PersistenceModule } from '@modules/persistence/persistence.module';
import { RedisModule } from '@modules/redis/redis.module';
import { BrowserSessionFactory } from './browser-session.factory';
import { BrowserSessionRegistry } from './browser-session.registry';
import { BrowserbaseManager } from './browserbase.manager';
import { ScreenshotStore } from './screenshot.store';

@Module({
  imports: [RedisModule, forwardRef(() => PersistenceModule)],
  providers: [
    BrowserSessionRegistry,
    BrowserSessionFactory,
    BrowserbaseManager,
    ScreenshotStore,
  ],
  exports: [BrowserbaseManager, ScreenshotStore],
})
export class BrowserModule {}
