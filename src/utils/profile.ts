import { NormalizedSiteProfile, TargetCategoryQuota } from '../types/profile';

const DEFAULT_LANGUAGE = 'en';
const TARGET_HEADLINE_COUNT = 100;

function toStringArray(value: unknown): string[] {
  const seen = new Set<string>();
  const push = (entry: string | null | undefined) => {
    if (!entry) return;
    const normalized = entry.replace(/\s+/g, ' ').trim();
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push(normalized);
  };

  const items: string[] = [];

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        push(item);
      } else if (item != null) {
        push(String(item));
      }
    }
    return items;
  }

  if (typeof value === 'string') {
    const parts = value
      .split(/[,\n]/)
      .map((part) => part.trim())
      .filter(Boolean);
    for (const part of parts) {
      push(part);
    }
    return items;
  }

  if (value != null && typeof value === 'object') {
    for (const item of Object.values(value)) {
      if (typeof item === 'string') {
        push(item);
      }
    }
  }

  return items;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number.parseFloat(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function normalizeQuota(quota: unknown): TargetCategoryQuota {
  if (!quota || typeof quota !== 'object' || Array.isArray(quota)) {
    return { general: TARGET_HEADLINE_COUNT };
  }

  const entries: [string, number][] = [];

  for (const [key, value] of Object.entries(quota as Record<string, unknown>)) {
    const label = key.trim();
    if (!label) continue;
    const numeric = toNumber(value);
    if (numeric == null || numeric <= 0) continue;
    entries.push([label, Math.round(numeric)]);
  }

  if (entries.length === 0) {
    return { general: TARGET_HEADLINE_COUNT };
  }

  let total = entries.reduce((sum, [, value]) => sum + value, 0);

  if (total === TARGET_HEADLINE_COUNT) {
    return Object.fromEntries(entries);
  }

  const originalOrder = [...entries];

  if (total !== TARGET_HEADLINE_COUNT) {
    const scale = TARGET_HEADLINE_COUNT / total;
    for (let i = 0; i < entries.length; i++) {
      const scaled = Math.max(1, Math.round(entries[i][1] * scale));
      entries[i][1] = scaled;
    }
    total = entries.reduce((sum, [, value]) => sum + value, 0);
    const priority = originalOrder
      .map(([key, value], index) => ({ key, index, value }))
      .sort((a, b) => b.value - a.value || a.index - b.index);
    while (total < TARGET_HEADLINE_COUNT) {
      for (const item of priority) {
        entries[item.index][1] += 1;
        total += 1;
        if (total >= TARGET_HEADLINE_COUNT) break;
      }
    }
    while (total > TARGET_HEADLINE_COUNT) {
      for (const item of priority) {
        if (entries[item.index][1] > 1) {
          entries[item.index][1] -= 1;
          total -= 1;
          if (total <= TARGET_HEADLINE_COUNT) break;
        }
      }
      if (total > TARGET_HEADLINE_COUNT) {
        entries[0][1] = Math.max(1, entries[0][1] - 1);
        total = entries.reduce((sum, [, value]) => sum + value, 0);
      }
    }
  }

  return Object.fromEntries(entries);
}

export function normalizeProfile(raw: unknown): NormalizedSiteProfile {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const profile: NormalizedSiteProfile = {
    language:
      typeof source.language === 'string' && source.language.trim()
        ? source.language.trim().toLowerCase()
        : DEFAULT_LANGUAGE,
    taxonomy: toStringArray(source.taxonomy),
    must_include_keywords: toStringArray(
      source.must_include_keywords ?? source.mustIncludeKeywords
    ),
    nice_to_have_keywords: toStringArray(
      source.nice_to_have_keywords ?? source.niceToHaveKeywords
    ),
    must_exclude_keywords: toStringArray(
      source.must_exclude_keywords ?? source.mustExcludeKeywords
    ),
    entities_focus: toStringArray(source.entities_focus ?? source.entitiesFocus),
    audience:
      typeof source.audience === 'string' ? source.audience.trim() : '',
    tone: typeof source.tone === 'string' ? source.tone.trim() : '',
    target_categories_quota: normalizeQuota(
      source.target_categories_quota ?? source.targetCategoriesQuota
    ),
  };

  if (!profile.taxonomy.length && Array.isArray(source.categories)) {
    profile.taxonomy = toStringArray(source.categories);
  }

  return profile;
}

function quoteIfNeeded(term: string): string {
  const trimmed = term.trim();
  if (!trimmed) {
    return '';
  }
  if (/^[a-z0-9_-]+$/i.test(trimmed)) {
    return trimmed;
  }
  const escaped = trimmed.replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function joinGroup(values: string[]): string {
  const filtered = values.map(quoteIfNeeded).filter(Boolean);
  if (filtered.length === 0) {
    return '';
  }
  return filtered.join(' OR ');
}

export function buildProfileHeadlineQuery(profile: NormalizedSiteProfile): string {
  const groups: string[] = [];
  const mustGroup = joinGroup(profile.must_include_keywords);
  if (mustGroup) {
    groups.push(`(${mustGroup})`);
  }
  const entityGroup = joinGroup(profile.entities_focus);
  if (entityGroup) {
    groups.push(`(${entityGroup})`);
  }
  const taxonomyGroup = joinGroup(profile.taxonomy);
  if (taxonomyGroup) {
    groups.push(`(${taxonomyGroup})`);
  }

  let query = groups.join(' AND ');

  const niceGroup = joinGroup(profile.nice_to_have_keywords);
  if (niceGroup) {
    query = query ? `${query} OR (${niceGroup})` : `(${niceGroup})`;
  }

  const exclusions = profile.must_exclude_keywords
    .map(quoteIfNeeded)
    .filter(Boolean)
    .map((term) => `NOT ${term}`)
    .join(' ');

  if (exclusions) {
    query = query ? `${query} ${exclusions}` : exclusions.replace(/^NOT\s+/, '');
  }

  return query.trim();
}

export function getProfileQuotaTotal(profile: NormalizedSiteProfile): number {
  return Object.values(profile.target_categories_quota).reduce(
    (sum, value) => sum + value,
    0
  );
}

export function normalizeSiteUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Site URL is required');
  }
  const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  url.hash = '';
  if (url.pathname && url.pathname !== '/') {
    url.pathname = url.pathname.replace(/\/+$/, '');
  } else {
    url.pathname = '';
  }
  url.search = '';
  return url.toString();
}

export function extractHostname(siteUrl: string): string | null {
  try {
    const url = new URL(siteUrl);
    return url.hostname.replace(/^www\./i, '');
  } catch {
    return null;
  }
}
