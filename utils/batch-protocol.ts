export interface BatchInputItem {
  id: string;
  text: string;
}

export function createBatchItems(texts: string[]): BatchInputItem[] {
  return texts.map((text, index) => ({ id: `t${index}`, text }));
}

export function batchInstruction(targetLanguage: string): string {
  return [
    `把 items 每段 text 翻译成${targetLanguage}。`,
    '只返回 {"items":[{"id":"t0","translation":"译文"}]}，每个 id 原样出现一次。',
    // 防 Prompt Injection 由 system 侧的 INJECTION_GUARD 统一负责，这里不重复占 Token。
  ].join('\n');
}

export function parseBatchTranslations(content: string, expectedCount: number): string[] | null {
  let json = content.trim();
  const fence = json.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) json = fence[1].trim();
  const objectStart = json.indexOf('{');
  const objectEnd = json.lastIndexOf('}');
  const arrayStart = json.indexOf('[');
  const arrayEnd = json.lastIndexOf(']');
  const startsWithArray = arrayStart !== -1 && (objectStart === -1 || arrayStart < objectStart);
  const start = startsWithArray ? arrayStart : objectStart;
  const end = startsWithArray ? arrayEnd : objectEnd;
  if (start === -1 || end === -1) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (
    Array.isArray(parsed) &&
    parsed.length === expectedCount &&
    parsed.every((item) => typeof item === 'string')
  ) {
    const translations = parsed.map((item) => item.trim());
    return translations.every(Boolean) ? translations : null;
  }
  const record = parsed as Record<string, unknown>;
  const direct = record.translations;
  if (
    Array.isArray(direct) &&
    direct.length === expectedCount &&
    direct.every((item) => typeof item === 'string')
  ) {
    const translations = direct.map((item) => item.trim());
    return translations.every(Boolean) ? translations : null;
  }
  const items = record.items;
  if (!Array.isArray(items) || items.length !== expectedCount) return null;

  const translations = new Array<string>(expectedCount);
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    const id = record.id;
    const translation = record.translation;
    if (typeof id !== 'string' || typeof translation !== 'string' || seen.has(id)) return null;
    const match = /^t(\d+)$/.exec(id);
    const index = match ? Number(match[1]) : -1;
    if (index < 0 || index >= expectedCount || !translation.trim()) return null;
    seen.add(id);
    translations[index] = translation.trim();
  }
  return translations.every((translation) => typeof translation === 'string') ? translations : null;
}
