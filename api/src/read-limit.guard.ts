import { CanActivate, ExecutionContext, HttpException, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { CLOCK, Clock } from './clock';
import { hit } from './limits';

// Reads anyone can make without a login: the admin views, a guest's /me and
// the window on the line. Each costs a few queries or an open stream, so one
// address gets a fixed number a minute per controller. 120 is well above what
// one person's tabs poll (the admin every 2.5 s, the station's /me every 5 s
// and the trap's about once a second) and well below what a loop can send.
const READS_PER_MINUTE = 120;

@Injectable()
export class ReadLimitGuard implements CanActivate {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const key = `read:${ctx.getClass().name}:${req.ip ?? ''}`;
    if (!hit(key, READS_PER_MINUTE, 60, this.clock.now().getTime())) {
      throw new HttpException({ error: 'too many reads, slow down' }, 429);
    }
    return true;
  }
}
