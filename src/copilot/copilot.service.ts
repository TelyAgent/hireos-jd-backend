import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Identity } from '../auth/workspace.guard';
import { extractTextFromFile } from './attachment-extract';
import { CoreRecordClient } from '../core/core-record.client';
import { DraftsService } from '../drafts/drafts.service';
import { PrismaService } from '../persistence/prisma.service';
import { findIdempotent, json, requestHash, storeIdempotency, type RequestMeta } from '../records';
import { LlmProvider, type ChatTurn } from './llm-provider';
import { PromptRegistry } from './prompt-registry';
import { ReplyStreamExtractor } from './reply-stream-extractor';
import { computeMissingFields, llmTurnResultSchema, sendMessageInputSchema, type JdFields, type LlmTurnResult } from './types';

export type UploadedAttachment = { buffer: Buffer; mimetype: string; originalname: string; size: number };

type ConversationRow = {
  id: string;
  jobId: string | null;
  phase: string;
  fields: unknown;
  missingFields: unknown;
  stateRevision: number;
  createdAt: Date;
  updatedAt: Date;
};

type MessageRow = { id: string; role: string; text: string | null; attachments: unknown; sequence: number; createdAt: Date };

type SerializedConversation = ReturnType<typeof serializeConversation>;

type TurnPrep =
  | { cached: SerializedConversation }
  | {
      cached: null;
      operation: string;
      key: string;
      hash: string;
      userMessage: { text: string; attachments?: unknown };
      capabilityCode: string;
      turns: ChatTurn[];
      currentFields: JdFields;
    };

@Injectable()
export class CopilotService {
  private readonly logger = new Logger(CopilotService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly llm: LlmProvider,
    private readonly prompts: PromptRegistry,
    private readonly core: CoreRecordClient,
    private readonly drafts: DraftsService,
  ) {}

  async createConversation(identity: Identity, meta: RequestMeta) {
    return this.db.$transaction(async (tx) => {
      const prior = await findIdempotent(tx, identity, 'copilot.conversation.create', meta, {});
      if (prior.prior) return prior.prior.responseBody;
      const conversation = await tx.copilotConversation.create({
        data: { workspaceId: identity.workspaceId, actorId: identity.actorId },
      });
      const result = serializeConversation(conversation, []);
      await storeIdempotency(tx, identity, 'copilot.conversation.create', prior.key, prior.hash, result);
      return result;
    });
  }

  /** Basic AI-run health signal: counts by capability/status, for a minimal failure-rate view. */
  async getAiRunStats(identity: Identity) {
    const rows = await this.db.aiRun.groupBy({
      by: ['capabilityCode', 'status'],
      where: { workspaceId: identity.workspaceId },
      _count: { _all: true },
      orderBy: [{ capabilityCode: 'asc' }, { status: 'asc' }],
    });
    return rows.map((row) => ({ capabilityCode: row.capabilityCode, status: row.status, count: row._count._all }));
  }

  async listConversations(identity: Identity) {
    const conversations = await this.db.copilotConversation.findMany({
      where: { workspaceId: identity.workspaceId, actorId: identity.actorId },
      orderBy: { updatedAt: 'desc' },
      take: 30,
    });
    return conversations.map((conversation) => serializeConversation(conversation, []));
  }

  async getConversation(identity: Identity, id: string) {
    const conversation = await this.loadConversation(identity, id);
    const messages = await this.db.copilotMessage.findMany({ where: { conversationId: id }, orderBy: { sequence: 'asc' } });
    return serializeConversation(conversation, messages);
  }

  async sendMessage(identity: Identity, id: string, raw: unknown, meta: RequestMeta) {
    const prep = await this.prepareTurn(identity, id, raw, meta);
    if (prep.cached) return prep.cached;
    const parsed = await this.runIntakeTurn(identity, id, prep.turns);
    return this.commitTurn(identity, id, prep, parsed);
  }

  /** Same turn as `sendMessage`, but streams the assistant's reply text via `onDelta` as it's generated. */
  async streamMessage(identity: Identity, id: string, raw: unknown, meta: RequestMeta, onDelta: (text: string) => void) {
    const prep = await this.prepareTurn(identity, id, raw, meta);
    if (prep.cached) return prep.cached;
    const parsed = await this.runIntakeTurnStream(identity, id, prep.turns, onDelta);
    return this.commitTurn(identity, id, prep, parsed);
  }

  // Idempotency and the LLM call are resolved BEFORE opening a DB transaction: an LLM round trip
  // routinely takes several seconds, well past Prisma's default 5s interactive-transaction timeout,
  // so holding a transaction open across it would abort the write with a P2028 error.
  private async prepareTurn(identity: Identity, id: string, raw: unknown, meta: RequestMeta): Promise<TurnPrep> {
    const input = sendMessageInputSchema.parse(raw);
    const conversation = await this.loadConversation(identity, id);
    if (conversation.phase === 'completed') throw new ConflictException({ code: 'CONVERSATION_COMPLETED' });

    const key = meta.idempotencyKey?.trim();
    if (!key) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    const operation = `copilot.message:${id}`;
    const hash = requestHash(input);

    const existing = await this.db.idempotencyKey.findUnique({
      where: { workspaceId_operation_key: { workspaceId: identity.workspaceId, operation, key } },
    });
    if (existing) {
      if (existing.requestHash !== hash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT' });
      return { cached: existing.responseBody as unknown as SerializedConversation };
    }

    const history = await this.db.copilotMessage.findMany({ where: { conversationId: id }, orderBy: { sequence: 'asc' } });
    const turns: ChatTurn[] = [
      ...history.map((message) => ({ role: message.role as 'user' | 'assistant', content: message.text || '' })),
      { role: 'user', content: input.text },
    ];
    return {
      cached: null,
      operation,
      key,
      hash,
      userMessage: { text: input.text },
      capabilityCode: 'jd_intake_turn',
      turns,
      currentFields: asRecord(conversation.fields) as JdFields,
    };
  }

  private async commitTurn(
    identity: Identity,
    id: string,
    prep: Extract<TurnPrep, { cached: null }>,
    parsed: LlmTurnResult,
  ): Promise<SerializedConversation> {
    const { operation, key, hash, userMessage, capabilityCode, currentFields } = prep;
    const mergedFields: JdFields = { ...currentFields, ...parsed.fields };
    const missingFields = computeMissingFields(mergedFields);
    const phase = missingFields.length === 0 ? 'ready_to_confirm' : 'intake';

    try {
      return await this.db.$transaction(async (tx) => {
        const prior = await tx.idempotencyKey.findUnique({
          where: { workspaceId_operation_key: { workspaceId: identity.workspaceId, operation, key } },
        });
        if (prior) {
          if (prior.requestHash !== hash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT' });
          return prior.responseBody as unknown as SerializedConversation;
        }
        // This UPDATE is also the concurrency lock point: Postgres holds a row lock on the conversation
        // for the rest of this transaction, so a second concurrent turn on the same conversation blocks
        // here until this one commits. Only after acquiring it do we look up the *current* max sequence
        // — using the sequence captured back in prepareTurn (before the slow LLM call) would let two
        // concurrent turns compute the same number and collide on the (conversationId, sequence)
        // constraint, which is exactly what an earlier version of this code did.
        const updated = await tx.copilotConversation.update({
          where: { id },
          data: {
            fields: json(mergedFields),
            missingFields: json(missingFields),
            phase,
            stateRevision: { increment: 1 },
          },
        });
        const latest = await tx.copilotMessage.findFirst({ where: { conversationId: id }, orderBy: { sequence: 'desc' } });
        const userSequence = (latest?.sequence ?? 0) + 1;
        await tx.copilotMessage.create({
          data: {
            conversationId: id,
            sequence: userSequence,
            role: 'user',
            text: userMessage.text,
            attachments: userMessage.attachments === undefined ? undefined : json(userMessage.attachments),
            idempotencyKey: key,
          },
        });
        await tx.copilotMessage.create({
          data: { conversationId: id, sequence: userSequence + 1, role: 'assistant', text: parsed.reply },
        });
        await tx.aiRun.create({
          data: {
            workspaceId: identity.workspaceId,
            conversationId: id,
            capabilityCode,
            status: 'Succeeded',
            resultJson: json(parsed),
          },
        });
        const messages = await tx.copilotMessage.findMany({ where: { conversationId: id }, orderBy: { sequence: 'asc' } });
        const result = serializeConversation(updated, messages);
        await tx.idempotencyKey.create({
          data: { workspaceId: identity.workspaceId, operation, key, requestHash: hash, responseBody: json(result) },
        });
        return result;
      });
    } catch (error) {
      // The conversation-row lock above should make this unreachable in practice, but a raw 500 with
      // no explanation is a worse failure mode than an honest "conflict, retry" for any P2002 this
      // transaction didn't anticipate — e.g. the same Idempotency-Key racing itself.
      if (error instanceof ConflictException) throw error;
      if (isUniqueConstraintError(error)) {
        throw new ConflictException({ code: 'CONVERSATION_BUSY', message: '当前会话正在处理另一条消息，请重试。' });
      }
      throw error;
    }
  }

  async confirmDraft(identity: Identity, id: string, meta: RequestMeta) {
    const conversation = await this.loadConversation(identity, id);
    if (conversation.jobId) return { conversationId: conversation.id, jobId: conversation.jobId };
    if (conversation.phase !== 'ready_to_confirm') throw new ConflictException({ code: 'CONVERSATION_NOT_READY' });

    const key = meta.idempotencyKey?.trim();
    if (!key) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });

    const fields = asRecord(conversation.fields) as JdFields;

    // Job (title/team/location/headcount) is owned by the Core Record service; JobDraft (JD content)
    // is owned by this service and always hangs off an existing Job. Deterministic keys derived from
    // the caller's Idempotency-Key make retrying this whole action safe: Core and DraftsService each
    // do their own idempotent create, so a retry after a partial failure reuses the same Job/Draft
    // instead of creating duplicates.
    const job = await this.core.createJob(
      identity,
      {
        title: fields.title,
        team: fields.department,
        location: fields.location,
        employmentType: fields.employmentType,
        openings: fields.headcount,
      },
      `copilot.confirm-draft:${id}:job:${key}`,
    );

    // Core's role-version schema requires each requirement to carry id/label/dimension/hard/kind
    // (see hireos-core-record's RoleVersionsService requirementSchema) — a `statement` string alone
    // isn't enough. This service doesn't yet have a real dimension taxonomy, so everything collected
    // by the JD-intake chat lands under a generic "experience" dimension for now.
    const requirements = [
      ...(fields.mustHave || []).map((label, index) => ({
        id: `must-${index}`,
        label,
        dimension: 'experience',
        priority: 'must_have' as const,
        hard: true,
        kind: 'general',
      })),
      ...(fields.niceToHave || []).map((label, index) => ({
        id: `nice-${index}`,
        label,
        dimension: 'experience',
        priority: 'preferred' as const,
        hard: false,
        kind: 'general',
      })),
    ];
    const draft = await this.drafts.create(
      identity,
      job.id,
      {
        roleSummary: fields.roleSummary,
        responsibilities: fields.responsibilities || [],
        requirements,
        sourceRefs: [{ kind: 'copilot_conversation', id }],
        origin: 'jd_module',
      },
      { ...meta, idempotencyKey: `${key}:draft` },
    );

    await this.db.copilotConversation.update({ where: { id }, data: { jobId: job.id, phase: 'completed' } });
    this.logger.log(`confirm-draft completed: conversation=${id} job=${job.id}`);

    return { conversationId: id, jobId: job.id, draft };
  }

  async processAttachment(identity: Identity, id: string, file: UploadedAttachment, meta: RequestMeta) {
    const conversation = await this.loadConversation(identity, id);
    if (conversation.phase === 'completed') throw new ConflictException({ code: 'CONVERSATION_COMPLETED' });
    const key = meta.idempotencyKey?.trim();
    if (!key) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    const operation = `copilot.attachment:${id}`;
    const attachmentMeta = { filename: file.originalname, mimeType: file.mimetype, size: file.size };
    const hash = requestHash(attachmentMeta);

    const existing = await this.db.idempotencyKey.findUnique({
      where: { workspaceId_operation_key: { workspaceId: identity.workspaceId, operation, key } },
    });
    if (existing) {
      if (existing.requestHash !== hash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT' });
      return existing.responseBody;
    }

    const text = await extractTextFromFile(file.buffer, file.mimetype, file.originalname);
    if (!text) {
      throw new BadRequestException({ code: 'ATTACHMENT_EMPTY', message: '没有从文件中读取到可用的文本内容。' });
    }

    const history = await this.db.copilotMessage.findMany({ where: { conversationId: id }, orderBy: { sequence: 'asc' } });
    const turns: ChatTurn[] = [
      ...history.map((message) => ({ role: message.role as 'user' | 'assistant', content: message.text || '' })),
      { role: 'user', content: `[上传文件：${file.originalname}]\n\n${text}` },
    ];
    const parsed = await this.runFileExtractTurn(identity, id, turns);

    const prep: Extract<TurnPrep, { cached: null }> = {
      cached: null,
      operation,
      key,
      hash,
      userMessage: { text: `[已上传文件] ${file.originalname}`, attachments: [attachmentMeta] },
      capabilityCode: 'jd_file_extract_turn',
      turns,
      currentFields: asRecord(conversation.fields) as JdFields,
    };
    return this.commitTurn(identity, id, prep, parsed);
  }

  /**
   * "Auto-complete and optimize": a deliberately different mode from the conversational intake turn
   * above. Where intake asks one question at a time and refuses to invent facts, this one is a single
   * turn that must fill in every remaining required field with reasonable, clearly-editable
   * industry-standard suggestions and land on `ready_to_confirm` — matching the old project's separate
   * `guided` vs `automatic` creation modes (jd-intake vs jd-autotake), which this service didn't have
   * before: it only ever asked narrow clarifying questions, even when the user explicitly asked for a
   * complete draft instead.
   */
  async autoComplete(identity: Identity, id: string, meta: RequestMeta) {
    const conversation = await this.loadConversation(identity, id);
    if (conversation.phase === 'completed') throw new ConflictException({ code: 'CONVERSATION_COMPLETED' });
    const key = meta.idempotencyKey?.trim();
    if (!key) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    const operation = `copilot.autocomplete:${id}`;
    const userText = '自动补全并优化内容';
    const hash = requestHash({ userText });

    const existing = await this.db.idempotencyKey.findUnique({
      where: { workspaceId_operation_key: { workspaceId: identity.workspaceId, operation, key } },
    });
    if (existing) {
      if (existing.requestHash !== hash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT' });
      return existing.responseBody;
    }

    const history = await this.db.copilotMessage.findMany({ where: { conversationId: id }, orderBy: { sequence: 'asc' } });
    const turns: ChatTurn[] = [
      ...history.map((message) => ({ role: message.role as 'user' | 'assistant', content: message.text || '' })),
      { role: 'user', content: userText },
    ];
    const parsed = await this.runAutoCompleteTurn(identity, id, turns);

    const prep: Extract<TurnPrep, { cached: null }> = {
      cached: null,
      operation,
      key,
      hash,
      userMessage: { text: userText },
      capabilityCode: 'jd_autotake_turn',
      turns,
      currentFields: asRecord(conversation.fields) as JdFields,
    };
    return this.commitTurn(identity, id, prep, parsed);
  }

  private async loadConversation(identity: Identity, id: string): Promise<ConversationRow> {
    const conversation = await this.db.copilotConversation.findFirst({ where: { id, workspaceId: identity.workspaceId } });
    if (!conversation) throw new NotFoundException({ code: 'CONVERSATION_NOT_FOUND' });
    return conversation;
  }

  private async runIntakeTurn(identity: Identity, conversationId: string, turns: ChatTurn[]): Promise<LlmTurnResult> {
    const startedAt = Date.now();
    try {
      const raw = await this.llm.completeJson(this.prompts.jdIntakeSystemPrompt, turns);
      const parsed = llmTurnResultSchema.parse(JSON.parse(raw));
      this.logger.log(`jd_intake_turn succeeded in ${Date.now() - startedAt}ms (conversation=${conversationId})`);
      return parsed;
    } catch (error) {
      throw await this.recordLlmFailure(identity, conversationId, 'jd_intake_turn', error);
    }
  }

  private async runFileExtractTurn(identity: Identity, conversationId: string, turns: ChatTurn[]): Promise<LlmTurnResult> {
    const startedAt = Date.now();
    try {
      const raw = await this.llm.completeJson(this.prompts.jdFileExtractSystemPrompt, turns);
      const parsed = llmTurnResultSchema.parse(JSON.parse(raw));
      this.logger.log(`jd_file_extract_turn succeeded in ${Date.now() - startedAt}ms (conversation=${conversationId})`);
      return parsed;
    } catch (error) {
      throw await this.recordLlmFailure(identity, conversationId, 'jd_file_extract_turn', error);
    }
  }

  private async runAutoCompleteTurn(identity: Identity, conversationId: string, turns: ChatTurn[]): Promise<LlmTurnResult> {
    const startedAt = Date.now();
    try {
      const raw = await this.llm.completeJson(this.prompts.jdAutotakeSystemPrompt, turns);
      const parsed = llmTurnResultSchema.parse(JSON.parse(raw));
      this.logger.log(`jd_autotake_turn succeeded in ${Date.now() - startedAt}ms (conversation=${conversationId})`);
      return parsed;
    } catch (error) {
      throw await this.recordLlmFailure(identity, conversationId, 'jd_autotake_turn', error);
    }
  }

  private async runIntakeTurnStream(
    identity: Identity,
    conversationId: string,
    turns: ChatTurn[],
    onDelta: (text: string) => void,
  ): Promise<LlmTurnResult> {
    const startedAt = Date.now();
    const extractor = new ReplyStreamExtractor();
    let raw = '';
    try {
      for await (const chunk of this.llm.streamJson(this.prompts.jdIntakeSystemPrompt, turns)) {
        raw += chunk;
        const delta = extractor.push(chunk);
        if (delta) onDelta(delta);
      }
      if (!raw) throw new Error('LLM_EMPTY_RESPONSE');
      const parsed = llmTurnResultSchema.parse(JSON.parse(raw));
      this.logger.log(`jd_intake_turn (streamed) succeeded in ${Date.now() - startedAt}ms (conversation=${conversationId})`);
      return parsed;
    } catch (error) {
      throw await this.recordLlmFailure(identity, conversationId, 'jd_intake_turn', error);
    }
  }

  /** Logs and records an `AiRun` failure row, then returns the exception the caller should throw. */
  private async recordLlmFailure(
    identity: Identity,
    conversationId: string,
    capabilityCode: string,
    error: unknown,
  ): Promise<ServiceUnavailableException> {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(`${capabilityCode} failed (conversation=${conversationId}): ${message}`);
    await this.db.aiRun
      .create({
        data: { workspaceId: identity.workspaceId, conversationId, capabilityCode, status: 'Failed', failureCode: 'LLM_INVALID_OUTPUT' },
      })
      .catch(() => undefined);
    return error instanceof ServiceUnavailableException
      ? error
      : new ServiceUnavailableException({ code: 'LLM_INVALID_OUTPUT', message });
  }
}

function serializeConversation(conversation: ConversationRow, messages: MessageRow[]) {
  return {
    id: conversation.id,
    jobId: conversation.jobId,
    phase: conversation.phase,
    fields: conversation.fields,
    missingFields: conversation.missingFields,
    stateRevision: conversation.stateRevision,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      attachments: message.attachments,
      sequence: message.sequence,
      createdAt: message.createdAt,
    })),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
