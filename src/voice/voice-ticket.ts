import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived, HMAC-signed tickets that authorize a single voice WebSocket connection. Ported from
 * the old project's `doubaoinput/tickets.py` (same shape, reimplemented with Node's `crypto` instead
 * of Python's `hmac`/`hashlib` — this is a fresh signing scheme for this service, not required to be
 * byte-compatible with the old one, since issuing and verifying both happen here).
 */
export type VoiceTicketClaims = {
  workspaceId: string;
  actorId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  purpose: 'voice-input';
};

export class VoiceTicketError extends Error {}

export function issueVoiceTicket(params: { secret: string; workspaceId: string; actorId: string; ttlSeconds: number }): string {
  const { secret, workspaceId, actorId, ttlSeconds } = params;
  if (!secret) throw new Error('voice ticket secret is required');
  if (ttlSeconds < 1 || ttlSeconds > 60) throw new Error('voice ticket ttl must be between 1 and 60 seconds');
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims: VoiceTicketClaims = {
    workspaceId,
    actorId,
    nonce: randomBytes(18).toString('base64url'),
    issuedAt,
    expiresAt: issuedAt + ttlSeconds,
    purpose: 'voice-input',
  };
  const payload = base64url(Buffer.from(canonicalJson(claims), 'utf-8'));
  const signature = base64url(createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${signature}`;
}

export function verifyVoiceTicket(token: string, secret: string): VoiceTicketClaims {
  if (!secret) throw new VoiceTicketError('voice ticket is invalid');
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new VoiceTicketError('voice ticket is invalid');
  const [payload, signature] = parts;
  const expected = base64url(createHmac('sha256', secret).update(payload).digest());
  if (!timingSafeEqualStrings(signature, expected)) throw new VoiceTicketError('voice ticket is invalid');

  let claims: VoiceTicketClaims;
  try {
    claims = JSON.parse(fromBase64url(payload).toString('utf-8')) as VoiceTicketClaims;
  } catch {
    throw new VoiceTicketError('voice ticket is invalid');
  }
  if (
    typeof claims !== 'object'
    || claims === null
    || typeof claims.workspaceId !== 'string'
    || typeof claims.actorId !== 'string'
    || typeof claims.nonce !== 'string'
    || claims.nonce.length < 16
    || typeof claims.issuedAt !== 'number'
    || typeof claims.expiresAt !== 'number'
    || claims.purpose !== 'voice-input'
    || claims.expiresAt - claims.issuedAt < 1
    || claims.expiresAt - claims.issuedAt > 60
  ) {
    throw new VoiceTicketError('voice ticket is invalid');
  }
  const now = Math.floor(Date.now() / 1000);
  if (claims.issuedAt > now + 5) throw new VoiceTicketError('voice ticket is invalid');
  if (claims.expiresAt <= now) throw new VoiceTicketError('voice ticket expired');
  return claims;
}

function canonicalJson(value: VoiceTicketClaims): string {
  const sortedKeys = Object.keys(value).sort() as Array<keyof VoiceTicketClaims>;
  const sorted: Record<string, unknown> = {};
  for (const key of sortedKeys) sorted[key] = value[key];
  return JSON.stringify(sorted);
}

function base64url(value: Buffer): string {
  return value.toString('base64url');
}

function fromBase64url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) {
    // Still run a constant-time comparison against a hash of `a` so failure timing doesn't leak length.
    timingSafeEqual(createHash('sha256').update(bufferA).digest(), createHash('sha256').update(bufferA).digest());
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}
