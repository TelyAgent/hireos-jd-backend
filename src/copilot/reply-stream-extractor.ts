/**
 * The LLM's raw stream is one growing JSON object (`{"reply": "...", "phase": ..., "fields": {...}}`),
 * not plain text — OpenAI's json_object streaming mode doesn't token-stream a single field on its own.
 * This incrementally locates the `"reply": "..."` string value inside that growing buffer and decodes
 * standard JSON escapes as they complete, so the UI can show the reply typing out before the whole
 * structured turn has finished generating. It only ever emits characters that are part of `reply`;
 * everything else in the JSON object is ignored here and parsed for real once the stream ends.
 */
const ESCAPE_MAP: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };

export class ReplyStreamExtractor {
  private buffer = '';
  private started = false;
  private rawPos = 0;
  private done = false;

  push(chunk: string): string {
    if (this.done) return '';
    this.buffer += chunk;
    if (!this.started) {
      const match = /"reply"\s*:\s*"/.exec(this.buffer);
      if (!match) return '';
      this.started = true;
      this.rawPos = match.index + match[0].length;
    }
    let out = '';
    while (this.rawPos < this.buffer.length) {
      const ch = this.buffer[this.rawPos];
      if (ch === '\\') {
        if (this.rawPos + 1 >= this.buffer.length) break; // wait for the escaped character
        const next = this.buffer[this.rawPos + 1];
        if (next === 'u') {
          if (this.rawPos + 6 > this.buffer.length) break; // wait for the full \uXXXX
          out += String.fromCharCode(parseInt(this.buffer.slice(this.rawPos + 2, this.rawPos + 6), 16));
          this.rawPos += 6;
        } else if (next in ESCAPE_MAP) {
          out += ESCAPE_MAP[next];
          this.rawPos += 2;
        } else {
          this.rawPos += 1;
        }
        continue;
      }
      if (ch === '"') {
        this.done = true;
        this.rawPos += 1;
        return out;
      }
      out += ch;
      this.rawPos += 1;
    }
    return out;
  }
}
