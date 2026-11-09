import { MiddlewareConsumer, Module, NestModule, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { GuestGuard } from './guests.guard';
import { GuestsController } from './guests.controller';
import { GuestsService } from './guests.service';

@Module({
  controllers: [GuestsController],
  providers: [GuestsService, GuestGuard],
  exports: [GuestsService, GuestGuard],
})
export class GuestsModule implements NestModule, OnModuleInit {
  constructor(private readonly host: HttpAdapterHost) {}

  // Set here, not in main.ts, so the e2e app boots with the same settings.
  // Only a loopback hop (the reverse proxy) may supply x-forwarded-for. In a
  // container the proxy reaches a published port as the network gateway, so
  // production adds that address through TRUST_PROXY.
  onModuleInit() {
    this.host.httpAdapter.getInstance().set('trust proxy', process.env.TRUST_PROXY ?? 'loopback');
  }

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(cookieParser(process.env.COOKIE_SECRET)).forRoutes('*');
  }
}
