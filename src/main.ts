import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { Server } from 'node:http';
import { AppModule } from './app.module';
import { attachVoiceGateway, VOICE_WS_PATH } from './voice/voice-gateway';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const corsOrigin = config.get<string>('CORS_ORIGIN');
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: corsOrigin ? corsOrigin.split(',').map((value) => value.trim()).filter(Boolean) : true,
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.enableShutdownHooks();

  attachVoiceGateway(app.getHttpServer() as Server, {
    ticketSecret: config.get<string>('HIREOS_DOUBAO_TICKET_SECRET', ''),
    allowedOrigins: new Set(
      (config.get<string>('HIREOS_DOUBAO_ALLOWED_ORIGINS', '') || '').split(',').map((value) => value.trim()).filter(Boolean),
    ),
    maxConnections: Number(config.get<string>('HIREOS_DOUBAO_MAX_CONNECTIONS', '8')),
    startTimeoutMs: Number(config.get<string>('HIREOS_DOUBAO_START_TIMEOUT_SECONDS', '10')) * 1000,
    idleTimeoutMs: Number(config.get<string>('HIREOS_DOUBAO_IDLE_TIMEOUT_SECONDS', '30')) * 1000,
    finalTimeoutMs: Number(config.get<string>('HIREOS_DOUBAO_FINAL_TIMEOUT_SECONDS', '15')) * 1000,
    maxFrameBytes: Number(config.get<string>('HIREOS_DOUBAO_MAX_FRAME_BYTES', '32768')),
    maxSessionBytes: Number(config.get<string>('HIREOS_DOUBAO_MAX_SESSION_BYTES', '7680000')),
    doubao: {
      apiKey: config.get<string>('HIREOS_DOUBAO_API_KEY', ''),
      websocketUrl: config.get<string>('HIREOS_DOUBAO_WEBSOCKET_URL', 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel'),
      resourceId: config.get<string>('HIREOS_DOUBAO_RESOURCE_ID', 'volc.bigasr.sauc.duration'),
      model: config.get<string>('HIREOS_DOUBAO_MODEL', 'bigmodel'),
      openTimeoutMs: Number(config.get<string>('HIREOS_DOUBAO_OPEN_TIMEOUT_SECONDS', '10')) * 1000,
    },
  });

  const host = config.get<string>('HOST', '127.0.0.1');
  const port = config.get<number>('PORT', 3005);
  await app.listen(port, host);
  Logger.log(`JD backend listening on http://${host}:${port}/api`, 'Bootstrap');
  Logger.log(`Voice gateway listening on ws://${host}:${port}${VOICE_WS_PATH}`, 'Bootstrap');
}

void bootstrap();
