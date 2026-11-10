import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Reads, Writes } from '../auth/roles';
import { ActingRequest } from '../auth/roles.guard';
import { ReadLimitGuard } from '../read-limit.guard';
import { AdminService } from './admin.service';

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);

// The guard reads the role from the cookie or ?as=, so none of these check it.
// The reads are open to anyone, hence the per-address limit.
@Controller('admin')
@UseGuards(ReadLimitGuard)
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

  @Get('pnl/periods')
  @Reads('pnl')
  periods() {
    return this.admin.periods();
  }

  @Get('pnl/postings')
  @Reads('pnl')
  postings(
    @Query('period') period?: unknown,
    @Query('kind') kind?: unknown,
    @Query('late') late?: unknown,
    @Query('excludeSim') excludeSim?: unknown,
    @Query('after') after?: unknown,
  ) {
    return this.admin.postings({
      period: str(period),
      kind: str(kind),
      late: str(late),
      excludeSim: excludeSim === '1',
      after: str(after),
    });
  }

  @Get('pnl')
  @Reads('pnl')
  pnl(@Query('period') period?: unknown, @Query('excludeSim') excludeSim?: unknown) {
    return this.admin.pnl(str(period), excludeSim === '1');
  }

  @Get('payroll/scans')
  @Reads('payroll')
  scans(@Query('day') day?: unknown, @Query('worker') worker?: unknown) {
    return this.admin.scans(str(day), str(worker));
  }

  @Get('payroll')
  @Reads('payroll')
  payroll(@Query('day') day?: unknown) {
    return this.admin.payroll(str(day));
  }

  @Get('stock')
  @Reads('stock')
  stock() {
    return this.admin.stock();
  }

  @Get('stock/:code/movements')
  @Reads('stock')
  movements(@Param('code') code: string) {
    return this.admin.movements(code);
  }

  @Post('stock/adjust')
  @Writes()
  adjust(@Req() req: ActingRequest, @Body() body: unknown) {
    return this.admin.adjust({ login: req.acting.login ?? 'admin', role: req.acting.role }, body);
  }

  @Post('close')
  @Writes()
  close(@Req() req: ActingRequest, @Body() body: unknown) {
    return this.admin.close({ login: req.acting.login ?? 'admin', role: req.acting.role }, body);
  }

  // Open to anyone: it is the "try breaking it" button. Its own limits sit in
  // the service, under the read limit every route here has.
  @Post('stock/stress')
  stress(@Req() req: ActingRequest) {
    return this.admin.stress(req.ip ?? '');
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
