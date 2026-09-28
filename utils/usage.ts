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
  qualityIssues: number; // 质量自检发现「原文符号/数字/链接缺失」的段落数
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
  qualityIssues: 0,
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

// ===== 月度预算 =====
// BYOK 模式用户自付 API 费用，最怕"不知不觉烧钱"：记录当月实际 Token 用量，
// 跨月自动归零。存储结构 { yearMonth: 'YYYY-MM', usedTokens }。
export interface MonthUsage {
  yearMonth: string;
  usedTokens: number;
}

export function currentYearMonth(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function addMonthUsage(current: MonthUsage | null, tokens: number, now = Date.now()): MonthUsage {
  const ym = currentYearMonth(now);
  if (!current || current.yearMonth !== ym) {
    return { yearMonth: ym, usedTokens: Math.max(0, tokens) };
  }
  return { ...current, usedTokens: current.usedTokens + Math.max(0, tokens) };
}
