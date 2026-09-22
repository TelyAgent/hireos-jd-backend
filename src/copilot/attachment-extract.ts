import { BadRequestException } from '@nestjs/common';
import { PDFParse } from 'pdf-parse';
import { extractRawText } from 'mammoth';

const MAX_EXTRACTED_CHARS = 12_000;

/** Plain-text extraction only — no attempt to preserve layout/formatting, per the M4 plan's scope. */
export async function extractTextFromFile(buffer: Buffer, mimeType: string, filename: string): Promise<string> {
  const extension = filename.toLowerCase().split('.').pop() || '';
  if (mimeType === 'application/pdf' || extension === 'pdf') {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return truncate(result.text);
    } finally {
      await parser.destroy();
    }
  }
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || extension === 'docx'
  ) {
    const result = await extractRawText({ buffer });
    return truncate(result.value);
  }
  if (mimeType.startsWith('text/') || extension === 'txt') {
    return truncate(buffer.toString('utf-8'));
  }
  throw new BadRequestException({
    code: 'ATTACHMENT_TYPE_UNSUPPORTED',
    message: '仅支持上传 PDF、DOCX 或 TXT 文件。',
  });
}

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_EXTRACTED_CHARS ? trimmed.slice(0, MAX_EXTRACTED_CHARS) : trimmed;
}
