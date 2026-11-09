import { Module } from '@nestjs/common';
import { ApplyConsumer } from './apply.consumer';
import { APPLY_HOOKS, ApplyService, noHooks } from './apply.service';
import { SweepService } from './sweep.service';

// Worker only: the API never consumes the apply queue or runs the sweep.
@Module({
  providers: [ApplyService, ApplyConsumer, SweepService, { provide: APPLY_HOOKS, useFactory: noHooks }],
})
export class ApplyModule {}
