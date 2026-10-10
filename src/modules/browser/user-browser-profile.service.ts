import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Steel from 'steel-sdk';
import { UserBrowserProfileEntity } from '@modules/persistence/entities/user-browser-profile.entity';

/** Steel deletes profiles unused for 30 days; stop trying to load them a day earlier. */
const PROFILE_MAX_IDLE_MS = 29 * 24 * 60 * 60 * 1000;
const UPLOAD_POLL_INTERVAL_MS = 2000;
const UPLOAD_POLL_TIMEOUT_MS = 90_000;

/** One profile per user holds every site they have signed in to. */
const USER_PROFILE_SITE = '*';

export interface ProfileLease {
  /** Existing Steel profile to load, if the user has a usable one. */
  profileId?: string;
  /** Save this session's cookies back to the profile. */
  persist: boolean;
}

/**
 * Saves a user's signed-in browser state (cookies, storage) in a Steel profile
 * so they sign in to a site once. The profile is only ever loaded for the user
 * it belongs to, and only one live session may write to it at a time.
 */
@Injectable()
export class UserBrowserProfileService {
  private readonly logger = new Logger(UserBrowserProfileService.name);
  private client: Steel | null = null;
  /** Users whose profile is held by a running session or an in-flight upload. */
  private readonly inUse = new Set<string>();

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(UserBrowserProfileEntity)
    private readonly profiles: Repository<UserBrowserProfileEntity>,
  ) {}

  /** Decide which profile (if any) this user's next session loads and saves. */
  async acquire(userId: string): Promise<ProfileLease> {
    if (this.inUse.has(userId)) {
      // A second concurrent run would clobber the first one's saved state.
      return { persist: false };
    }
    this.inUse.add(userId);

    try {
      const row = await this.profiles.findOne({
        where: { userId, site: USER_PROFILE_SITE },
      });
      const stale =
        !row ||
        row.status !== 'ready' ||
        (row.lastUsedAt !== null &&
          Date.now() - row.lastUsedAt.getTime() > PROFILE_MAX_IDLE_MS);
      return stale
        ? { persist: true }
        : { profileId: row.profileId, persist: true };
    } catch (err) {
      this.inUse.delete(userId);
      throw err;
    }
  }

  /** Record the profile a freshly created session writes to. */
  async register(userId: string, profileId: string): Promise<void> {
    const existing = await this.profiles.findOne({
      where: { userId, site: USER_PROFILE_SITE },
    });
    const row =
      existing ??
      this.profiles.create({ userId, site: USER_PROFILE_SITE, profileId });
    row.profileId = profileId;
    row.status = 'uploading';
    row.lastUsedAt = new Date();
    await this.profiles.save(row);
  }

  /** The session never started (or failed to start): free the lease. */
  abort(userId: string): void {
    this.inUse.delete(userId);
  }

  /**
   * Call after the Steel session is released. Steel uploads the profile in the
   * background; wait for READY before the next run may load it.
   */
  async finishUpload(userId: string, profileId: string): Promise<void> {
    try {
      const deadline = Date.now() + UPLOAD_POLL_TIMEOUT_MS;
      let status: 'uploading' | 'ready' | 'failed' = 'uploading';
      while (status === 'uploading' && Date.now() < deadline) {
        await new Promise((resolve) =>
          setTimeout(resolve, UPLOAD_POLL_INTERVAL_MS),
        );
        const profile = await this.getClient().profiles.get(profileId);
        if (profile.status === 'READY') status = 'ready';
        else if (profile.status === 'FAILED') status = 'failed';
      }
      await this.profiles.update(
        { userId, site: USER_PROFILE_SITE, profileId },
        { status, lastUsedAt: new Date() },
      );
      if (status !== 'ready') {
        this.logger.warn(
          `Profile ${profileId} for a user ended as ${status}; next run starts fresh`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Profile upload check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.profiles
        .update({ userId, site: USER_PROFILE_SITE, profileId }, { status: 'failed' })
        .catch(() => undefined);
    } finally {
      this.inUse.delete(userId);
    }
  }

  async hasSavedLogins(userId: string): Promise<boolean> {
    const row = await this.profiles.findOne({
      where: { userId, site: USER_PROFILE_SITE },
    });
    return row?.status === 'ready';
  }

  /**
   * Stop using the saved browser state. Steel has no delete call for profiles,
   * so the stored copy expires on its own after 30 days unused.
   */
  async forget(userId: string): Promise<void> {
    await this.profiles.delete({ userId, site: USER_PROFILE_SITE });
  }

  private getClient(): Steel {
    if (!this.client) {
      this.client = new Steel({
        steelAPIKey: this.config.get<string>('steel.apiKey') ?? '',
      });
    }
    return this.client;
  }
}
