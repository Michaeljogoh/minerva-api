import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Socket } from 'socket.io';

type JwksResolver = ReturnType<typeof import('jose').createRemoteJWKSet>;

export interface AuthenticatedUser {
  userId: string;
}

/**
 * Verifies the signed-in user's JWT (Clerk session token) against the
 * provider's JWKS. The user id always comes from a verified token, never from
 * anything the client or the model sends.
 */
@Injectable()
export class UserAuthService {
  private readonly logger = new Logger(UserAuthService.name);
  private jwks: JwksResolver | null = null;

  constructor(private readonly config: ConfigService) {}

  private get issuer(): string {
    return this.config.get<string>('auth.issuer') ?? '';
  }

  private get audience(): string | undefined {
    return this.config.get<string>('auth.audience') || undefined;
  }

  // jose is ESM-only, so it is loaded with a dynamic import.
  private async getJwks(): Promise<JwksResolver> {
    if (!this.jwks) {
      const { createRemoteJWKSet } = await import('jose');
      const url =
        this.config.get<string>('auth.jwksUrl') ||
        `${this.issuer.replace(/\/$/, '')}/.well-known/jwks.json`;
      this.jwks = createRemoteJWKSet(new URL(url));
    }
    return this.jwks;
  }

  async verifyToken(token: string | undefined): Promise<AuthenticatedUser> {
    if (!token) {
      throw new UnauthorizedException('Sign in required');
    }
    if (!this.issuer) {
      throw new UnauthorizedException('Auth is not configured');
    }
    try {
      const { jwtVerify } = await import('jose');
      const { payload } = await jwtVerify(token, await this.getJwks(), {
        issuer: this.issuer,
        audience: this.audience,
      });
      if (!payload.sub) {
        throw new Error('token has no subject');
      }
      return { userId: payload.sub };
    } catch (err) {
      this.logger.debug(
        `Token rejected: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new UnauthorizedException('Invalid or expired session');
    }
  }

  /** Accepts `Authorization: Bearer <jwt>`. */
  verifyAuthorizationHeader(
    header: string | undefined,
  ): Promise<AuthenticatedUser> {
    const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
    return this.verifyToken(match?.[1]);
  }

  /** Socket.IO handshake: `auth.userToken` (kept separate from the gateway key). */
  verifySocket(client: Socket): Promise<AuthenticatedUser> {
    const auth = client.handshake.auth as { userToken?: string } | undefined;
    return this.verifyToken(auth?.userToken);
  }
}
