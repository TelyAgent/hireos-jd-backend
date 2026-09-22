import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../persistence/prisma.service';
import { CoreRecordClient } from '../core/core-record.client';
import { DraftsController } from './drafts.controller';
import { DraftsService } from './drafts.service';

@Module({
  imports: [AuthModule],
  controllers: [DraftsController],
  providers: [PrismaService, CoreRecordClient, DraftsService],
  exports: [DraftsService],
})
export class DraftsModule {}
