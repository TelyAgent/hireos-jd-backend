import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { WorkspaceGuard, type Identity } from '../auth/workspace.guard';
import type { RequestMeta } from '../records';
import { CopilotService } from './copilot.service';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

@Controller('copilot/conversations')
@UseGuards(WorkspaceGuard)
export class CopilotController {
  constructor(private readonly copilot: CopilotService) {}

  @Post()
  create(@Req() req: { identity: Identity }, @Headers() headers: Record<string, string | undefined>) {
    return this.copilot.createConversation(req.identity, meta(headers));
  }

  @Get()
  list(@Req() req: { identity: Identity }) {
    return this.copilot.listConversations(req.identity);
  }

  @Get(':id')
  get(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.copilot.getConversation(req.identity, id);
  }

  @Post(':id/messages')
  async sendMessage(
    @Req() req: { identity: Identity },
    @Headers() headers: Record<string, string | undefined>,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: false }) res: Response,
  ) {
    if (!(headers.accept || '').includes('text/event-stream')) {
      const result = await this.copilot.sendMessage(req.identity, id, body, meta(headers));
      res.json(result);
      return;
    }

    // Once these headers are flushed we've committed to a 200 response: any failure from here on
    // (including validation errors normally thrown as 404/409 before this point) has to be reported
    // as an `error` SSE event instead of an HTTP status code — there's no way to change the status
    // line after the body has started streaming.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const emit = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      const result = await this.copilot.streamMessage(req.identity, id, body, meta(headers), (text) => {
        emit('assistant.delta', { text });
      });
      emit('conversation.committed', result);
    } catch (error) {
      emit('error', errorPayload(error));
    } finally {
      res.end();
    }
  }

  @Post(':id/confirm-draft')
  confirmDraft(
    @Req() req: { identity: Identity },
    @Headers() headers: Record<string, string | undefined>,
    @Param('id') id: string,
  ) {
    return this.copilot.confirmDraft(req.identity, id, meta(headers));
  }

  @Post(':id/attachments')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_ATTACHMENT_BYTES } }))
  uploadAttachment(
    @Req() req: { identity: Identity },
    @Headers() headers: Record<string, string | undefined>,
    @Param('id') id: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException({ code: 'ATTACHMENT_REQUIRED', message: '请选择要上传的文件。' });
    return this.copilot.processAttachment(req.identity, id, file, meta(headers));
  }
}

function meta(headers: Record<string, string | undefined>): RequestMeta {
  return {
    requestId: headers['x-request-id'],
    correlationId: headers['x-correlation-id'],
    idempotencyKey: headers['idempotency-key'],
  };
}

function errorPayload(error: unknown): { code: string; message?: string } {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (response && typeof response === 'object') {
      const { code, message } = response as { code?: string; message?: string };
      return { code: code || 'REQUEST_FAILED', message };
    }
  }
  return { code: 'REQUEST_FAILED', message: error instanceof Error ? error.message : undefined };
}
