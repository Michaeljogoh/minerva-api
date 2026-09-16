import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import configuration from '@common/config/configuration';
import { validateEnv } from '@common/config/env.validation';
import { AgentModule } from '@modules/agent/agent.module';
import { EvalModule } from '@modules/eval/eval.module';
import { GatewayModule } from '@modules/gateway/gateway.module';
import { HealthModule } from '@modules/health/health.module';
import { PersistenceModule } from '@modules/persistence/persistence.module';
import { RedisModule } from '@modules/redis/redis.module';
import { SecurityModule } from '@modules/security/security.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    SecurityModule,
    PersistenceModule,
    RedisModule,
    HealthModule,
    forwardRef(() => AgentModule),
    forwardRef(() => GatewayModule),
    EvalModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
