export interface TextChunkOptions {
  maxItems: number;
  maxCharacters: number;
}

export function planTextChunks<T>(
  items: T[],
  textOf: (item: T) => string,
  options: TextChunkOptions,
): T[][] {
  if (options.maxItems < 1 || options.maxCharacters < 1) {
    throw new Error('批次限制必须大于 0');
  }

  const chunks: T[][] = [];
  let chunk: T[] = [];
  let characters = 0;

  for (const item of items) {
    const length = textOf(item).length;
    const exceedsItems = chunk.length >= options.maxItems;
    const exceedsCharacters = chunk.length > 0 && characters + length > options.maxCharacters;
    if (exceedsItems || exceedsCharacters) {
      chunks.push(chunk);
      chunk = [];
      characters = 0;
    }
    chunk.push(item);
    characters += length;
  }

  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

export function takeFirstTextChunk<T>(
  queue: T[],
  textOf: (item: T) => string,
  options: TextChunkOptions,
): T[] {
  const first = planTextChunks(queue, textOf, options)[0] || [];
  queue.splice(0, first.length);
  return first;
}

export function splitLongText(text: string, maxCharacters = 2_800): string[] {
  const source = text.trim();
  if (!source || source.length <= maxCharacters) return source ? [source] : [];
  const parts: string[] = [];
  let rest = source;
  while (rest.length > maxCharacters) {
    const window = rest.slice(0, maxCharacters + 1);
    const minimum = Math.floor(maxCharacters * 0.55);
    let cut = -1;
    for (const pattern of [/\n/g, /[。！？.!?；;]\s*/g, /\s+/g]) {
      for (const match of window.matchAll(pattern)) {
        const end = (match.index || 0) + match[0].length;
        if (end >= minimum && end <= maxCharacters) cut = Math.max(cut, end);
      }
      if (cut >= minimum) break;
    }
    if (cut < 1) cut = maxCharacters;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.trim()) parts.push(rest.trim());
  return parts;
}
