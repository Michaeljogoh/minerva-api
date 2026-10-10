import { Controller, Get, UseGuards } from '@nestjs/common';
import { UserGuard } from '@modules/security/user.guard';
import { ExternalModelService } from './external-model.service';

@Controller('model')
@UseGuards(UserGuard)
export class ModelController {
  constructor(private readonly externalModels: ExternalModelService) {}

  /** Which user-key providers and models this server allows. Contains no secrets. */
  @Get('options')
  options() {
    return this.externalModels.getOptions();
  }
}
