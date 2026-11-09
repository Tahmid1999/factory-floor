import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { assertSimTrustedAddr } from './guests/sim-caller';
import { assertProductionSecrets } from './secrets';

async function main() {
  assertProductionSecrets(process.env);
  assertSimTrustedAddr(process.env);
  const app = await NestFactory.create(AppModule);
  // The station page is served from its own origin and the guest lives in a
  // cookie, so the browser only sends it to an origin named here.
  const origins = (process.env.WEB_ORIGIN ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  if (origins.length > 0) app.enableCors({ origin: origins, credentials: true });
  app.enableShutdownHooks();
  // Loopback by default; a container sets HOST=0.0.0.0 so its published port
  // reaches it, and the compose file publishes that port on 127.0.0.1 only.
  await app.listen(Number(process.env.PORT ?? 4120), process.env.HOST ?? '127.0.0.1');
}

main();
