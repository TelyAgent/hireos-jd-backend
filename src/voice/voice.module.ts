import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AudioController } from './audio.controller';

@Module({
  imports: [AuthModule],
  controllers: [AudioController],
})
export class VoiceModule {}
