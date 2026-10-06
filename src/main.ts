import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { CorsIoAdapter } from '@common/adapters/cors-io.adapter';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  const frontendUrl =
  config.get<string>('frontendUrl') ?? 'http://localhost:3000';
  app.enableCors({
    origin: frontendUrl,
    credentials: true,
  });
  app.useWebSocketAdapter(new CorsIoAdapter(app, frontendUrl));

  const port = config.get<number>('port') ?? 3001;
  await app.listen(port);
  console.log(`Backend listening on port ${port}`);
}
bootstrap();
