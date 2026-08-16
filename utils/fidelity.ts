// 翻译质量自检：保真校验（数字 / 链接 / 代码符号）。
// 模型偶发会漏掉原文里的数字、URL、占位符或代码标识符，导致译文"看起来通顺但信息错"。
// 这里在翻译后做一次轻量校验，发现缺失则自动追加保真指令重译一次，并把结果标记为已校正。

export type FidelityKind = 'number' | 'url' | 'code';

export interface FidelityIssue {
  kind: FidelityKind;
  token: string;
}

const URL_RE = /https?:\/\/[^\s），。；、）]+/gi;
// 反引号代码、`{var}`、`{{var}}`、`<tag>`、`%s`/`%d`、`:name`、全大写常量
const CODE_RE = /`[^`]+`|\{\{?\w+\}?\}|<\/?[a-zA-Z][\w-]*>|%[sdv]|::[\w-]+|\b[A-Z][A-Z0-9_]{2,}\b/g;
// 数字（含小数 / 百分比 / 区间 / 单位）
const NUMBER_RE = /\d[\d.,:%/\s+-]*\d|\d/g;

export function extractCriticalTokens(source: string): FidelityIssue[] {
  const issues: FidelityIssue[] = [];
  const pushUnique = (kind: FidelityKind, token: string) => {
    const t = token.trim();
    if (!t) return;
    if (!issues.some((i) => i.kind === kind && i.token.toLowerCase() === t.toLowerCase())) {
      issues.push({ kind, token: t });
    }
  };
  for (const m of source.matchAll(URL_RE)) pushUnique('url', m[0]);
  for (const m of source.matchAll(CODE_RE)) pushUnique('code', m[0]);
  for (const m of source.matchAll(NUMBER_RE)) pushUnique('number', m[0]);
  return issues;
}

function normalizeToken(token: string): string {
  return token.replace(/^[^\w一-龥]+|[^\w一-龥]+$/g, '').toLowerCase();
}

// 对比原文与译文，返回译文中缺失的关键符号（数字 / 链接 / 代码）。
export function fidelityIssues(source: string, translation: string): FidelityIssue[] {
  const targets = extractCriticalTokens(source);
  if (targets.length === 0) return [];
  const hay = translation.toLowerCase();
  const missing: FidelityIssue[] = [];
  for (const t of targets) {
    const norm = normalizeToken(t.token);
    if (!norm) continue;
    if (!hay.includes(norm)) missing.push(t);
  }
  return missing;
}

// 生成追加到系统提示的保真指令，要求模型逐字保留这些符号。
export function fidelityInstruction(missing: FidelityIssue[]): string {
  if (missing.length === 0) return '';
  const parts = missing.map((m) => {
    const label = m.kind === 'url' ? '链接' : m.kind === 'number' ? '数字' : '代码符号';
    return `${label} ${m.token}`;
  });
  return `\n\n【保真校验】译文必须逐字保留以下原文中的关键内容，不得省略、改写或翻译这些数字 / 链接 / 代码符号：${parts.join('、')}。`;
}
