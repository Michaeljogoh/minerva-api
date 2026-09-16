import { Global, Module } from '@nestjs/common';
import { GatewayAuthService } from './gateway-auth.service';
import { RateLimitService } from './rate-limit.service';
import { UrlAllowlistService } from './url-allowlist.service';

@Global()
@Module({
  providers: [UrlAllowlistService, RateLimitService, GatewayAuthService],
  exports: [UrlAllowlistService, RateLimitService, GatewayAuthService],
})
export class SecurityModule {}
