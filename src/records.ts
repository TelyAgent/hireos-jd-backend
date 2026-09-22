import { createHash } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Identity } from './auth/workspace.guard';

export type RequestMeta = { requestId?: string; correlationId?: string; idempotencyKey?: string };

export function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function requestHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function findIdempotent(
  tx: Prisma.TransactionClient,
  identity: Identity,
  operation: string,
  meta: RequestMeta,
  input: unknown,
) {
  const key = meta.idempotencyKey?.trim();
  if (!key) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  const hash = requestHash(input);
  const prior = await tx.idempotencyKey.findUnique({ where: { workspaceId_operation_key: { workspaceId: identity.workspaceId, operation, key } } });
  if (prior && prior.requestHash !== hash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT' });
  return { key, hash, prior };
}

export async function storeIdempotency(
  tx: Prisma.TransactionClient,
  identity: Identity,
  operation: string,
  key: string,
  requestHashValue: string,
  responseBody: unknown,
) {
  await tx.idempotencyKey.create({
    data: { workspaceId: identity.workspaceId, operation, key, requestHash: requestHashValue, responseBody: json(responseBody) },
  });
}
