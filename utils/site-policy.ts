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
