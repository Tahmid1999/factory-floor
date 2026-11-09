import { INestApplicationContext } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as amqp from 'amqplib';
import type { HoodEvent } from '../src/hood/hood-event';
import { HOOD_EXCHANGE, Rabbit } from '../src/rabbit';

const line = (text: string): HoodEvent => ({ t: 1, kind: 'sweep', proc: 'worker', text });

// A fanout line sent while the consumer is still re-binding is lost by design,
// so the test keeps sending until one arrives.
async function seenAfterSending(rabbit: Rabbit, seen: string[], text: string, ms = 15000) {
  const end = Date.now() + ms;
  while (!seen.includes(text)) {
    if (Date.now() > end) throw new Error(`no hood line "${text}" arrived`);
    await rabbit.publishHood(line(text)).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe('rabbit hood consumer', () => {
  let ctx: INestApplicationContext;
  let rabbit: Rabbit;
  const seen: string[] = [];

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [Rabbit],
    }).compile();
    ctx = await mod.init();
    rabbit = ctx.get(Rabbit);
    await rabbit.consumeHood((e) => seen.push(e.text));
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('delivers before any failure', async () => {
    await seenAfterSending(rabbit, seen, 'first');
  });

  it('keeps receiving after the connection drops', async () => {
    await (rabbit as any).conn.close();
    await seenAfterSending(rabbit, seen, 'after-connection');
  });

  it('keeps receiving after the channel alone closes', async () => {
    const ch = await (rabbit as any).chan;
    await ch.close();
    await seenAfterSending(rabbit, seen, 'after-channel');
  });

  it('skips a message that is not json and keeps going', async () => {
    const conn = await amqp.connect(process.env.RABBIT_URL!);
    try {
      const ch = await conn.createChannel();
      ch.publish(HOOD_EXCHANGE, '', Buffer.from('{not json'));
      await ch.close();
    } finally {
      await conn.close();
    }
    await seenAfterSending(rabbit, seen, 'after-junk');
  });
});
