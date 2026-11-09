import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { HoodService } from './hood';

// Public, like the rest of /hood: the lines carry no guest name, cookie, ip or
// device id (see HoodService callers), so there is nothing to gate.
@Controller('events')
export class HoodController {
  constructor(@Inject(HoodService) private readonly hood: HoodService) {}

  @Get('recent')
  recent() {
    return this.hood.recent();
  }

  // Raw writes rather than @Sse(): a heartbeat has to be a comment line, which
  // a MessageEvent cannot express, and proxies close a stream that goes quiet.
  @Get('stream')
  stream(@Req() req: Request, @Res() res: Response) {
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
      clearInterval(beat);
      sub.unsubscribe();
    });
  }
}
