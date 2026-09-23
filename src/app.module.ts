import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { CopilotModule } from './copilot/copilot.module';
import { DraftsModule } from './drafts/drafts.module';
import { JobsModule } from './jobs/jobs.module';
import { PrismaService } from './persistence/prisma.service';
import { VoiceModule } from './voice/voice.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), AuthModule, DraftsModule, CopilotModule, VoiceModule, JobsModule],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class AppModule {}
