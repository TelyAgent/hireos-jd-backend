import { Body, Controller, Get, Headers, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { WorkspaceGuard, type Identity } from '../auth/workspace.guard';
import type { RequestMeta } from '../records';
import { DraftsService } from './drafts.service';

@Controller('jobs/:jobId/drafts')
@UseGuards(WorkspaceGuard)
export class DraftsController {
  constructor(private readonly drafts: DraftsService) {}

  @Get('current')
  current(@Req() req: { identity: Identity }, @Param('jobId') jobId: string) {
    return this.drafts.current(req.identity, jobId);
  }

  @Patch('current')
  updateCurrent(@Req() req: { identity: Identity }, @Headers() headers: Record<string, string | undefined>, @Param('jobId') jobId: string, @Body() body: unknown) {
    return this.drafts.updateCurrent(req.identity, jobId, body, meta(headers));
  }

  @Post('current/confirm')
  confirmCurrent(@Req() req: { identity: Identity }, @Headers() headers: Record<string, string | undefined>, @Param('jobId') jobId: string, @Body() body: unknown) {
    return this.drafts.confirmCurrent(req.identity, jobId, body, meta(headers));
  }

  @Post('current/reopen')
  reopenCurrent(@Req() req: { identity: Identity }, @Headers() headers: Record<string, string | undefined>, @Param('jobId') jobId: string, @Body() body: unknown) {
    return this.drafts.reopenCurrent(req.identity, jobId, body, meta(headers));
  }

  @Post()
  create(@Req() req: { identity: Identity }, @Headers() headers: Record<string, string | undefined>, @Param('jobId') jobId: string, @Body() body: unknown) {
    return this.drafts.create(req.identity, jobId, body, meta(headers));
  }

  @Post(':draftId/confirm')
  confirm(@Req() req: { identity: Identity }, @Headers() headers: Record<string, string | undefined>, @Param('jobId') jobId: string, @Param('draftId') draftId: string, @Body() body: unknown) {
    return this.drafts.confirm(req.identity, jobId, draftId, body, meta(headers));
  }
}

function meta(headers: Record<string, string | undefined>): RequestMeta {
  return {
    requestId: headers['x-request-id'],
    correlationId: headers['x-correlation-id'],
    idempotencyKey: headers['idempotency-key'],
  };
}
