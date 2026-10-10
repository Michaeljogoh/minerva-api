import { Global, Module } from '@nestjs/common';
import { GatewayAuthService } from './gateway-auth.service';
import { RateLimitService } from './rate-limit.service';
import { UserAuthService } from './user-auth.service';
import { UserGuard } from './user.guard';
import { UrlAllowlistService } from './url-allowlist.service';

@Global()
@Module({
  providers: [
    UrlAllowlistService,
    RateLimitService,
    GatewayAuthService,
    UserAuthService,
    UserGuard,
  ],
  exports: [
    UrlAllowlistService,
    RateLimitService,
    GatewayAuthService,
    UserAuthService,
    UserGuard,
  ],
})
export class SecurityModule {}
