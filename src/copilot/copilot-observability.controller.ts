import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { WorkspaceGuard, type Identity } from '../auth/workspace.guard';
import { CopilotService } from './copilot.service';

/**
 * Minimal read-only health signal for the Copilot AI runs (counts by capability/status). Not a real
 * dashboard — just enough to answer "is jd_intake_turn failing a lot right now?" without a direct DB
 * query, until this project has proper observability infrastructure.
 */
@Controller('copilot/observability')
@UseGuards(WorkspaceGuard)
export class CopilotObservabilityController {
  constructor(private readonly copilot: CopilotService) {}

  @Get('ai-runs')
  getAiRunStats(@Req() req: { identity: Identity }) {
    return this.copilot.getAiRunStats(req.identity);
  }
}
