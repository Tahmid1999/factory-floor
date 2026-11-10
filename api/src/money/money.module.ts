import { Module } from '@nestjs/common';
import { HoodModule } from '../hood/hood.module';
import { CloseService } from './close.service';

// API only.
@Module({
  imports: [HoodModule],
  providers: [CloseService],
  exports: [CloseService],
})
export class MoneyModule {}
