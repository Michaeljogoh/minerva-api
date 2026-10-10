import { config as loadEnv } from 'dotenv';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { SessionRecordEntity } from '../modules/persistence/entities/session-record.entity';
import { UserAppConnectionEntity } from '../modules/persistence/entities/user-app-connection.entity';
import { UserBrowserProfileEntity } from '../modules/persistence/entities/user-browser-profile.entity';

loadEnv();

const migrationsPath = join(__dirname, 'migrations/*.{ts,js}');

const url = process.env.DATABASE_URL;

export default new DataSource(
  url
    ? {
        type: 'postgres',
        url,
        entities: [
          SessionRecordEntity,
          UserAppConnectionEntity,
          UserBrowserProfileEntity,
        ],
        migrations: [migrationsPath],
        synchronize: false,
        logging: process.env.NODE_ENV === 'development',
      }
    : {
        type: 'postgres',
        host: process.env.DB_HOST ?? 'localhost',
        port: Number.parseInt(process.env.DB_PORT ?? '5432', 10),
        username: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME ?? 'minerva_agent',
        entities: [
          SessionRecordEntity,
          UserAppConnectionEntity,
          UserBrowserProfileEntity,
        ],
        migrations: [migrationsPath],
        synchronize: false,
        logging: process.env.NODE_ENV === 'development',
      },
);
