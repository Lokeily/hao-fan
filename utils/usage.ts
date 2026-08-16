export interface TranslationStats {
  inputSegments: number;
  localSkipped: number;
  cacheHits: number;
  glossaryHits: number;
  duplicateHits: number;
  sentSegments: number;
  sentCharacters: number;
  estimatedTokensSaved: number;
  promptTokens: number;
  completionTokens: number;
  requests: number;
}

export interface UsageTotals extends TranslationStats {
  translations: number;
  updatedAt: number;
}

export const EMPTY_STATS: TranslationStats = {
  inputSegments: 0,
  localSkipped: 0,
  cacheHits: 0,
  glossaryHits: 0,
  duplicateHits: 0,
  sentSegments: 0,
  sentCharacters: 0,
  estimatedTokensSaved: 0,
  promptTokens: 0,
  completionTokens: 0,
  requests: 0,
};

export const EMPTY_USAGE_TOTALS: UsageTotals = {
  ...EMPTY_STATS,
  translations: 0,
  updatedAt: 0,
};

export function createStats(inputSegments = 0): TranslationStats {
  return { ...EMPTY_STATS, inputSegments };
}

export function estimateTokens(text: string): number {
  const compact = text.trim();
  if (!compact) return 0;
  const wideScript =
    compact.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)
      ?.length || 0;
  return wideScript + Math.ceil((compact.length - wideScript) / 4);
}

export function addStats(target: TranslationStats, value: Partial<TranslationStats>): void {
  for (const key of Object.keys(EMPTY_STATS) as (keyof TranslationStats)[]) {
    target[key] += value[key] || 0;
  }
}

export function accumulateUsage(current: UsageTotals, stats: TranslationStats): UsageTotals {
  const next = { ...current };
  addStats(next, stats);
  next.translations += 1;
  next.updatedAt = Date.now();
  return next;
}

// 与 accumulateUsage 类似，但只累加 Token / 请求数等用量，不增加「翻译操作次数」。
// 用于「测试连接」：它确实消耗 Token，但不应被计入用户的累计翻译次数。
export function addUsageStats(current: UsageTotals, stats: TranslationStats): UsageTotals {
  const next = { ...current };
  addStats(next, stats);
  next.updatedAt = Date.now();
  return next;
}
