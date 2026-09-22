import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

@Injectable()
export class LlmProvider {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(config: ConfigService) {
    this.client = new OpenAI({
      apiKey: config.get<string>('HIREOS_AI_API_KEY'),
      baseURL: config.get<string>('HIREOS_AI_BASE_URL', 'https://api.openai.com/v1'),
      timeout: Number(config.get<string>('HIREOS_AI_TIMEOUT_SECONDS', '60')) * 1000,
    });
    this.model = config.get<string>('HIREOS_AI_MODEL', 'gpt-4o-mini');
  }

  async completeJson(system: string, turns: ChatTurn[]): Promise<string> {
    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'system', content: system }, ...turns],
        response_format: { type: 'json_object' },
      });
      const content = completion.choices[0]?.message?.content;
      if (!content) throw new Error('LLM_EMPTY_RESPONSE');
      return content;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'LLM_REQUEST_FAILED';
      throw new ServiceUnavailableException({ code: 'LLM_REQUEST_FAILED', message });
    }
  }

  async *streamJson(system: string, turns: ChatTurn[]): AsyncGenerator<string, void, unknown> {
    try {
      const stream = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'system', content: system }, ...turns],
        response_format: { type: 'json_object' },
        stream: true,
      });
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) yield delta;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'LLM_REQUEST_FAILED';
      throw new ServiceUnavailableException({ code: 'LLM_REQUEST_FAILED', message });
    }
  }
}
