import { INestApplicationContext } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Rabbit } from '../src/rabbit';
import { purgeQueues } from './helpers';

async function until(check: () => boolean, ms = 15000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for the consumer');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('rabbit consumer', () => {
  let ctx: INestApplicationContext;
  let rabbit: Rabbit;
  const seen: string[] = [];

  beforeAll(async () => {
    await purgeQueues();
    // Rabbit alone: the worker starts its own apply consumer at boot, and
    // this test needs to be the only one on the queue.
    const mod = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [Rabbit],
    }).compile();
    ctx = await mod.init();
    rabbit = ctx.get(Rabbit);
    await rabbit.consumeApply(async (id) => {
      seen.push(id);
    });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('delivers before any failure', async () => {
    await rabbit.publishApply('first');
    await until(() => seen.includes('first'));
  });

  it('keeps consuming after the connection drops', async () => {
    await (rabbit as any).conn.close();
    await rabbit.publishApply('after-connection');
    await until(() => seen.includes('after-connection'));
  });

  it('keeps consuming after the channel alone closes', async () => {
    const ch = await (rabbit as any).chan;
    await ch.close();
    await rabbit.publishApply('after-channel');
    await until(() => seen.includes('after-channel'));
  });
});
