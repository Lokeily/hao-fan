export const MAX_BATCH_ITEMS = 50;
export const MAX_TEXT_CHARS = 20_000;
export const MAX_BATCH_CHARS = 100_000;

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

export function readText(value: unknown): string {
  if (typeof value !== 'string') throw new Error('翻译文本格式无效');
  if (!value.trim()) throw new Error('翻译文本不能为空');
  if (value.length > MAX_TEXT_CHARS) throw new Error(`单段文本不能超过 ${MAX_TEXT_CHARS} 个字符`);
  return value;
}

export function readBatch(message: Record<string, unknown>): string[] {
  const raw = asRecord(message.payload)?.texts;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('翻译批次不能为空');
  if (raw.length > MAX_BATCH_ITEMS) throw new Error(`单批最多翻译 ${MAX_BATCH_ITEMS} 段文本`);
  const texts = raw.map(readText);
  if (texts.reduce((sum, text) => sum + text.length, 0) > MAX_BATCH_CHARS) {
    throw new Error(`单批文本总长度不能超过 ${MAX_BATCH_CHARS} 个字符`);
  }
  return texts;
}

export function readSingle(message: Record<string, unknown>): string {
  return readText(asRecord(message.payload)?.text);
}

export function readJobId(message: Record<string, unknown>): string | undefined {
  const jobId = asRecord(message.payload)?.jobId;
  if (jobId === undefined) return undefined;
  if (typeof jobId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(jobId)) {
    throw new Error('翻译任务 ID 无效');
  }
  return jobId;
}
