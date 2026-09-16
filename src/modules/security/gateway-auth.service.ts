import { timingSafeEqual } from 'crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Socket } from 'socket.io';

@Injectable()
export class GatewayAuthService {
  constructor(private readonly config: ConfigService) {}

  isRequired(): boolean {
    return Boolean(this.config.get<string>('security.gatewayApiKey'));
  }

  assertAuthorized(token: string | undefined): void {
    const expected = this.config.get<string>('security.gatewayApiKey') ?? '';
    if (!expected) {
      return;
    }
    if (!token || !GatewayAuthService.tokensMatch(token, expected)) {
      throw new UnauthorizedException('Unauthorized');
    }
  }

  private static tokensMatch(provided: string, expected: string): boolean {
    const providedBuf = Buffer.from(provided);
    const expectedBuf = Buffer.from(expected);
    if (providedBuf.length !== expectedBuf.length) {
      return false;
    }
    return timingSafeEqual(providedBuf, expectedBuf);
  }

  tokenFromHandshake(client: Socket): string | undefined {
    const auth = client.handshake.auth as { token?: string } | undefined;
    const header = client.handshake.headers['x-api-key'];
    return auth?.token ?? (typeof header === 'string' ? header : undefined);
  }
}
