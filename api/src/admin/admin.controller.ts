import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { Reads, Writes } from '../auth/roles';
import { ActingRequest } from '../auth/roles.guard';
import { AdminService } from './admin.service';

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);

// The guard reads the role from the cookie or ?as=, so none of these check it.
@Controller('admin')
export class AdminController {
  constructor(@Inject(AdminService) private readonly admin: AdminService) {}

  @Get('floor')
  @Reads('floor')
  floor() {
    return this.admin.floor();
  }

  @Get('bundles')
  @Reads('bundles')
  bundles(@Query('q') q?: unknown) {
    return this.admin.bundles(str(q));
  }

  @Get('bundles/:code')
  @Reads('bundles')
  bundle(@Param('code') code: string) {
    return this.admin.bundle(code);
  }

  @Get('held')
  @Reads('held')
  held() {
    return this.admin.held();
  }

  @Get('stations')
  @Reads('stations')
  stations() {
    return this.admin.stations();
  }

  @Get('audit')
  @Reads('audit')
  audit(@Query('action') action?: unknown) {
    return this.admin.audit(str(action));
  }

  @Post('rates')
  @Writes()
  rates(@Req() req: ActingRequest, @Body() body: unknown) {
    return this.admin.setRate({ login: req.acting.login ?? 'admin', role: req.acting.role }, body);
  }

  @Post('reset')
  @Writes()
  @HttpCode(201)
  reset(@Req() req: ActingRequest) {
    return this.admin.reset({ login: req.acting.login ?? 'admin', role: req.acting.role });
  }
}
