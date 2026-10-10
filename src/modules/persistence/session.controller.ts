import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUserId, UserGuard } from '@modules/security/user.guard';
import { SessionService } from './session.service';

@Controller('sessions')
@UseGuards(UserGuard)
export class SessionController {
  constructor(private readonly sessionService: SessionService) {}

  @Get()
  list(@CurrentUserId() userId: string, @Query('limit') limit?: string) {
    const n = limit ? Number.parseInt(limit, 10) : 20;
    return this.sessionService.list(userId, Number.isFinite(n) ? n : 20);
  }

  @Get(':id')
  get(
    @CurrentUserId() userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.sessionService.getById(userId, id);
  }
}
