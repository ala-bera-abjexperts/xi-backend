import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';

import configuration from '../config/configuration';
import { validateEnv } from '../config/env.validation';
import { TestManagementModule } from '../test-management/test-management.module';

/** The graph of the runner process: Test Management and what it needs, without the HTTP app. */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    TestManagementModule,
  ],
})
export class RunnerWorkerModule {}
