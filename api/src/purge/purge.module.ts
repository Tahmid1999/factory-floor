import { Module } from '@nestjs/common';
import { PurgeService } from './purge.service';

// Worker only: the API never runs the hourly purge.
@Module({ providers: [PurgeService] })
export class PurgeModule {}
