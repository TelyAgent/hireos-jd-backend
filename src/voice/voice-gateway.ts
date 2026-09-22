import { Logger } from '@nestjs/common';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { DoubaoProviderError, DoubaoRealtimeProvider, type DoubaoProviderSettings } from './doubao-provider';
import { verifyVoiceTicket, VoiceTicketError } from './voice-ticket';

/**
 * Browser-facing voice WebSocket gateway. Node port of the old project's `doubaoinput/agent.py` +
 * the `/ws/doubaoinput` route in `main.py`, reshaped around Node's event loop instead of Python's
 * `asyncio.wait`-based task racing — see `doubao-provider.ts` for why that racing isn't needed here.
 *
 * Mounted on the SAME HTTP server/port as the rest of this NestJS app (unlike the old project, which
 * ran doubaoinput as a separate FastAPI process on its own port): one process is enough at this scale,
 * and it avoids a second port to manage in dev and deployment.
 */
export const VOICE_WS_PATH = '/ws/voice-stream';

export type VoiceGatewayConfig = {
  ticketSecret: string;
  allowedOrigins: Set<string>;
  maxConnections: number;
  startTimeoutMs: number;
  idleTimeoutMs: number;
  finalTimeoutMs: number;
  maxFrameBytes: number;
  maxSessionBytes: number;
  doubao: DoubaoProviderSettings;
};

const START_MESSAGE = JSON.stringify({ type: 'start', version: 1, sample_rate: 16000, bits: 16, channels: 1 });

export function attachVoiceGateway(httpServer: HttpServer, config: VoiceGatewayConfig): void {
  const wss = new WebSocketServer({ noServer: true });
  let activeConnections = 0;

  httpServer.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(request.url || '', 'http://localhost');
    if (url.pathname !== VOICE_WS_PATH) return; // let other upgrade handlers (if any) see it

    const origin = request.headers.origin;
    const ticket = url.searchParams.get('ticket') || '';
    try {
      if (!origin || !config.allowedOrigins.has(origin)) throw new VoiceTicketError('origin is invalid');
      verifyVoiceTicket(ticket, config.ticketSecret);
    } catch {
      socket.destroy();
      return;
    }
    if (activeConnections >= config.maxConnections) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      activeConnections += 1;
      new VoiceSession(ws, config).run().finally(() => {
        activeConnections -= 1;
      });
    });
  });
}

type ErrorPayload = { code: string; message: string; retryable: boolean };

/** One browser connection's lifecycle: start handshake → Doubao ready → PCM relay → final transcript. */
class VoiceSession {
  private static readonly logger = new Logger('VoiceGateway');
  private readonly id = randomUUID().slice(0, 8);
  private readonly provider: DoubaoRealtimeProvider;
  private timer: NodeJS.Timeout | null = null;
  private settled = false;
  private committed = false;
  private totalBytes = 0;
  private resolveDone: (() => void) | null = null;

  constructor(
    private readonly browserSocket: WebSocket,
    private readonly config: VoiceGatewayConfig,
  ) {
    this.provider = new DoubaoRealtimeProvider(config.doubao);
    // Registered immediately, before any async work: an EventEmitter that emits 'error' with zero
    // listeners attached throws and crashes the process, so this can never be deferred until later.
    this.provider.on('error', (error) => this.onProviderError(error));
    VoiceSession.logger.log(`session ${this.id} connected`);
  }

  async run(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.resolveDone = resolve;
      this.browserSocket.once('close', () => this.finish(1000));
      this.armTimer(this.config.startTimeoutMs, 'VOICE_IDLE_TIMEOUT', '语音连接等待超时，请重新开始。');
      this.browserSocket.once('message', (data, isBinary) => this.onStartMessage(data, isBinary));
    });
  }

  private onStartMessage(data: RawData, isBinary: boolean): void {
    if (isBinary || data.toString('utf-8') !== START_MESSAGE) {
      this.fail({ code: 'VOICE_PROTOCOL_INVALID', message: '语音连接协议无效，请重新开始。', retryable: false });
      return;
    }
    void this.beginProviderSession();
  }

  private async beginProviderSession(): Promise<void> {
    try {
      await this.provider.connect();
      this.provider.initialize();
    } catch (error) {
      // A rejected promise from connect() (or a synchronous throw from initialize()) never reaches
      // the `provider.on('error', ...)` listener — that only sees events emitted *after* the socket
      // opens — so it has to be reported the same way here.
      this.onProviderError(error);
      return;
    }
    this.provider.once('ready', () => this.onReady());
    this.armTimer(this.config.startTimeoutMs, 'VOICE_IDLE_TIMEOUT', '语音连接等待超时，请重新开始。');
  }

  private onReady(): void {
    if (this.settled) return;
    VoiceSession.logger.log(`session ${this.id} ready (Doubao connected)`);
    this.armTimer(this.config.idleTimeoutMs, 'VOICE_IDLE_TIMEOUT', '语音连接等待超时，请重新开始。');
    safeSendJson(this.browserSocket, { type: 'ready' });
    this.browserSocket.on('message', (data, isBinary) => this.onStreamMessage(data, isBinary));
    this.provider.on('partial', (text) => this.onPartial(text));
    this.provider.on('final', (text) => this.onFinal(text));
  }

  private onPartial(text: string): void {
    this.armTimer(
      this.committed ? this.config.finalTimeoutMs : this.config.idleTimeoutMs,
      'VOICE_IDLE_TIMEOUT',
      '语音连接等待超时，请重新开始。',
    );
    if (text) safeSendJson(this.browserSocket, { type: 'partial', text });
  }

  private onFinal(text: string): void {
    this.clearTimer();
    if (!text) {
      this.fail({ code: 'VOICE_TRANSCRIPT_EMPTY', message: '没有识别到清晰语音，请重新开始。', retryable: true });
      return;
    }
    // Logs the length, not the transcript itself — a session log shouldn't double as a voice-content record.
    VoiceSession.logger.log(`session ${this.id} final transcript (${text.length} chars, ${this.totalBytes} audio bytes)`);
    safeSendJson(this.browserSocket, { type: 'final', text });
    this.finish(1000);
  }

  private onStreamMessage(data: RawData, isBinary: boolean): void {
    this.armTimer(
      this.committed ? this.config.finalTimeoutMs : this.config.idleTimeoutMs,
      'VOICE_IDLE_TIMEOUT',
      '语音连接等待超时，请重新开始。',
    );
    if (isBinary) {
      this.onAudioFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      return;
    }
    this.onCommand(data.toString('utf-8'));
  }

  private onAudioFrame(audio: Buffer): void {
    if (this.committed || audio.length === 0 || audio.length > this.config.maxFrameBytes) {
      this.fail(
        audio.length > this.config.maxFrameBytes
          ? { code: 'VOICE_LIMIT_EXCEEDED', message: '本次语音输入超过限制，请缩短后重试。', retryable: false }
          : { code: 'VOICE_PROTOCOL_INVALID', message: '语音连接协议无效，请重新开始。', retryable: false },
      );
      return;
    }
    this.totalBytes += audio.length;
    if (this.totalBytes > this.config.maxSessionBytes) {
      this.fail({ code: 'VOICE_LIMIT_EXCEEDED', message: '本次语音输入超过限制，请缩短后重试。', retryable: false }, 1009);
      return;
    }
    try {
      this.provider.appendPcm(audio);
    } catch {
      // onProviderError handles it if this was a real provider-side failure.
    }
  }

  private onCommand(raw: string): void {
    const command = parseCommand(raw);
    if (command === 'cancel') {
      this.finish(1000);
      return;
    }
    if (command !== 'commit' || this.committed || this.totalBytes === 0) {
      this.fail({ code: 'VOICE_PROTOCOL_INVALID', message: '语音连接协议无效，请重新开始。', retryable: false });
      return;
    }
    this.committed = true;
    try {
      this.provider.commit();
    } catch {
      // onProviderError handles it if this was a real provider-side failure.
    }
  }

  private onProviderError(error: unknown): void {
    if (error instanceof DoubaoProviderError) {
      this.fail(
        { code: error.code, message: '豆包流式语音识别暂不可用，请重新连接。', retryable: error.retryable },
        error.retryable ? 1013 : 1008,
      );
    } else {
      this.fail({ code: 'DOUBAO_UNAVAILABLE', message: '豆包流式语音识别暂不可用，请重新连接。', retryable: true }, 1013);
    }
  }

  private fail(payload: ErrorPayload, code = 1008): void {
    VoiceSession.logger.warn(`session ${this.id} failed: ${payload.code} (${payload.retryable ? 'retryable' : 'not retryable'})`);
    safeSendJson(this.browserSocket, { type: 'error', ...payload });
    this.finish(code);
  }

  private finish(code: number): void {
    if (this.settled) return;
    this.settled = true;
    VoiceSession.logger.log(`session ${this.id} closed (code=${code})`);
    this.clearTimer();
    this.provider.removeAllListeners();
    this.provider.close();
    safeSendJson(this.browserSocket, { type: 'closed' });
    safeClose(this.browserSocket, code);
    this.resolveDone?.();
  }

  private armTimer(ms: number, code: string, message: string): void {
    this.clearTimer();
    this.timer = setTimeout(() => this.fail({ code, message, retryable: true }), ms);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

function parseCommand(raw: string): 'commit' | 'cancel' | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      typeof value === 'object'
      && value !== null
      && Object.keys(value).length === 1
      && ((value as Record<string, unknown>).type === 'commit' || (value as Record<string, unknown>).type === 'cancel')
    ) {
      return (value as { type: 'commit' | 'cancel' }).type;
    }
  } catch {
    // fall through
  }
  return null;
}

function safeSendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(value));
  } catch {
    // The socket may already be closing; nothing further to do.
  }
}

function safeClose(socket: WebSocket, code: number): void {
  try {
    socket.close(code);
  } catch {
    // Already closed.
  }
}
