import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { GatewayAuthService } from './gateway-auth.service';
import { UserAuthService } from './user-auth.service';

interface AuthedRequest {
  headers: Record<string, string | string[] | undefined>;
  userId?: string;
}

/** Requires the shared gateway key (if configured) and a valid user token. */
@Injectable()
export class UserGuard implements CanActivate {
  constructor(
    private readonly gatewayAuth: GatewayAuthService,
    private readonly userAuth: UserAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const apiKey = req.headers['x-api-key'];
    this.gatewayAuth.assertAuthorized(
      typeof apiKey === 'string' ? apiKey : undefined,
    );
    const authorization = req.headers['authorization'];
    const user = await this.userAuth.verifyAuthorizationHeader(
      typeof authorization === 'string' ? authorization : undefined,
    );
    req.userId = user.userId;
    return true;
  }
}

export const CurrentUserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string =>
    context.switchToHttp().getRequest<AuthedRequest>().userId ?? '',
);
