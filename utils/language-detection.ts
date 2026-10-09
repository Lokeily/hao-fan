// 逐段语言检测：决定「这一段该不该翻」。
//
// 设计目标（对应反馈：该翻的翻、不该翻的不翻、杜绝中译中、省 Token）：
//   1) 不再依赖全局 sourceLang 做跳过判定——手动把 source 设成外语时，
//      页面里的中文 UI 串以前会被当成外语送进模型导致「中译中」；
//   2) 改为「检测这一段本身是什么语言，== 目标语言就本地跳过（0 Token）」；
//   3) 目标语言字符串一律不送模型，既不出中译中，又省下整段请求。
//
// 这里只做「粗粒度语种」判定（足够判断是否已是目标语言），不追求精确分词。

const HAN_RE = /\p{Script=Han}/gu;
const KANA_RE = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const HANGUL_RE = /\p{Script=Hangul}/gu;
const CYRILLIC_RE = /\p{Script=Cyrillic}/gu;
const ARABIC_RE = /\p{Script=Arabic}/gu;
const DEVANAGARI_RE = /\p{Script=Devanagari}/gu;
const THAI_RE = /\p{Script=Thai}/gu;
const LATIN_RE = /[A-Za-z]/g;

export type LangKey =
  | 'zh'
  | 'ja'
  | 'ko'
  | 'latin'
  | 'cyrillic'
  | 'arabic'
  | 'devanagari'
  | 'thai'
  | 'other';

// 目标语言名 → 语种键。Latin 系语言（英/法/德/西/葡…）统一归为 'latin'：
// 一段拉丁字母文本对它们而言就是「已是目标语言」，本地跳过。
const TARGET_LANG_KEY: Record<string, LangKey> = {
  中文: 'zh',
  日本語: 'ja',
  한국어: 'ko',
  English: 'latin',
  Français: 'latin',
  Deutsch: 'latin',
  Español: 'latin',
  Italiano: 'latin',
  Português: 'latin',
  'Tiếng Việt': 'latin',
  Türkçe: 'latin',
  Nederlands: 'latin',
  Polski: 'latin',
  Русский: 'cyrillic',
  العربية: 'arabic',
  हिन्दी: 'devanagari',
  ไทย: 'thai',
};

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length || 0;
}

/**
 * 检测文本的主要语种（粗粒度）。
 * - 含假名 → 日；含谚文 → 韩；
 * - 拉丁字母占比 ≥0.55 → 拉丁（品牌混排句、代码片段优先按拉丁处理）；
 * - 其余只要出现汉字（假名/谚文已先行排除）即判为中文：
 *   覆盖「设置」「确定」等短 UI 词，杜绝短中文被误送模型造成中译中。
 */
export function detectLang(text: string): LangKey {
  const trimmed = text.trim();
  if (!trimmed) return 'other';
  if (!/\p{L}/u.test(trimmed)) return 'other';

  const han = countMatches(trimmed, HAN_RE);
  const kana = countMatches(trimmed, KANA_RE);
  const hangul = countMatches(trimmed, HANGUL_RE);
  const cyrillic = countMatches(trimmed, CYRILLIC_RE);
  const arabic = countMatches(trimmed, ARABIC_RE);
  const devanagari = countMatches(trimmed, DEVANAGARI_RE);
  const thai = countMatches(trimmed, THAI_RE);
  const latin = countMatches(trimmed, LATIN_RE);

  const letters = han + kana + hangul + cyrillic + arabic + devanagari + thai + latin;
  if (letters === 0) return 'other';

  if (kana > 0) return 'ja';
  if (hangul > 0) return 'ko';

  const ratio = (n: number) => n / letters;

  // 无歧义的独立文字系统
  if (ratio(cyrillic) >= 0.5) return 'cyrillic';
  if (ratio(arabic) >= 0.5) return 'arabic';
  if (ratio(devanagari) >= 0.5) return 'devanagari';
  if (ratio(thai) >= 0.5) return 'thai';

  // 拉丁明显占优（≥0.55）才判拉丁：混有少量英文品牌的中文句不会被误跳过
  if (latin > 0 && ratio(latin) >= 0.55) return 'latin';

  // 有汉字且拉丁不占优 → 中文（此前要求 han≥3 且占比≥0.5，
  // 导致「设置」等两字词被判为 other 送进模型反复翻译）
  if (han > 0) return 'zh';

  return 'other';
}

export type LocalSkipReason = 'nonLinguistic' | 'targetLanguage';

/**
 * 是否应本地跳过（不送模型）。
 * 现在只看「检测到的语种 == 目标语种」，不再被全局 sourceLang 误导。
 * sourceLanguage 参数保留仅为向后兼容（调用方仍会传入），不再参与判定。
 */
export function localSkipReason(
  text: string,
  targetLanguage: string,
  _sourceLanguage = '自动检测',
): LocalSkipReason | null {
  const trimmed = text.trim();
  if (!trimmed) return 'nonLinguistic';
  if (!/\p{L}/u.test(trimmed)) return 'nonLinguistic';

  const targetKey = TARGET_LANG_KEY[targetLanguage];
  if (!targetKey) return null;

  // 拉丁系目标语言不能按「字母系统」跳过：英/法/德/西共享拉丁字母，粗粒度
  // 检测无法区分，会把英文原文误判成法语「已是目标语言」，整页 0 请求漏译
  // （Apple 官网英→法实测全页不翻）。只有目标就是 English 时保留跳过——
  // 此时检测为 latin 的文本几乎必然是英文，跳过既防英→英中译中又省 Token。
  if (targetKey === 'latin' && targetLanguage !== 'English') return null;

  // 检测到已是目标语言 → 本地跳过（0 Token，绝无中译中）。
  if (detectLang(trimmed) === targetKey) return 'targetLanguage';
  return null;
}
