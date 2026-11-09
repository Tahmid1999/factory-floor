import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';
import { randomUUID } from 'node:crypto';
import type { HoodEvent } from './hood/hood-event';

export const APPLY_QUEUE = 'scan.apply';
export const HOOD_EXCHANGE = 'hood';

type Conn = Awaited<ReturnType<typeof amqp.connect>>;
type Chan = Awaited<ReturnType<Conn['createChannel']>>;
type HoodHandler = (e: HoodEvent) => void;
type ApplyConsumer = { handler: (inboxId: string) => Promise<void>; prefetch: number };

@Injectable()
export class Rabbit implements OnModuleDestroy {
  private readonly log = new Logger(Rabbit.name);
  // Tags what this process publishes to the fanout, so it can tell its own
  // lines when they come back.
  readonly pid = randomUUID();
  private conn?: Conn;
  private chan?: Promise<Chan>;
  private applyConsumer?: ApplyConsumer;
  private readonly subscribed = new WeakSet<Chan>();
  private readonly hoodHandlers: HoodHandler[] = [];
  private readonly hoodBound = new WeakMap<Chan, Set<HoodHandler>>();
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
    for (const fn of this.hoodHandlers) await this.subscribeHood(ch, fn);
    return ch;
  }

  // Only a standing consumer needs the connection back; publishers reconnect
  // lazily on their next call.
  private recover(attempt = 0) {
    if (this.closing || (!this.applyConsumer && this.hoodHandlers.length === 0) || this.recovering) return;
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
  //
  // A failed apply is dropped, not requeued. A message that always throws
  // would come straight back and spin the worker at full speed. Its inbox row
  // still has no result, so the sweep publishes it again 30 s later: a poison
  // message costs one try per sweep, with no dead-letter queue to watch.
  private settle(ch: Chan, msg: amqp.ConsumeMessage, ok: boolean) {
    try {
      if (ok) ch.ack(msg);
      else ch.nack(msg, false, false);
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
    ch.publish(HOOD_EXCHANGE, '', Buffer.from(JSON.stringify({ ...e, pid: this.pid })));
  }

  // Each handler gets its own exclusive queue on the fanout. The queue dies
  // with its channel, so every new channel binds a fresh one.
  private async subscribeHood(ch: Chan, fn: HoodHandler) {
    let bound = this.hoodBound.get(ch);
    if (!bound) this.hoodBound.set(ch, (bound = new Set()));
    // open() binds the handlers it already knows; consumeHood must not bind twice.
    if (bound.has(fn)) return;
    bound.add(fn);
    const { queue } = await ch.assertQueue('', { exclusive: true, autoDelete: true });
    await ch.bindQueue(queue, HOOD_EXCHANGE, '');
    await ch.consume(
      queue,
      (msg) => {
        if (!msg) return;
        let e: HoodEvent;
        try {
          e = JSON.parse(msg.content.toString());
        } catch {
          this.log.warn('hood line skipped, not json');
          return;
        }
        try {
          fn(e);
        } catch (err) {
          this.log.warn(`hood handler failed: ${(err as Error).message}`);
        }
      },
      { noAck: true },
    );
  }

  // The window on the line is best effort: a broker that is down now is
  // retried in the background and the handler is bound when it is back.
  async consumeHood(fn: HoodHandler): Promise<void> {
    this.hoodHandlers.push(fn);
    try {
      await this.subscribeHood(await this.channel(), fn);
    } catch (err) {
      this.log.warn(`hood consumer not bound yet: ${(err as Error).message}`);
      this.recover();
    }
  }

  async onModuleDestroy() {
    this.closing = true;
    const conn = this.conn;
    this.chan = undefined;
    this.conn = undefined;
    await conn?.close().catch(() => undefined);
  }
}
