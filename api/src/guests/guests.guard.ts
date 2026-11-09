import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Guest } from '@prisma/client';
import type { Request, Response } from 'express';
import { Actor } from './ownership';
import { GuestsService, isLoopback } from './guests.service';

export const GUEST_COOKIE = 'ff_guest';
const DAY_MS = 24 * 60 * 60 * 1000;

export type GuestRequest = Request & { guest?: Guest; actor: Actor };

@Injectable()
export class GuestGuard implements CanActivate {
  constructor(@Inject(GuestsService) private readonly guests: GuestsService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<GuestRequest>();
    const res = ctx.switchToHttp().getResponse<Response>();

    // The sim is trusted only with the key and only from this machine; it
    // never gets a guest and never counts against the per-ip guest limit.
    const key = req.header('x-sim-key');
    if (key && key === process.env.SIM_KEY && isLoopback(req.ip)) {
      req.actor = { sim: true };
      return true;
    }

    const cookie = req.signedCookies?.[GUEST_COOKIE];
    let guest = typeof cookie === 'string' ? await this.guests.findGuest(cookie) : null;
    if (guest) {
      guest = await this.guests.touch(guest.id);
    } else {
      guest = await this.guests.createGuest(req.ip ?? '');
      res.cookie(GUEST_COOKIE, guest.id, {
        signed: true,
        httpOnly: true,
        sameSite: 'lax',
        // The page and the API are on different hosts, so production is always https.
        secure: process.env.NODE_ENV === 'production',
        maxAge: DAY_MS,
      });
    }
    req.guest = guest;
    req.actor = { guestId: guest.id, sim: false };
    return true;
  }
}
