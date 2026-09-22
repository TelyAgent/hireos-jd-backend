import { gzipSync, gunzipSync } from 'node:zlib';

/**
 * ByteDance's "SAUC bigmodel" realtime ASR binary protocol, ported from the old project's
 * `doubaoinput/provider.py` (`_client_packet`/`_parse_seed_response`). Byte-for-byte compatible with
 * that implementation — this is a wire protocol owned by ByteDance, not something we get to redesign.
 */
const PROTOCOL_VERSION = 1;
const HEADER_WORDS = 1;
export const FULL_CLIENT_REQUEST = 0b0001;
export const AUDIO_ONLY_REQUEST = 0b0010;
const FULL_SERVER_RESPONSE = 0b1001;
const SERVER_ERROR_RESPONSE = 0b1111;
export const HAS_SEQUENCE = 0b0001;
export const LAST_SEQUENCE = 0b0010;
const JSON_SERIALIZATION = 0b0001;
const NO_SERIALIZATION = 0b0000;
const GZIP_COMPRESSION = 0b0001;

export function fullRequestPacket(sequence: number, value: unknown): Buffer {
  return clientPacket({
    messageType: FULL_CLIENT_REQUEST,
    flags: HAS_SEQUENCE,
    serialization: JSON_SERIALIZATION,
    sequence,
    payload: Buffer.from(JSON.stringify(value), 'utf-8'),
  });
}

export function audioPacket(sequence: number, audio: Buffer, isLast: boolean): Buffer {
  const flags = HAS_SEQUENCE | (isLast ? LAST_SEQUENCE : 0);
  const wireSequence = isLast ? -Math.abs(sequence) : sequence;
  return clientPacket({
    messageType: AUDIO_ONLY_REQUEST,
    flags,
    serialization: NO_SERIALIZATION,
    sequence: wireSequence,
    payload: audio,
  });
}

function clientPacket(params: { messageType: number; flags: number; serialization: number; sequence: number; payload: Buffer }): Buffer {
  const compressed = gzipSync(params.payload);
  const header = Buffer.from([
    (PROTOCOL_VERSION << 4) | HEADER_WORDS,
    (params.messageType << 4) | params.flags,
    (params.serialization << 4) | GZIP_COMPRESSION,
    0,
  ]);
  const sequenceBuffer = Buffer.alloc(4);
  sequenceBuffer.writeInt32BE(params.sequence, 0);
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(compressed.length, 0);
  return Buffer.concat([header, sequenceBuffer, lengthBuffer, compressed]);
}

export type SeedResponse = {
  messageType: number;
  isLast: boolean;
  sequence: number | null;
  code: number | null;
  payload: Record<string, unknown>;
};

export class DoubaoProtocolError extends Error {}

export function parseSeedResponse(raw: Buffer): SeedResponse {
  if (raw.length < 4) throw new DoubaoProtocolError('invalid frame');

  const version = raw[0] >> 4;
  const headerSize = (raw[0] & 0x0f) * 4;
  const messageType = raw[1] >> 4;
  const flags = raw[1] & 0x0f;
  const serialization = raw[2] >> 4;
  const compression = raw[2] & 0x0f;
  if (version !== PROTOCOL_VERSION || headerSize < 4 || raw.length < headerSize) throw new DoubaoProtocolError('invalid frame');

  let offset = headerSize;
  let sequence: number | null = null;
  let code: number | null = null;
  if (messageType === SERVER_ERROR_RESPONSE) {
    if (raw.length < offset + 4) throw new DoubaoProtocolError('invalid frame');
    code = raw.readInt32BE(offset);
    offset += 4;
  } else if (flags & HAS_SEQUENCE) {
    if (raw.length < offset + 4) throw new DoubaoProtocolError('invalid frame');
    sequence = raw.readInt32BE(offset);
    offset += 4;
  }

  if (raw.length < offset + 4) throw new DoubaoProtocolError('invalid frame');
  const payloadSize = raw.readUInt32BE(offset);
  offset += 4;
  if (raw.length !== offset + payloadSize) throw new DoubaoProtocolError('invalid frame');
  let payloadBytes = raw.subarray(offset);

  if (compression === GZIP_COMPRESSION) {
    try {
      payloadBytes = gunzipSync(payloadBytes);
    } catch {
      throw new DoubaoProtocolError('invalid frame');
    }
  } else if (compression !== 0) {
    throw new DoubaoProtocolError('invalid frame');
  }

  let payload: unknown;
  if (serialization === JSON_SERIALIZATION || (serialization === NO_SERIALIZATION && messageType === SERVER_ERROR_RESPONSE)) {
    try {
      payload = JSON.parse(payloadBytes.toString('utf-8'));
    } catch {
      if (serialization === NO_SERIALIZATION) payload = {};
      else throw new DoubaoProtocolError('invalid frame');
    }
  } else {
    throw new DoubaoProtocolError('invalid frame');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new DoubaoProtocolError('invalid frame');

  return {
    messageType,
    isLast: Boolean(flags & LAST_SEQUENCE),
    sequence,
    code,
    payload: payload as Record<string, unknown>,
  };
}

export function isServerErrorResponse(response: SeedResponse): boolean {
  return response.messageType === SERVER_ERROR_RESPONSE;
}

export function isFullServerResponse(response: SeedResponse): boolean {
  return response.messageType === FULL_SERVER_RESPONSE;
}
