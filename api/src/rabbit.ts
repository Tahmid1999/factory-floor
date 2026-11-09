import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import type { HoodEvent } from './hood/hood-event';

export const APPLY_QUEUE = 'scan.apply';
export const HOOD_EXCHANGE = 'hood';

type Conn = Awaited<ReturnType<typeof amqp.connect>>;
type Chan = Awaited<ReturnType<Conn['createChannel']>>;

@Injectable()
export class Rabbit implements OnModuleDestroy {
  private readonly log = new Logger(Rabbit.name);
  private conn?: Conn;
  private chan?: Promise<Chan>;

  constructor(private readonly config: ConfigService) {}

  // One lazily opened channel, dropped when the connection closes so the next
  // call reconnects after a broker restart instead of failing forever.
  private channel(): Promise<Chan> {
    if (!this.chan) {
      this.chan = this.open().catch((err) => {
        this.chan = undefined;
        throw err;
      });
    }
    return this.chan;
  }

  private async open(): Promise<Chan> {
    const conn = await amqp.connect(this.config.getOrThrow<string>('RABBIT_URL'));
    this.conn = conn;
    conn.on('error', (err) => this.log.warn(`rabbit connection error: ${err.message}`));
    conn.on('close', () => {
      this.chan = undefined;
      this.conn = undefined;
    });
    const ch = await conn.createChannel();
    await ch.assertQueue(APPLY_QUEUE, { durable: true });
    await ch.assertExchange(HOOD_EXCHANGE, 'fanout', { durable: false });
    return ch;
  }

  async ping(): Promise<void> {
    await this.channel();
  }

  async publishApply(inboxId: string): Promise<void> {
    const ch = await this.channel();
    ch.sendToQueue(APPLY_QUEUE, Buffer.from(inboxId), { persistent: true });
  }

  async consumeApply(handler: (inboxId: string) => Promise<void>, prefetch = 50): Promise<void> {
    const ch = await this.channel();
    await ch.prefetch(prefetch);
    await ch.consume(APPLY_QUEUE, async (msg) => {
      if (!msg) return;
      try {
        await handler(msg.content.toString());
        ch.ack(msg);
      } catch (err) {
        this.log.error(`apply failed: ${(err as Error).message}`);
        ch.nack(msg, false, true);
      }
    });
  }

  async publishHood(e: HoodEvent): Promise<void> {
    const ch = await this.channel();
    ch.publish(HOOD_EXCHANGE, '', Buffer.from(JSON.stringify(e)));
  }

  async consumeHood(fn: (e: HoodEvent) => void): Promise<void> {
    const ch = await this.channel();
    const { queue } = await ch.assertQueue('', { exclusive: true, autoDelete: true });
    await ch.bindQueue(queue, HOOD_EXCHANGE, '');
    await ch.consume(
      queue,
      (msg) => {
        if (msg) fn(JSON.parse(msg.content.toString()));
      },
      { noAck: true },
    );
  }

  async onModuleDestroy() {
    const conn = this.conn;
    this.chan = undefined;
    this.conn = undefined;
    await conn?.close().catch(() => undefined);
  }
}
