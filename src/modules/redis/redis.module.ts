import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';
import { SessionStore } from './session.store';

@Global()
@Module({
  providers: [RedisService, SessionStore],
  exports: [RedisService, SessionStore],
})
export class RedisModule {}
