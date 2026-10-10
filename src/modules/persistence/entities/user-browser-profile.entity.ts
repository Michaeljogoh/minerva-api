import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type BrowserProfileStatus = 'uploading' | 'ready' | 'failed';

/**
 * A Steel browser profile (cookies, local storage) saved for one user so they
 * sign in to a site once. It holds live session cookies, so it must only ever
 * be loaded for the user it belongs to.
 */
@Entity({ name: 'user_browser_profiles' })
@Index(['userId', 'site'], { unique: true })
export class UserBrowserProfileEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 128 })
  userId!: string;

  /** Site origin the user signed in to, e.g. https://app.example.com */
  @Column({ type: 'varchar', length: 255 })
  site!: string;

  /** Steel profile id. */
  @Column({ type: 'varchar', length: 128 })
  profileId!: string;

  @Column({ type: 'varchar', length: 16, default: 'uploading' })
  status!: BrowserProfileStatus;

  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
