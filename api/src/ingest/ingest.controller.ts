import {
  BadRequestException,
  Body,
  Controller,
  HttpException,
  Inject,
  PayloadTooLargeException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { CLOCK, Clock } from '../clock';
import { GuestGuard, GuestRequest } from '../guests/guests.guard';
import { hit } from '../limits';
import { OPERATIONS } from '../line/line';
import { BatchBody, BatchEvent, IngestService } from './ingest.service';

const MAX_EVENTS = 50;
const INT32_MAX = 2 ** 31 - 1;
const OPS = new Set(OPERATIONS.map((o) => o.code));

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

function badBody(): never {
  throw new BadRequestException({ error: 'bad batch' });
}

// Checked by hand: the shape is small and a 400 for any slip is all a station needs.
function parseBatch(raw: unknown): BatchBody {
  const b = raw as Partial<BatchBody> | undefined;
  if (!b || typeof b.deviceId !== 'string' || !isInt(b.deviceNow) || !Array.isArray(b.events)) badBody();
  const events = b.events.map((e: Partial<BatchEvent>): BatchEvent => {
    if (
      !e ||
      !isInt(e.seq) ||
      e.seq < 0 ||
      e.seq > INT32_MAX ||
      typeof e.bundleCode !== 'string' ||
      e.bundleCode.length === 0 ||
      e.bundleCode.length > 32 ||
      typeof e.op !== 'string' ||
      !OPS.has(e.op) ||
      !isInt(e.scannedAt) ||
      !isInt(e.offsetMs) ||
      Math.abs(e.offsetMs) > INT32_MAX
    ) {
      badBody();
    }
    return { seq: e.seq, bundleCode: e.bundleCode, op: e.op, scannedAt: e.scannedAt, offsetMs: e.offsetMs };
  });
  return { deviceId: b.deviceId, deviceNow: b.deviceNow, events };
}

@Controller('scans')
@UseGuards(GuestGuard)
export class IngestController {
  constructor(
    @Inject(IngestService) private readonly ingest: IngestService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post('batch')
  async batch(@Req() req: GuestRequest, @Body() raw: unknown) {
    const body = parseBatch(raw);
    if (body.events.length > MAX_EVENTS) throw new PayloadTooLargeException({ error: 'at most 50 events per batch' });
    // Ownership first, so a stranger cannot spend another device's allowance.
    const device = await this.ingest.deviceFor(req.actor, body.deviceId);
    if (!hit(`batch:${device.id}`, 2, 1, this.clock.now().getTime())) {
      throw new HttpException({ error: 'too many batches, slow down' }, 429);
    }
    return this.ingest.ingest(req.actor, device, body);
  }
}
