import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CoreRecordClient } from '../core/core-record.client';
import { JobsController } from './jobs.controller';

@Module({
  imports: [AuthModule],
  controllers: [JobsController],
  providers: [CoreRecordClient],
})
export class JobsModule {}
