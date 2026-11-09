import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { Rabbit } from '../rabbit';
import { ApplyService } from './apply.service';

@Injectable()
export class ApplyConsumer implements OnApplicationBootstrap {
  constructor(
    @Inject(Rabbit) private readonly rabbit: Rabbit,
    @Inject(ApplyService) private readonly applyService: ApplyService,
  ) {}

  // Ack only after commit: Rabbit acks when this handler resolves, and apply
  // resolves only once its transaction has committed. A worker that dies
  // before then leaves the message unacked, so the broker hands it out again.
  // A throw drops the message and leaves the inbox row to the sweep.
  async onApplicationBootstrap() {
    await this.rabbit.consumeApply(async (inboxId) => {
      await this.applyService.apply(inboxId);
    });
  }
}
