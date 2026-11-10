import { Module } from '@nestjs/common';
import { HoodModule } from '../hood/hood.module';
import { StockController } from './stock.controller';

// API only.
@Module({
  imports: [HoodModule],
  controllers: [StockController],
})
export class StockModule {}
