import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type AppConnectionStatus = 'pending' | 'active' | 'disconnected';

/**
 * A user's link to a Composio-connected app. Composio holds the tokens; this
 * row remembers which account is theirs plus app-specific details such as the
 * Shopify store, so they only type it once.
 */
@Entity({ name: 'user_app_connections' })
@Index(['userId', 'toolkit'], { unique: true })
export class UserAppConnectionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 128 })
  userId!: string;

  @Column({ type: 'varchar', length: 64 })
  toolkit!: string;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: AppConnectionStatus;

  /** Composio connected account id (ca_...). */
  @Column({ type: 'varchar', length: 128, nullable: true })
  composioAccountId!: string | null;

  /** e.g. { shopSubdomain: 'acme' } */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  metadata!: Record<string, string>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
