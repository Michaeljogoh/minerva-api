import { Controller, Get, Headers } from '@nestjs/common';
import { GatewayAuthService } from '@modules/security/gateway-auth.service';
import { ExternalModelService } from './external-model.service';

@Controller('model')
export class ModelController {
  constructor(
    private readonly externalModels: ExternalModelService,
    private readonly gatewayAuth: GatewayAuthService,
  ) {}

  /** Which user-key providers and models this server allows. Contains no secrets. */
  @Get('options')
  options(@Headers('x-api-key') apiKey?: string) {
    this.gatewayAuth.assertAuthorized(apiKey);
    return this.externalModels.getOptions();
  }
}
