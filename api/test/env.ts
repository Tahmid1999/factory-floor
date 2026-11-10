import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(__dirname, '../../.env') });
// Tests never touch the dev database.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
// The worker module carries the simulated line; specs that boot it drive the sim by hand.
process.env.SIM_ENABLED = '0';
// The month-close cron runs on the wall clock; specs close months by hand.
process.env.CLOSE_ENABLED = '0';
