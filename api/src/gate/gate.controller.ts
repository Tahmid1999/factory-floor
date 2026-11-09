import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { CLOCK, Clock } from '../clock';
import { GuestGuard, GuestRequest } from '../guests/guests.guard';
import { IngestService } from '../ingest/ingest.service';
import { hit } from '../limits';
import { DEFECTS, Defect, GATE_ACTIONS, GateAction, GateBody, GateService, stationRefusal } from './gate.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badBody(): never {
  throw new BadRequestException({ error: 'bad gate scan' });
}

const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v);

// Checked by hand, as the batch is: the shape is small and a 400 is all a
// station needs for a slip.
function parseGate(raw: unknown): GateBody {
  const b = raw as Record<string, unknown> | undefined;
  if (!b || typeof b.deviceId !== 'string' || typeof b.gateId !== 'string' || !UUID.test(b.gateId)) badBody();
  if (!oneOf(GATE_ACTIONS, b.action)) badBody();
  const action: GateAction = b.action;
  // Cutting makes a new bundle, so it is the one action without a code.
  const code = b.bundleCode;
  if (action !== 'cut' && (typeof code !== 'string' || code.length === 0 || code.length > 32)) badBody();
  const needsDefect = action === 'qc_flag' || action === 'qc_fail';
  if (needsDefect && !oneOf(DEFECTS, b.defect)) badBody();
  if (action === 'clear_rework' && (typeof b.targetOp !== 'string' || b.targetOp.length > 32)) badBody();
  return {
    deviceId: b.deviceId,
    gateId: b.gateId.toLowerCase(),
    bundleCode: action === 'cut' ? undefined : (code as string),
    action,
    defect: needsDefect ? (b.defect as Defect) : undefined,
    targetOp: action === 'clear_rework' ? (b.targetOp as string) : undefined,
  };
}

// A gate call is a guest or sim scan, not an admin write, so it is guarded
// like ingest and carries no @Writes role.
@Controller('gate')
@UseGuards(GuestGuard)
export class GateController {
  constructor(
    @Inject(GateService) private readonly gate: GateService,
    @Inject(IngestService) private readonly ingest: IngestService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // 200 for a refusal too: the call worked and the reply says ok: false.
  @Post('scan')
  @HttpCode(200)
  async scan(@Req() req: GuestRequest, @Body() raw: unknown) {
    const body = parseGate(raw);
    // Ownership first, so a stranger cannot spend another device's allowance.
    const device = await this.ingest.deviceFor(req.actor, body.deviceId);
    if (!hit(`gate:${device.id}`, 5, 1, this.clock.now().getTime())) {
      throw new HttpException({ error: 'too many gate calls, slow down' }, 429);
    }
    const refusal = stationRefusal(device.code, body.action);
    if (refusal) throw new ForbiddenException({ error: refusal });
    const actorName = req.guest?.name ?? device.simName ?? 'sim';
    return this.gate.scan(req.actor, actorName, device, body);
  }
}
