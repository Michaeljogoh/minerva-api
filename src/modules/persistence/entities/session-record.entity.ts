import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { ReasoningStep } from '@common/types/reasoning-step.types';
import type { TaskResult, TaskType } from '@common/schemas/task-result.schemas';

export type SessionStatus = 'complete' | 'stopped' | 'error' | 'running';

@Entity({ name: 'session_records' })
export class SessionRecordEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  goal!: string;

  @Index()
  @Column({ type: 'varchar', length: 64, nullable: true })
  taskType!: TaskType | null;

  @Index()
  @Column({ type: 'varchar', length: 32, default: 'running' })
  status!: SessionStatus;

  @Column({ type: 'timestamptz' })
  startedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  endedAt!: Date | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  steps!: ReasoningStep[];

  @Column({ type: 'jsonb', nullable: true })
  result!: TaskResult | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
