import { z } from 'zod';

export const jdFieldsSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    department: z.string().trim().min(1).optional(),
    location: z.string().trim().min(1).optional(),
    employmentType: z.string().trim().min(1).optional(),
    headcount: z.number().int().positive().optional(),
    roleSummary: z.string().trim().min(1).optional(),
    responsibilities: z.array(z.string().trim().min(1)).optional(),
    mustHave: z.array(z.string().trim().min(1)).optional(),
    niceToHave: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();

export type JdFields = z.infer<typeof jdFieldsSchema>;

export const llmTurnResultSchema = z
  .object({
    reply: z.string().trim().min(1),
    phase: z.enum(['intake', 'ready_to_confirm']),
    fields: jdFieldsSchema,
    missingFields: z.array(z.string()),
  })
  .strict();

export type LlmTurnResult = z.infer<typeof llmTurnResultSchema>;

export const sendMessageInputSchema = z
  .object({
    text: z.string().trim().min(1).max(4000),
  })
  .strict();

export function computeMissingFields(fields: JdFields): string[] {
  const missing: string[] = [];
  if (!fields.title) missing.push('title');
  if (!fields.roleSummary) missing.push('roleSummary');
  if (!fields.responsibilities || fields.responsibilities.length < 2) missing.push('responsibilities');
  if (!fields.mustHave || fields.mustHave.length < 2) missing.push('mustHave');
  return missing;
}
