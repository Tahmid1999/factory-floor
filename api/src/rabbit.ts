import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import type { HoodEvent } from './hood/hood-event';

export const APPLY_QUEUE = 'scan.apply';
export const HOOD_EXCHANGE = 'hood';

type Conn = Awaited<ReturnType<typeof amqp.connect>>;
type Chan = Awaited<ReturnType<Conn['createChannel']>>;
type ApplyConsumer = { handler: (inboxId: string) => Promise<void>; prefetch: number };

@Injectable()
export class Rabbit implements OnModuleDestroy {
  private readonly log = new Logger(Rabbit.name);
  private conn?: Conn;
  private chan?: Promise<Chan>;
  private applyConsumer?: ApplyConsumer;
  private readonly subscribed = new WeakSet<Chan>();
  private recovering = false;
  private closing = false;

  constructor(private readonly config: ConfigService) {}

  // One lazily opened channel, dropped when it or its connection closes so the
  // next call reconnects after a broker restart instead of failing forever.
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
    const ch = await conn.createChannel();
    // Channels emit error on their own (a failed assert, for one); without a
    // listener that is an uncaught exception.
    ch.on('error', (err) => this.log.warn(`rabbit channel error: ${err.message}`));
    const lost = () => {
      if (this.conn !== conn) return;
      this.chan = undefined;
      this.conn = undefined;
      // A channel can die alone; its connection would otherwise be orphaned.
      conn.close().catch(() => undefined);
      this.recover();
    };
    ch.on('close', lost);
    conn.on('close', lost);
    await ch.assertQueue(APPLY_QUEUE, { durable: true });
    await ch.assertExchange(HOOD_EXCHANGE, 'fanout', { durable: false });
    if (this.applyConsumer) await this.subscribe(ch, this.applyConsumer);
    return ch;
  }

  // Only a standing consumer needs the connection back; publishers reconnect
  // lazily on their next call.
  private recover(attempt = 0) {
    if (this.closing || !this.applyConsumer || this.recovering) return;
    this.recovering = true;
    const delay = Math.min(500 * 2 ** attempt, 5000);
    setTimeout(() => {
      this.recovering = false;
      if (this.closing) return;
      this.channel().then(
        () => undefined,
        (err) => {
          this.log.warn(`rabbit reconnect failed: ${err.message}`);
          this.recover(attempt + 1);
        },
      );
    }, delay).unref();
  }

  // The channel can vanish between delivery and ack; an unacked message is
  // redelivered anyway, so a late ack or nack is only worth a log line.
  private settle(ch: Chan, msg: amqp.ConsumeMessage, ok: boolean) {
    try {
      if (ok) ch.ack(msg);
      else ch.nack(msg, false, true);
    } catch (err) {
      this.log.warn(`rabbit ${ok ? 'ack' : 'nack'} dropped: ${(err as Error).message}`);
    }
  }

  private async subscribe(ch: Chan, c: ApplyConsumer) {
    // open() subscribes a fresh channel itself; consumeApply must not add a second consumer.
    if (this.subscribed.has(ch)) return;
    this.subscribed.add(ch);
    await ch.prefetch(c.prefetch);
    await ch.consume(APPLY_QUEUE, async (msg) => {
      if (!msg) return;
      try {
        await c.handler(msg.content.toString());
        this.settle(ch, msg, true);
      } catch (err) {
        this.log.error(`apply failed: ${(err as Error).message}`);
        this.settle(ch, msg, false);
      }
    });
  }

  async ping(): Promise<void> {
    await this.channel();
  }

  async publishApply(inboxId: string): Promise<void> {
    const ch = await this.channel();
    ch.sendToQueue(APPLY_QUEUE, Buffer.from(inboxId), { persistent: true });
  }

  async consumeApply(handler: (inboxId: string) => Promise<void>, prefetch = 50): Promise<void> {
    this.applyConsumer = { handler, prefetch };
    const ch = await this.channel();
    await this.subscribe(ch, this.applyConsumer);
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
    this.closing = true;
    const conn = this.conn;
    this.chan = undefined;
    this.conn = undefined;
    await conn?.close().catch(() => undefined);
  }
}
