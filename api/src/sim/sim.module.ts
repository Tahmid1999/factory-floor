import { Module } from '@nestjs/common';
import { SIM_CONFIG, SimService, simConfigFromEnv } from './sim.service';

// Worker only: the sim runs next to the apply consumer and talks to the api
// over http like any other station, so nothing here touches the database.
@Module({
  providers: [SimService, { provide: SIM_CONFIG, useFactory: () => simConfigFromEnv(process.env) }],
})
export class SimModule {}
