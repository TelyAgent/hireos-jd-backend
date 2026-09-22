import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Identity } from '../auth/workspace.guard';
import { CoreRecordClient } from '../core/core-record.client';
import { PrismaService } from '../persistence/prisma.service';
import { findIdempotent, json, storeIdempotency, type RequestMeta } from '../records';

const inputSchema = z.object({
  roleSummary: z.string().trim().max(10000).optional(),
  responsibilities: z.array(z.string().trim().min(1)).max(100).optional(),
  requirements: z.array(z.record(z.string(), z.unknown())).max(200).optional(),
  dimensions: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
  hiringContext: z.record(z.string(), z.unknown()).optional(),
  successCriteria: z.array(z.record(z.string(), z.unknown())).optional(),
  internalCompensation: z.record(z.string(), z.unknown()).nullable().optional(),
  publicCompensation: z.record(z.string(), z.unknown()).nullable().optional(),
  sourceRefs: z.array(z.unknown()).optional(),
  origin: z.enum(['jd_module', 'foundation_confirmed', 'external_import']).optional(),
}).strict();

@Injectable()
export class DraftsService {
  constructor(
    private readonly db: PrismaService,
    private readonly core: CoreRecordClient,
  ) {}

  async current(identity: Identity, jobId: string) {
    const draft = await this.db.jobDraft.findFirst({
      where: { workspaceId: identity.workspaceId, jobId },
      orderBy: { revision: 'desc' },
    });
    if (!draft) throw new NotFoundException({ code: 'DRAFT_NOT_FOUND' });
    const role = await this.core.getRoleVersion(identity, jobId, draft.coreRoleVersionId);
    return serialize(draft, role);
  }

  async updateCurrent(identity: Identity, jobId: string, raw: unknown, meta: RequestMeta) {
    const input = inputSchema.parse(raw);
    const current = await this.db.jobDraft.findFirst({
      where: { workspaceId: identity.workspaceId, jobId },
      orderBy: { revision: 'desc' },
    });
    if (!current) return this.create(identity, jobId, input, meta);
    if (current.status === 'confirmed') throw new ConflictException({ code: 'DRAFT_NOT_EDITABLE' });
    const coreRole = await this.core.updateRoleVersion(
      identity,
      jobId,
      current.coreRoleVersionId,
      input,
      `jd:role-version:update:${identity.workspaceId}:${current.coreRoleVersionId}:${hash(input)}`,
    );
    return this.db.$transaction(async (tx) => {
      const prior = await findIdempotent(tx, identity, `draft.current.update:${jobId}`, meta, input);
      if (prior.prior) return prior.prior.responseBody;
      const draft = await tx.jobDraft.update({
        where: { id: current.id },
        data: {
          ...(input.roleSummary === undefined ? {} : { roleSummary: input.roleSummary }),
          ...(input.responsibilities === undefined ? {} : { responsibilities: json(input.responsibilities) }),
          ...(input.requirements === undefined ? {} : { requirements: json(input.requirements) }),
          ...(input.dimensions === undefined ? {} : { dimensions: json(input.dimensions) }),
          hiringContext: input.hiringContext === undefined ? undefined : json(input.hiringContext),
          successCriteria: input.successCriteria === undefined ? undefined : json(input.successCriteria),
          internalCompensation: input.internalCompensation === undefined ? undefined : json(input.internalCompensation),
          publicCompensation: input.publicCompensation === undefined ? undefined : json(input.publicCompensation),
          ...(input.sourceRefs === undefined ? {} : { sourceRefs: json(input.sourceRefs) }),
          ...(input.origin === undefined ? {} : { origin: input.origin }),
          contentHash: `sha256:${hash(input)}`,
        },
      });
      const result = serialize(draft, coreRole);
      await storeIdempotency(tx, identity, `draft.current.update:${jobId}`, prior.key, prior.hash, result);
      return result;
    });
  }

  async confirmCurrent(identity: Identity, jobId: string, raw: unknown, meta: RequestMeta) {
    const draft = await this.db.jobDraft.findFirst({
      where: { workspaceId: identity.workspaceId, jobId },
      orderBy: { revision: 'desc' },
    });
    if (!draft) throw new NotFoundException({ code: 'DRAFT_NOT_FOUND' });
    return this.confirm(identity, jobId, draft.id, raw, meta);
  }

  async reopenCurrent(identity: Identity, jobId: string, _raw: unknown, meta: RequestMeta) {
    const current = await this.db.jobDraft.findFirst({
      where: { workspaceId: identity.workspaceId, jobId },
      orderBy: { revision: 'desc' },
    });
    if (!current) throw new NotFoundException({ code: 'DRAFT_NOT_FOUND' });
    if (current.status !== 'confirmed') return this.current(identity, jobId);
    const input = {
      roleSummary: current.roleSummary || undefined,
      responsibilities: asStringArray(current.responsibilities),
      requirements: asRecordArray(current.requirements),
      dimensions: asRecordArray(current.dimensions),
      hiringContext: asRecord(current.hiringContext) || undefined,
      successCriteria: asRecordArray(current.successCriteria),
      internalCompensation: asRecord(current.internalCompensation),
      publicCompensation: asRecord(current.publicCompensation),
      sourceRefs: asArray(current.sourceRefs),
      origin: current.origin,
    };
    return this.create(identity, jobId, input, meta);
  }

  async create(identity: Identity, jobId: string, raw: unknown, meta: RequestMeta) {
    const input = normalizeInput(inputSchema.parse(raw));
    const coreRole = await this.core.createRoleVersion(identity, jobId, input, `jd:role-version:create:${identity.workspaceId}:${jobId}:${hash(input)}`);
    return this.db.$transaction(async (tx) => {
      const prior = await findIdempotent(tx, identity, `draft.create:${jobId}`, meta, input);
      if (prior.prior) return prior.prior.responseBody;
      const latest = await tx.jobDraft.findFirst({ where: { workspaceId: identity.workspaceId, jobId }, orderBy: { revision: 'desc' } });
      const draft = await tx.jobDraft.create({
        data: {
          workspaceId: identity.workspaceId,
          jobId,
          coreRoleVersionId: coreRole.id,
          revision: (latest?.revision || 0) + 1,
          roleSummary: input.roleSummary,
          responsibilities: json(input.responsibilities),
          requirements: json(input.requirements),
          dimensions: json(input.dimensions),
          hiringContext: input.hiringContext === undefined ? undefined : json(input.hiringContext),
          successCriteria: input.successCriteria === undefined ? undefined : json(input.successCriteria),
          internalCompensation: input.internalCompensation === undefined ? undefined : json(input.internalCompensation),
          publicCompensation: input.publicCompensation === undefined ? undefined : json(input.publicCompensation),
          sourceRefs: json(input.sourceRefs),
          origin: input.origin,
          contentHash: `sha256:${hash(input)}`,
          createdBy: identity.actorId,
        },
      });
      const result = serialize(draft, coreRole);
      await storeIdempotency(tx, identity, `draft.create:${jobId}`, prior.key, prior.hash, result);
      return result;
    });
  }

  async confirm(identity: Identity, jobId: string, draftId: string, raw: unknown, meta: RequestMeta) {
    const draft = await this.db.jobDraft.findFirst({ where: { id: draftId, workspaceId: identity.workspaceId, jobId } });
    if (!draft) throw new NotFoundException({ code: 'NOT_FOUND' });
    if (draft.status === 'confirmed') return this.current(identity, jobId);
    await this.core.confirmRoleVersion(identity, jobId, draft.coreRoleVersionId, raw || {}, `jd:role-version:confirm:${identity.workspaceId}:${draft.coreRoleVersionId}`);
    return this.db.$transaction(async (tx) => {
      const prior = await findIdempotent(tx, identity, `draft.confirm:${draftId}`, meta, raw || {});
      if (prior.prior) return prior.prior.responseBody;
      const updated = await tx.jobDraft.update({ where: { id: draftId }, data: { status: 'confirmed' } });
      const role = await this.core.getRoleVersion(identity, jobId, updated.coreRoleVersionId);
      const result = serialize(updated, role);
      await storeIdempotency(tx, identity, `draft.confirm:${draftId}`, prior.key, prior.hash, result);
      return result;
    });
  }
}

function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String) : [];
}

function asRecordArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : [];
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizeInput(input: z.infer<typeof inputSchema>) {
  return {
    roleSummary: input.roleSummary,
    responsibilities: input.responsibilities || [],
    requirements: input.requirements || [],
    dimensions: input.dimensions || [],
    hiringContext: input.hiringContext,
    successCriteria: input.successCriteria,
    internalCompensation: input.internalCompensation,
    publicCompensation: input.publicCompensation,
    sourceRefs: input.sourceRefs || [],
    origin: input.origin || 'jd_module',
  };
}

function serialize(row: {
  id: string;
  jobId: string;
  coreRoleVersionId: string;
  revision: number;
  status: string;
  roleSummary: string | null;
  responsibilities: unknown;
  requirements: unknown;
  dimensions: unknown;
  hiringContext: unknown;
  successCriteria: unknown;
  internalCompensation: unknown;
  publicCompensation: unknown;
  sourceRefs: unknown;
  origin: string;
  mappingStatus: string;
  contentHash: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}, role?: { versionNo?: number; status?: string; confirmedBy?: string; confirmedAt?: string }) {
  return {
    id: row.id,
    jobId: row.jobId,
    coreRoleVersionId: row.coreRoleVersionId,
    roleVersionNo: role?.versionNo,
    roleVersionStatus: role?.status,
    roleConfirmedBy: role?.confirmedBy,
    roleConfirmedAt: role?.confirmedAt,
    revision: row.revision,
    status: row.status,
    roleSummary: row.roleSummary || undefined,
    responsibilities: row.responsibilities,
    requirements: row.requirements,
    dimensions: row.dimensions,
    hiringContext: row.hiringContext,
    successCriteria: row.successCriteria,
    internalCompensation: row.internalCompensation,
    publicCompensation: row.publicCompensation,
    sourceRefs: row.sourceRefs,
    origin: row.origin,
    mappingStatus: row.mappingStatus,
    contentHash: row.contentHash,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
