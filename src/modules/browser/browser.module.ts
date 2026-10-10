import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SessionRecordEntity } from '@modules/persistence/entities/session-record.entity';
import { UserBrowserProfileEntity } from '@modules/persistence/entities/user-browser-profile.entity';
import { BrowserLoginsController } from './browser-logins.controller';
import { BrowserSessionFactory } from './browser-session.factory';
import { BrowserSessionManager } from './browser-session.manager';
import { BrowserSessionRegistry } from './browser-session.registry';
import { ScreenshotStore } from './screenshot.store';
import { UserBrowserProfileService } from './user-browser-profile.service';

@Module({
  imports: [TypeOrmModule.forFeature([SessionRecordEntity, UserBrowserProfileEntity])],
  controllers: [BrowserLoginsController],
  providers: [
    BrowserSessionRegistry,
    BrowserSessionFactory,
    BrowserSessionManager,
    ScreenshotStore,
    UserBrowserProfileService,
  ],
  exports: [BrowserSessionManager, ScreenshotStore, UserBrowserProfileService],
})
export class BrowserModule {}
