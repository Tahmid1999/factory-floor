import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { assertProductionSecrets } from './secrets';
import { WorkerModule } from './worker.module';

async function main() {
  // SEED_MODE turns the batch and gate limits off; it belongs to seed:history.
  if (process.env.SEED_MODE === '1') {
    console.error('refusing to start the worker: SEED_MODE=1 is for npm run seed:history only');
    process.exit(1);
  }
  assertProductionSecrets(process.env);
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
}

main();
