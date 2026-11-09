import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { Rabbit } from './rabbit';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: Rabbit,
  ) {}

  @Get()
  async check() {
    const [postgres, rabbit] = await Promise.all([
      this.prisma.$queryRaw`SELECT 1`.then(() => 'ok', () => 'down'),
      this.rabbit.ping().then(() => 'ok', () => 'down'),
    ]);
    const body = { postgres, rabbit };
    if (postgres !== 'ok' || rabbit !== 'ok') throw new ServiceUnavailableException(body);
    return body;
  }
}
