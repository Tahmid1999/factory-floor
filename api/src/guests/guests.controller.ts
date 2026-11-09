import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { GuestMode } from '@prisma/client';
import { STATIONS, StationCode } from '../line/line';
import { GuestGuard, GuestRequest } from './guests.guard';
import { GuestsService } from './guests.service';

@Controller()
@UseGuards(GuestGuard)
export class GuestsController {
  constructor(@Inject(GuestsService) private readonly guests: GuestsService) {}

  // Sim callers have no guest, so the /me routes are for visitors only.
  private guestOf(req: GuestRequest) {
    if (!req.guest) throw new ForbiddenException({ error: 'guests only' });
    return req.guest;
  }

  @Get('me')
  me(@Req() req: GuestRequest) {
    return this.guests.me(this.guestOf(req));
  }

  @Put('me/mode')
  async setMode(@Req() req: GuestRequest, @Body() body: { mode?: string }) {
    const guest = this.guestOf(req);
    if (body?.mode !== 'hybrid' && body?.mode !== 'async') throw new BadRequestException({ error: 'bad mode' });
    await this.guests.setMode(guest.id, body.mode as GuestMode);
    return { mode: body.mode };
  }

  @Post('me/bundles/refill')
  refill(@Req() req: GuestRequest) {
    return this.guests.refill(this.guestOf(req));
  }

  @Post('devices')
  async register(@Req() req: GuestRequest, @Body() body: { station?: string; simName?: string }) {
    const station = body?.station as StationCode;
    if (!station || !Object.prototype.hasOwnProperty.call(STATIONS, station)) {
      throw new BadRequestException({ error: 'unknown station' });
    }
    let device;
    if (req.actor.sim) {
      if (!body.simName) throw new BadRequestException({ error: 'simName is required' });
      device = await this.guests.registerSimDevice(station, body.simName);
    } else {
      device = await this.guests.registerGuestDevice(req.actor.guestId!, station);
    }
    return { deviceId: device.id, registeredAt: device.registeredAt };
  }
}
