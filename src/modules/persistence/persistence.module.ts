import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SessionRecordEntity } from './entities/session-record.entity';
import { UserAppConnectionEntity } from './entities/user-app-connection.entity';
import { UserBrowserProfileEntity } from './entities/user-browser-profile.entity';
import { SessionController } from './session.controller';
import { SessionService } from './session.service';

const ENTITIES = [
  SessionRecordEntity,
  UserAppConnectionEntity,
  UserBrowserProfileEntity,
];

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('database.url');
        const nodeEnv = config.get<string>('nodeEnv') ?? 'development';
        const synchronize = config.get<boolean>('database.synchronize') ?? false;
        const logging = config.get<boolean>('database.logging') ?? false;
        const migrationsRun = nodeEnv === 'production';
        const migrations = [
          join(__dirname, '../../database/migrations/*.{js}'),
        ];

        if (url) {
          return {
            type: 'postgres' as const,
            url,
            entities: ENTITIES,
            migrations,
            migrationsRun,
            synchronize,
            logging,
          };
        }

        return {
          type: 'postgres' as const,
          host: config.get<string>('database.host'),
          port: config.get<number>('database.port'),
          username: config.get<string>('database.username'),
          password: config.get<string>('database.password'),
          database: config.get<string>('database.name'),
          entities: ENTITIES,
          migrations,
          migrationsRun,
          synchronize,
          logging,
        };
      },
    }),
    TypeOrmModule.forFeature(ENTITIES),
  ],
  controllers: [SessionController],
  providers: [SessionService],
  exports: [TypeOrmModule, SessionService],
})
export class PersistenceModule {}
