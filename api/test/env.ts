import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(__dirname, '../../.env') });
// Tests never touch the dev database.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
