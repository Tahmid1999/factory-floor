import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { AdminView, isRole, READS, READS_KEY, Role, WRITES_KEY } from './roles';

export const ADMIN_COOKIE = 'ff_admin';

export type Acting = { role: Role; login?: string };
export type ActingRequest = Request & { acting: Acting };

export function adminSecret(): string {
  const s = process.env.ADMIN_JWT_SECRET;
  if (!s) throw new Error('ADMIN_JWT_SECRET is not set');
  return s;
}

function deny(status: number, error: string): never {
  throw new HttpException({ error }, status);
}

function readAdminCookie(req: Request): { login: string; role: Role } | null {
  const token = req.cookies?.[ADMIN_COOKIE];
  if (typeof token !== 'string') return null;
  try {
    const p = jwt.verify(token, adminSecret(), { algorithms: ['HS256'] });
    if (typeof p === 'object' && typeof p.sub === 'string' && isRole(p.role)) {
      return { login: p.sub, role: p.role };
    }
  } catch {
    // an expired or forged cookie is the same as no cookie
  }
  return null;
}

// Routes name the view they serve and the guard compares it with the acting
// role, so a controller never checks roles by hand. The same pattern runs in
// his NestJS back ends' role guards. Routes with neither decorator pass
// untouched, which is why this can sit on every route as a global guard.
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const view = this.reflector.getAllAndOverride<AdminView | undefined>(READS_KEY, targets);
    const writes = this.reflector.getAllAndOverride<boolean | undefined>(WRITES_KEY, targets);
    if (!view && !writes) return true;

    const req = ctx.switchToHttp().getRequest<ActingRequest>();
    const admin = readAdminCookie(req);

    if (writes) {
      if (!admin) deny(401, 'login required');
      if (admin.role !== 'admin') deny(403, `${admin.role} cannot write`);
      req.acting = { role: admin.role, login: admin.login };
      return true;
    }

    // An admin may preview another role with ?as=; everyone else is read-only
    // and picks the role to view as, defaulting to admin.
    const as = req.query.as;
    if (as !== undefined && !isRole(as)) deny(400, 'unknown role');
    const role: Role = (as as Role | undefined) ?? admin?.role ?? 'admin';
    req.acting = { role, login: admin?.login };

    if (view && !READS[role].includes(view)) deny(403, `${role} cannot see ${view}`);
    return true;
  }
}
