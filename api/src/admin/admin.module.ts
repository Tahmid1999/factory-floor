import { Module } from '@nestjs/common';
import { HoodModule } from '../hood/hood.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

// API only.
@Module({
  imports: [HoodModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
