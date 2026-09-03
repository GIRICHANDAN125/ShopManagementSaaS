import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // SECURITY.md §13 — reject unexpected fields, validate everything at
  // the boundary before business logic runs.
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  // SECURITY.md §8 — explicit allow-list, not '*', in real deployments.
  // Left permissive here for local development only; DEPLOYMENT.md
  // requires this to be locked to the deployed frontend origin(s).
  app.enableCors({ origin: process.env.CORS_ORIGIN?.split(',') ?? true });

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Backend listening on port ${port}`);
}
bootstrap();
