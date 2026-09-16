import {
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { GatewayAuthService } from '@modules/security/gateway-auth.service';
import { SessionService } from './session.service';

@Controller('sessions')
export class SessionController {
  constructor(
    private readonly sessionService: SessionService,
    private readonly gatewayAuth: GatewayAuthService,
  ) {}

  @Get()
  list(@Query('limit') limit?: string, @Headers('x-api-key') apiKey?: string) {
    this.gatewayAuth.assertAuthorized(apiKey);
    const n = limit ? Number.parseInt(limit, 10) : 20;
    return this.sessionService.list(Number.isFinite(n) ? n : 20);
  }

  @Get(':id')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-api-key') apiKey?: string,
  ) {
    this.gatewayAuth.assertAuthorized(apiKey);
    return this.sessionService.getById(id);
  }
}
