// 标识符预遮罩：翻译前把「看起来像代码/库名」的片段替换成可逆占位符，
// 让模型只译自然语言、原样保留占位符；回填空。彻底避免库名被翻译
// （如 useState → 使用状态、react-dom → 反应-dom），同时占位符比译文短，省 completion。
//
// 判定信号（只遮罩明显是代码/专有标识符的形态，普通首字母大写的 UI 词如
// Button/Settings 不遮罩，仍正常翻译）：
//   - snake_case / kebab-case（含 _ 或 -）
//   - 点路径 a.b.c
//   - 内部有驼峰的 camelCase / PascalCase（useState / onClick / GitHub / JavaScript）
//   - 全大写缩写（API / HTTP / CSS / DOM）
//   - 含数字（v2 / utf8 / base64）

// 用私有区字符做占位符：模型不会把它当自然语言翻译，也不会与正文冲突。
const OPEN = String.fromCharCode(0xf000);
const CLOSE = String.fromCharCode(0xf001);

const IDENT_RE =
  /[A-Za-z0-9]*(?:_[A-Za-z0-9]+)+|[A-Za-z0-9]*(?:-[A-Za-z0-9]+)+|[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+|[A-Za-z]+(?:[A-Z][a-z0-9]+)+|\b[A-Z]{2,}\b|[A-Za-z0-9]*\d[A-Za-z0-9]*/g;

// 单大写专名（React/Vue/Linux…）：与句首英文词同形，通用正则无法安全区分，
// 用「常见库/框架/平台专名名单」精确保护，避免 React→反应 这类乱翻。
// 只列大小写敏感、几乎不会作为普通英文词出现的专名，降低误遮自然句首词的风险。
const BRAND_NAMES = [
  'React', 'Vue', 'Angular', 'Svelte', 'Node', 'Deno', 'Docker', 'Kubernetes',
  'Linux', 'Python', 'Rust', 'Java', 'PHP', 'Git', 'GitHub', 'GitLab',
  'Redis', 'MongoDB', 'PostgreSQL', 'MySQL', 'SQLite', 'Webpack', 'Vite',
  'Babel', 'ESLint', 'TypeScript', 'JavaScript', 'npm', 'yarn', 'pnpm',
  'AWS', 'Azure', 'GCP', 'Chrome', 'Firefox', 'Safari', 'Edge', 'Android',
  'iOS', 'macOS', 'Windows', 'iPhone', 'iPad',
];
const BRAND_RE = new RegExp('\\b(?:' + BRAND_NAMES.join('|') + ')\\b', 'g');

export const MASK_GUARD =
  '保留所有 ' + OPEN + '数字' + CLOSE + ' 形式的占位符，原样输出，不要翻译、改写或省略。';

export interface MaskedText {
  /** 遮罩后的文本（无标识符可遮罩时等于原文） */
  masked: string;
  /** 把译文里的占位符还原成原始标识符 */
  restore: (translation: string) => string;
  /** 实际遮罩的标识符数量 */
  count: number;
}

/**
 * 流式增量还原：增量文本可能刚好切在占位符中间（已收到 OPEN+数字、还没收到 CLOSE），
 * 直接 restore 会把私有区字符漏到界面上。这里先裁掉尾部未闭合的占位符再还原，
 * 下一个增量补齐后自然会重新出现，不影响最终结果。
 */
export function restorePartial(masked: MaskedText, partial: string): string {
  const open = partial.lastIndexOf(OPEN);
  const close = partial.lastIndexOf(CLOSE);
  const safe = open > close ? partial.slice(0, open) : partial;
  return masked.restore(safe);
}

export function maskIdentifiers(text: string): MaskedText {
  const map: string[] = [];
  const push = (m: string) => {
    const idx = map.length;
    map.push(m);
    return OPEN + idx + CLOSE;
  };
  // 第一遍：通用代码/标识符形态。第二遍：品牌专名。
  // 两遍都只扫描「当前文本」，不会命中已经生成的占位符（PUA 字符），故顺序安全。
  let masked = text.replace(IDENT_RE, push);
  masked = masked.replace(BRAND_RE, push);
  const restore = (translation: string): string =>
    translation.replace(new RegExp(OPEN + '(\\d+)' + CLOSE, 'g'), (_full, i) => map[Number(i)] ?? '');
  return { masked, restore, count: map.length };
}
