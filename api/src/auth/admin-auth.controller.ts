import { Body, Controller, HttpCode, HttpException, Inject, Post, Req, Res } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import type { CookieOptions, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { CLOCK, Clock } from '../clock';
import { hit, refund } from '../limits';
import { PrismaService } from '../prisma.service';
import { ADMIN_COOKIE, adminSecret } from './roles.guard';

const HOUR_MS = 60 * 60 * 1000;
const SESSION_HOURS = 12;
const TRIES_PER_HOUR = 5;

// Built per call so NODE_ENV is read when the cookie is set, not at import.
function cookieOptions(): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' };
}

// Compared against when the login is unknown, so a wrong login and a wrong
// password take the same time.
const DECOY_HASH = bcrypt.hashSync('decoy', 10);

@Controller('admin')
export class AdminAuthController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { login?: unknown; password?: unknown },
  ) {
    const { login, password } = body ?? {};
    if (typeof login !== 'string' || typeof password !== 'string') {
      throw new HttpException({ error: 'login and password required' }, 400);
    }

    // The slot is taken before the first await: with the db read and bcrypt in
    // between, a burst of parallel guesses would all pass a check-then-count
    // and the cap would not bound it. A success hands the slot back so only
    // failures count, and an ip already at the cap is refused even with the
    // right password.
    const key = `admin-login:${req.ip ?? ''}`;
    if (!hit(key, TRIES_PER_HOUR, HOUR_MS / 1000, this.clock.now().getTime())) {
      throw new HttpException({ error: 'too many tries, wait an hour' }, 429);
    }

    const user = await this.prisma.user.findUnique({ where: { login } });
    const ok = await bcrypt.compare(password, user?.passwordHash ?? DECOY_HASH);
    if (!user || !ok) throw new HttpException({ error: 'wrong login or password' }, 401);
    refund(key);

    const token = jwt.sign({ role: user.role }, adminSecret(), {
      algorithm: 'HS256',
      subject: user.login,
      expiresIn: `${SESSION_HOURS}h`,
    });
    res.cookie(ADMIN_COOKIE, token, { ...cookieOptions(), maxAge: SESSION_HOURS * HOUR_MS });
    return { login: user.login, role: user.role };
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(ADMIN_COOKIE, cookieOptions());
    return { ok: true };
  }
}
