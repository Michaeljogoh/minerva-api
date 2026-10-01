import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SessionRecordEntity } from '@modules/persistence/entities/session-record.entity';
import { BrowserSessionFactory } from './browser-session.factory';
import { BrowserSessionManager } from './browser-session.manager';
import { BrowserSessionRegistry } from './browser-session.registry';
import { ScreenshotStore } from './screenshot.store';

@Module({
  imports: [TypeOrmModule.forFeature([SessionRecordEntity])],
  providers: [
    BrowserSessionRegistry,
    BrowserSessionFactory,
    BrowserSessionManager,
    ScreenshotStore,
  ],
  exports: [BrowserSessionManager, ScreenshotStore],
})
export class BrowserModule {}
