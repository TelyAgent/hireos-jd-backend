import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const OUTPUT_FORMAT = [
  '## 输出格式',
  '你必须只输出一个 JSON 对象（不要包含任何其他文字、markdown 代码块标记），字段如下：',
  '- reply: string — 给用户看的自然语言回复（追问或确认小结）',
  "- phase: 'intake' | 'ready_to_confirm'",
  '- fields: object — 本轮新增/变更的字段（用 job-standard-v1 的字段名，如 title/department/location/employmentType/headcount/roleSummary/responsibilities/mustHave/niceToHave），未变化的字段不要输出',
  '- missingFields: string[] — 你认为仍然缺失的关键字段名',
].join('\n');

function buildSystemPrompt(skillDir: string): string {
  const instructions = readFileSync(join(skillDir, 'instructions.md'), 'utf-8');
  const fieldSchema = readFileSync(join(skillDir, 'job-standard-v1.json'), 'utf-8');
  return [instructions.trim(), '', '## 字段 schema（job-standard-v1）', '```json', fieldSchema.trim(), '```', '', OUTPUT_FORMAT].join('\n');
}

@Injectable()
export class PromptRegistry {
  private readonly intakePrompt: string;
  private readonly fileExtractPrompt: string;
  private readonly autotakePrompt: string;

  constructor() {
    this.intakePrompt = buildSystemPrompt(join(__dirname, 'skills', 'jd-intake'));
    this.fileExtractPrompt = buildSystemPrompt(join(__dirname, 'skills', 'jd-file-extract'));
    this.autotakePrompt = buildSystemPrompt(join(__dirname, 'skills', 'jd-autotake'));
  }

  get jdIntakeSystemPrompt(): string {
    return this.intakePrompt;
  }

  get jdFileExtractSystemPrompt(): string {
    return this.fileExtractPrompt;
  }

  get jdAutotakeSystemPrompt(): string {
    return this.autotakePrompt;
  }
}
