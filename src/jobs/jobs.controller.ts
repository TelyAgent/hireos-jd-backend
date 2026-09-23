import { BadRequestException, Controller, Delete, Get, Headers, Param, Query, Req, UseGuards } from '@nestjs/common';
import { WorkspaceGuard, type Identity } from '../auth/workspace.guard';
import { CoreRecordClient } from '../core/core-record.client';

/**
 * Thin passthrough to Core Record's job directory — no composition with the JD backend's own
 * `JobDraft`/approval data yet (Core Record's Job model only has title/team/location/employmentType/
 * openings/status/version). The frontend fills in the richer JD-Library-specific fields (department,
 * hiring manager, approval state, active role version, ...) with sensible defaults where this response
 * doesn't have them.
 */
@Controller('jobs')
@UseGuards(WorkspaceGuard)
export class JobsController {
  constructor(private readonly coreRecord: CoreRecordClient) {}

  @Get()
  list(@Req() req: { identity: Identity }, @Query('q') q?: string) {
    return this.coreRecord.listJobs(req.identity, q);
  }

  @Get(':id')
  get(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.coreRecord.getJob(req.identity, id);
  }

  @Delete(':id')
  delete(@Req() req: { identity: Identity }, @Headers() headers: Record<string, string | undefined>, @Param('id') id: string) {
    const idempotencyKey = headers['idempotency-key']?.trim();
    if (!idempotencyKey) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    return this.coreRecord.deleteJob(req.identity, id, idempotencyKey);
  }
}
