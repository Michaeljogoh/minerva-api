import { Controller, Delete, Get, UseGuards } from '@nestjs/common';
import { CurrentUserId, UserGuard } from '@modules/security/user.guard';
import { UserBrowserProfileService } from './user-browser-profile.service';

/** The user's saved website sign-ins (their Steel browser profile). */
@Controller('browser-logins')
@UseGuards(UserGuard)
export class BrowserLoginsController {
  constructor(private readonly profiles: UserBrowserProfileService) {}

  @Get()
  async status(@CurrentUserId() userId: string) {
    return { saved: await this.profiles.hasSavedLogins(userId) };
  }

  @Delete()
  async clear(@CurrentUserId() userId: string) {
    await this.profiles.forget(userId);
    return { ok: true };
  }
}
