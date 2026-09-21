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

  const rawCors = process.env.CORS_ORIGIN;
  const corsOrigin = !rawCors || rawCors === '*' ? true : rawCors.split(',');
  app.enableCors({ origin: corsOrigin });

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Backend listening on port ${port}`);
}
bootstrap();
