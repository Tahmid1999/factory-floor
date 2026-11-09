import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function main() {
  const app = await NestFactory.create(AppModule);
  // The station page is served from its own origin and the guest lives in a
  // cookie, so the browser only sends it to an origin named here.
  const origins = (process.env.WEB_ORIGIN ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  if (origins.length > 0) app.enableCors({ origin: origins, credentials: true });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 4120), '127.0.0.1');
}

main();
