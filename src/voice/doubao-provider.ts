import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { audioPacket, fullRequestPacket, isFullServerResponse, isServerErrorResponse, parseSeedResponse, DoubaoProtocolError } from './doubao-protocol';

/**
 * Node port of the old project's `doubaoinput/provider.py` `DoubaoRealtimeProvider`. Reshaped from
 * Python's pull-based `await socket.recv()` loop into a plain Node `EventEmitter`: Node's single
 * event loop already interleaves the browser-facing socket and this upstream socket naturally, so the
 * `asyncio.wait`-based task racing in the original has no equivalent here — it isn't needed.
 */
export class DoubaoProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export type DoubaoProviderSettings = {
  apiKey: string;
  websocketUrl: string;
  resourceId: string;
  model: string;
  openTimeoutMs: number;
};

export interface DoubaoRealtimeProvider {
  on(event: 'ready', listener: () => void): this;
  on(event: 'partial', listener: (text: string) => void): this;
  on(event: 'final', listener: (text: string) => void): this;
  on(event: 'error', listener: (error: DoubaoProviderError) => void): this;
  on(event: 'closed', listener: () => void): this;
}

export class DoubaoRealtimeProvider extends EventEmitter {
  private socket: WebSocket | null = null;
  private sequence = 1;
  private pendingAudio: Buffer | null = null;
  private readyReceived = false;

  constructor(private readonly settings: DoubaoProviderSettings) {
    super();
  }

  connect(): Promise<void> {
    if (!this.settings.apiKey) {
      return Promise.reject(new DoubaoProviderError('DOUBAO_AUTH_FAILED', 'Doubao realtime is not configured.', false));
    }
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.settings.websocketUrl, {
        headers: {
          'X-Api-Key': this.settings.apiKey,
          'X-Api-Resource-Id': this.settings.resourceId,
          'X-Api-Connect-Id': randomUUID(),
        },
        handshakeTimeout: this.settings.openTimeoutMs,
      });
      const settle = (fn: () => void) => {
        socket.removeListener('open', onOpen);
        socket.removeListener('error', onError);
        socket.removeListener('unexpected-response', onUnexpectedResponse);
        fn();
      };
      const onOpen = () => settle(() => {
        this.socket = socket;
        this.bind(socket);
        resolve();
      });
      const onError = () => settle(() => reject(new DoubaoProviderError('DOUBAO_UNAVAILABLE', 'Doubao realtime is unavailable.', true)));
      const onUnexpectedResponse = (_req: IncomingMessage, res: IncomingMessage) => settle(() => {
        socket.terminate();
        if (res.statusCode === 401 || res.statusCode === 403) {
          reject(new DoubaoProviderError('DOUBAO_AUTH_FAILED', 'Doubao realtime authentication failed.', false));
        } else if (res.statusCode === 429) {
          reject(new DoubaoProviderError('DOUBAO_RATE_LIMITED', 'Doubao realtime is rate limited.', true));
        } else {
          reject(new DoubaoProviderError('DOUBAO_UNAVAILABLE', 'Doubao realtime is unavailable.', true));
        }
      });
      socket.once('open', onOpen);
      socket.once('error', onError);
      socket.once('unexpected-response', onUnexpectedResponse);
    });
  }

  /** Sends the full-client-request handshake; the resulting `ready` event arrives via `on('ready')`. */
  initialize(): void {
    this.sequence = 1;
    this.pendingAudio = null;
    this.readyReceived = false;
    const request = {
      user: { uid: 'hireos-jd-voice' },
      audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
      request: {
        model_name: this.settings.model,
        enable_itn: true,
        enable_punc: true,
        enable_ddc: true,
        show_utterances: true,
        result_type: 'full',
      },
    };
    this.send(fullRequestPacket(this.sequence, request));
    this.sequence += 1;
  }

  /**
   * Buffers one chunk behind so the true final chunk (known only once `commit()` is called) can be
   * sent with the LAST_SEQUENCE flag — matching the old provider's `pending_audio` delay-by-one.
   */
  appendPcm(audio: Buffer): void {
    if (!audio.length) return;
    if (this.pendingAudio !== null) {
      this.send(audioPacket(this.sequence, this.pendingAudio, false));
      this.sequence += 1;
    }
    this.pendingAudio = audio;
  }

  commit(): void {
    const audio = this.pendingAudio ?? Buffer.alloc(0);
    this.pendingAudio = null;
    this.send(audioPacket(this.sequence, audio, true));
    this.sequence += 1;
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.pendingAudio = null;
    socket?.close();
  }

  private bind(socket: WebSocket): void {
    socket.on('message', (data, isBinary) => {
      try {
        if (!isBinary) throw new DoubaoProtocolError('expected a binary frame');
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        const response = parseSeedResponse(buffer);
        if (isServerErrorResponse(response)) {
          this.emit('error', upstreamResponseError(response.code));
          return;
        }
        if (!isFullServerResponse(response)) {
          this.emit('error', protocolError());
          return;
        }
        if (!this.readyReceived) {
          this.readyReceived = true;
          this.emit('ready');
          return;
        }
        const result = response.payload.result as { text?: unknown } | undefined;
        const text = typeof result?.text === 'string' ? result.text.trim() : '';
        if (response.isLast) this.emit('final', text);
        else if (text) this.emit('partial', text);
      } catch {
        this.emit('error', protocolError());
      }
    });
    socket.on('error', () => this.emit('error', new DoubaoProviderError('DOUBAO_UNAVAILABLE', 'Doubao realtime connection was interrupted.', true)));
    socket.on('close', () => this.emit('closed'));
  }

  private send(packet: Buffer): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new DoubaoProviderError('DOUBAO_UNAVAILABLE', 'Doubao realtime is not connected.', true);
    }
    this.socket.send(packet);
  }
}

function protocolError(): DoubaoProviderError {
  return new DoubaoProviderError('DOUBAO_PROTOCOL_INVALID', 'Doubao realtime returned an invalid event.', true);
}

function upstreamResponseError(code: number | null): DoubaoProviderError {
  if (code === 55000031) return new DoubaoProviderError('DOUBAO_RATE_LIMITED', 'Doubao realtime request failed.', true);
  if (code !== null && [45000001, 45000002, 45000151].includes(code)) {
    return new DoubaoProviderError('DOUBAO_PROTOCOL_INVALID', 'Doubao realtime request failed.', false);
  }
  return new DoubaoProviderError('DOUBAO_UNAVAILABLE', 'Doubao realtime request failed.', true);
}
