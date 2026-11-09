import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AdminAuthController } from './admin-auth.controller';
import { RolesGuard } from './roles.guard';

@Module({
  controllers: [AdminAuthController],
  providers: [{ provide: APP_GUARD, useClass: RolesGuard }],
})
export class AuthModule {}
