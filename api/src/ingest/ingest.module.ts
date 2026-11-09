import { Module } from '@nestjs/common';
import { GuestsModule } from '../guests/guests.module';
import { HoodModule } from '../hood/hood.module';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';

@Module({
  imports: [GuestsModule, HoodModule],
  controllers: [IngestController],
  providers: [IngestService],
  exports: [IngestService],
})
export class IngestModule {}
