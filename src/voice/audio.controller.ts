import { Controller, Post, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WorkspaceGuard, type Identity } from '../auth/workspace.guard';
import { issueVoiceTicket } from './voice-ticket';

@Controller('audio')
@UseGuards(WorkspaceGuard)
export class AudioController {
  constructor(private readonly config: ConfigService) {}

  @Post('realtime-ticket')
  createRealtimeTicket(@Req() req: { identity: Identity }) {
    const secret = this.config.get<string>('HIREOS_DOUBAO_TICKET_SECRET', '');
    const apiKey = this.config.get<string>('HIREOS_DOUBAO_API_KEY', '');
    if (!secret || !apiKey) {
      throw new ServiceUnavailableException({ code: 'DOUBAO_INPUT_UNAVAILABLE', message: '流式语音输入服务尚未就绪。' });
    }
    const ttlSeconds = Number(this.config.get<string>('HIREOS_DOUBAO_TICKET_TTL_SECONDS', '45'));
    const ticket = issueVoiceTicket({
      secret,
      workspaceId: req.identity.workspaceId,
      actorId: req.identity.actorId,
      ttlSeconds,
    });
    return { ticket, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
  }
}
