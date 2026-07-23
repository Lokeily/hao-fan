const SCRIPT_PATTERNS: Record<string, RegExp> = {
  中文: /\p{Script=Han}/gu,
  日本語: /[\p{Script=Hiragana}\p{Script=Katakana}]/gu,
  한국어: /\p{Script=Hangul}/gu,
  Русский: /\p{Script=Cyrillic}/gu,
  العربية: /\p{Script=Arabic}/gu,
  हिन्दी: /\p{Script=Devanagari}/gu,
  ไทย: /\p{Script=Thai}/gu,
};

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length || 0;
}

export type LocalSkipReason = 'nonLinguistic' | 'targetLanguage';

export function localSkipReason(
  text: string,
  targetLanguage: string,
  sourceLanguage = '自动检测',
): LocalSkipReason | null {
  const trimmed = text.trim();
  if (!trimmed) return 'nonLinguistic';
  if (!/\p{L}/u.test(trimmed)) return 'nonLinguistic';
  if (sourceLanguage !== '自动检测' && sourceLanguage === targetLanguage) return 'targetLanguage';

  const pattern = SCRIPT_PATTERNS[targetLanguage];
  if (!pattern) return null;
  const letters = countMatches(trimmed, /\p{L}/gu);
  const matches = countMatches(trimmed, pattern);
  if (letters === 0 || matches < 2) return null;

  if (targetLanguage === '中文') {
    // 含假名的日文不能因为同时含汉字而被误判为中文。
    if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(trimmed)) return null;
    // 两个纯汉字可能是日文 UI（如「設定」），保持保守并交给模型判断。
    if (matches < 3) return null;
    return matches / letters >= 0.55 ? 'targetLanguage' : null;
  }

  return matches / letters >= 0.55 ? 'targetLanguage' : null;
}
