const MAX_DISABLED_SITES = 500;

export function siteKeyOf(value: string | URL): string | null {
  try {
    const url = value instanceof URL ? value : new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.host.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeStoredSite(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || /[\s/]/.test(trimmed)) {
    return trimmed.includes('://') ? siteKeyOf(trimmed) : null;
  }
  try {
    return new URL(`https://${trimmed}`).host.toLowerCase();
  } catch {
    return null;
  }
}

export function normalizeDisabledSites(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const normalized = new Set<string>();
  for (const site of value) {
    const key = normalizeStoredSite(site);
    if (key) normalized.add(key);
    if (normalized.size >= MAX_DISABLED_SITES) break;
  }
  return Array.from(normalized);
}

export function isSiteDisabled(value: unknown, pageUrl: string | URL): boolean {
  const key = siteKeyOf(pageUrl);
  return Boolean(key && normalizeDisabledSites(value).includes(key));
}

// ===== 0.2.2 网站规则增强：始终翻译（白名单）/ 敏感页面排除（URL 子串）=====
// - alwaysSites：存域名或主机名，命中即「始终自动翻译」，覆盖全局手动模式。
// - neverSites：存 URL 子串（如 "bank"、"admin"、"/login"），页面 URL 包含任一即「从不翻译」，
//   同时覆盖白名单与自动翻译（安全优先：敏感页面优先排除）。

function normalizeSiteList(value: unknown, max = 500): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const t = item.trim().toLowerCase();
    if (!t) continue;
    seen.add(t);
    if (seen.size >= max) break;
  }
  return Array.from(seen);
}

export function isAlwaysSite(value: unknown, pageUrl: string | URL): boolean {
  const sites = normalizeSiteList(value);
  if (sites.length === 0) return false;
  const key = siteKeyOf(pageUrl);
  if (!key) return false;
  // 精确主机名命中，或域名后缀命中（www. 前缀差异、子域名归属）
  return sites.some((site) => site === key || key.endsWith(`.${site}`));
}

export function isNeverSite(value: unknown, pageUrl: string | URL): boolean {
  const needles = normalizeSiteList(value);
  if (needles.length === 0) return false;
  const url = (pageUrl instanceof URL ? pageUrl : new URL(pageUrl)).href.toLowerCase();
  return needles.some((needle) => url.includes(needle));
}

export function withAlwaysSite(
  value: unknown,
  pageUrl: string | URL,
  enabled: boolean,
): string[] {
  const sites = normalizeSiteList(value);
  const key = siteKeyOf(pageUrl);
  if (!key) return sites;
  const next = new Set(sites);
  if (enabled) next.add(key);
  else next.delete(key);
  return Array.from(next);
}

export function withNeverSite(
  value: unknown,
  pageUrl: string | URL,
  enabled: boolean,
): string[] {
  const sites = normalizeSiteList(value);
  const key = siteKeyOf(pageUrl);
  if (!key) return sites;
  const next = new Set(sites);
  if (enabled) next.add(key);
  else next.delete(key);
  return Array.from(next);
}

export function withSiteDisabled(
  value: unknown,
  pageUrl: string | URL,
  disabled: boolean,
): string[] {
  const sites = normalizeDisabledSites(value);
  const key = siteKeyOf(pageUrl);
  if (!key) return sites;
  const next = new Set(sites);
  if (disabled) {
    next.delete(key);
    next.add(key);
    while (next.size > MAX_DISABLED_SITES) {
      const oldest = next.values().next().value;
      if (!oldest) break;
      next.delete(oldest);
    }
  } else {
    next.delete(key);
  }
  return Array.from(next);
}
