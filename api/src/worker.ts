import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { assertProductionSecrets } from './secrets';
import { WorkerModule } from './worker.module';

async function main() {
  assertProductionSecrets(process.env);
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
}

main();
