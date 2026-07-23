// 支持的语言。LLM 翻译直接用 name（更稳）；传统翻译引擎（DeepL/Google/Microsoft）用 code。
export interface Language {
  name: string;
  code: string;
}

export const LANGUAGES: Language[] = [
  { name: '自动检测', code: 'auto' },
  { name: '中文', code: 'zh' },
  { name: 'English', code: 'en' },
  { name: '日本語', code: 'ja' },
  { name: '한국어', code: 'ko' },
  { name: 'Français', code: 'fr' },
  { name: 'Deutsch', code: 'de' },
  { name: 'Español', code: 'es' },
  { name: 'Русский', code: 'ru' },
  { name: 'Italiano', code: 'it' },
  { name: 'Português', code: 'pt' },
  { name: 'العربية', code: 'ar' },
  { name: 'हिन्दी', code: 'hi' },
  { name: 'ไทย', code: 'th' },
  { name: 'Tiếng Việt', code: 'vi' },
  { name: 'Türkçe', code: 'tr' },
  { name: 'Nederlands', code: 'nl' },
  { name: 'Polski', code: 'pl' },
];

const CODE_BY_NAME: Record<string, string> = Object.fromEntries(
  LANGUAGES.map((l) => [l.name, l.code]),
);

export function langCode(name: string): string {
  return CODE_BY_NAME[name] ?? 'auto';
}

export function langName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code;
}
