import { Controller, Get, HttpException, Inject, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ReadLimitGuard } from '../read-limit.guard';
import { HoodService } from './hood';

// Public, like the rest of /hood: the lines carry no guest name, cookie, ip or
// device id (see HoodService callers), so there is nothing to gate. What is
// limited is the cost: reads per address, and open streams in all, since each
// one holds a socket and a subscription for as long as the tab stays open.
@Controller('events')
@UseGuards(ReadLimitGuard)
export class HoodController {
  private streams = 0;
  private readonly maxStreams = Number(process.env.HOOD_MAX_STREAMS ?? 100);

  constructor(@Inject(HoodService) private readonly hood: HoodService) {}

  @Get('recent')
  recent() {
    return this.hood.recent();
  }

  // Raw writes rather than @Sse(): a heartbeat has to be a comment line, which
  // a MessageEvent cannot express, and proxies close a stream that goes quiet.
  @Get('stream')
  stream(@Req() req: Request, @Res() res: Response) {
    if (this.streams >= this.maxStreams) throw new HttpException({ error: 'too many open streams, try later' }, 503);
    this.streams++;
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx would otherwise buffer the stream until it fills.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    // Snapshot and subscribe in the same tick, so no line falls in between.
    for (const e of this.hood.recent()) send(e);
    const sub = this.hood.live.subscribe(send);
    const beat = setInterval(() => res.write(': hb\n\n'), Number(process.env.HOOD_HEARTBEAT_MS ?? 15_000));
    req.on('close', () => {
      this.streams--;
      clearInterval(beat);
      sub.unsubscribe();
    });
  }
}
