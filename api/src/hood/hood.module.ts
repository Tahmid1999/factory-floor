import { Module } from '@nestjs/common';
import { HoodController } from './hood.controller';
import { HoodService } from './hood';

// API only: the worker publishes to the fanout and keeps no buffer.
@Module({
  controllers: [HoodController],
  providers: [HoodService],
  exports: [HoodService],
})
export class HoodModule {}
