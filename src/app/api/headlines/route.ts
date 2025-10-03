import { NextRequest, NextResponse } from 'next/server';
import { XMLParser } from 'fast-xml-parser';
import he from 'he';
import { getOpenAI } from '../../../lib/openai';
import { serpapiSearch, type SerpApiResult } from '../../../lib/serpapi';

const MIN_LIMIT = 1;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 5;
const MAX_FILTER_LIST_ITEMS = 20;
const MAX_RSS_FEEDS = 10;
const MAX_RSS_ITEMS_PER_FEED = 50;
const RSS_FEED_REQUEST_TIMEOUT_MS = 5000;
const RSS_ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const MAX_EXCLUDE_URLS = 200;
const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;

const LANGUAGE_CODES = [
  'ar',
  'de',
  'en',
  'es',
  'fr',
  'he',
  'it',
  'nl',
  'no',
  'pt',
  'ru',
  'sv',
  'ud',
  'zh',
] as const;
type LanguageCode = (typeof LANGUAGE_CODES)[number];
const LANGUAGE_SET = new Set<string>(LANGUAGE_CODES);

const COUNTRY_CODES = [
  'ae',
  'ar',
  'at',
  'au',
  'be',
  'bg',
  'br',
  'ca',
  'ch',
  'cn',
  'co',
  'cu',
  'cz',
  'de',
  'eg',
  'fr',
  'gb',
  'gr',
  'hk',
  'hu',
  'id',
  'ie',
  'il',
  'in',
  'it',
  'jp',
  'kr',
  'lt',
  'lv',
  'ma',
  'mx',
  'my',
  'ng',
  'nl',
  'no',
  'nz',
  'ph',
  'pl',
  'pt',
  'ro',
  'rs',
  'ru',
  'sa',
  'se',
  'sg',
  'si',
  'sk',
  'th',
  'tr',
  'tw',
  'ua',
  'us',
  've',
  'za',
] as const;
type CountryCode = (typeof COUNTRY_CODES)[number];
const COUNTRY_SET = new Set<string>(COUNTRY_CODES);

const SORT_BY_VALUES = ['publishedAt', 'relevancy', 'popularity'] as const;
type SortBy = (typeof SORT_BY_VALUES)[number];
const SORT_BY_SET = new Set<string>(SORT_BY_VALUES);

const SEARCH_IN_VALUES = ['title', 'description', 'content'] as const;
type SearchInValue = (typeof SEARCH_IN_VALUES)[number];
const SEARCH_IN_SET = new Set<string>(SEARCH_IN_VALUES);

const DEDUPE_MODES = ['default', 'strict'] as const;
type DedupeMode = (typeof DEDUPE_MODES)[number];
const DEDUPE_MODE_SET = new Set<string>(DEDUPE_MODES);

const ISO_DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
const SOURCE_ID_REGEX = /^[a-z0-9._-]+$/;
const DOMAIN_ALLOWED_REGEX = /^[a-z0-9.-]+$/;

function decodeHtmlEntities(value: string): string {
  if (!value) {
    return '';
  }

  const decoded = he.decode(value);

  return decoded
    .replace(/\u00a0/g, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .trim();
}

function decodeTextField(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return decodeHtmlEntities(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return decodeHtmlEntities(String(value));
  }

  return '';
}

function resolveLimit(rawLimit: unknown): number {
  let numeric: number | null = null;

  if (typeof rawLimit === 'number' && Number.isFinite(rawLimit)) {
    numeric = rawLimit;
  } else if (typeof rawLimit === 'string' && rawLimit.trim()) {
    const parsed = Number.parseInt(rawLimit, 10);
    if (!Number.isNaN(parsed)) {
      numeric = parsed;
    }
  }

  if (numeric === null) {
    return DEFAULT_LIMIT;
  }

  const truncated = Math.trunc(numeric);
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, truncated));
}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function normalizeLanguage(raw: unknown): LanguageCode | null | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }

  if (typeof raw !== 'string') {
    throw new Error('language must be a string value');
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  const lowered = trimmed.toLowerCase();
  if (lowered === 'all' || lowered === 'any') {
    return null;
  }

  if (!LANGUAGE_SET.has(lowered)) {
    throw new Error(`Unsupported language filter: ${trimmed}`);
  }

  return lowered as LanguageCode;
}

function normalizeSortBy(raw: unknown): SortBy {
  if (raw === undefined || raw === null) {
    return 'popularity';
  }

  if (typeof raw !== 'string') {
    throw new Error('sortBy must be a string value');
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return 'publishedAt';
  }

  if (!SORT_BY_SET.has(trimmed)) {
    throw new Error(`Unsupported sortBy value: ${trimmed}`);
  }

  return trimmed as SortBy;
}

function normalizeDate(raw: unknown, field: 'from' | 'to'): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }

  if (typeof raw !== 'string') {
    throw new Error(`${field} must be an ISO8601 string`);
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  let isoValue: string;

  if (ISO_DATE_ONLY_REGEX.test(trimmed)) {
    const parsed = new Date(`${trimmed}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`${field} must be a valid ISO8601 date`);
    }
    if (field === 'to') {
      const endOfDay = new Date(parsed.getTime() + ONE_DAY_IN_MS - 1);
      isoValue = endOfDay.toISOString();
    } else {
      isoValue = parsed.toISOString();
    }
  } else if (ISO_DATE_TIME_REGEX.test(trimmed)) {
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`${field} must be a valid ISO8601 date`);
    }
    isoValue = parsed.toISOString();
  } else {
    throw new Error(`${field} must be a valid ISO8601 date`);
  }

  return isoValue;
}

function normalizeCountry(raw: unknown): CountryCode | null {
  if (raw === undefined || raw === null) {
    return null;
  }

  if (typeof raw !== 'string') {
    throw new Error('country must be a string value');
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const lowered = trimmed.toLowerCase();
  if (!COUNTRY_SET.has(lowered)) {
    throw new Error(`Unsupported country selection: ${trimmed}`);
  }

  return lowered as CountryCode;
}

function normalizeSearchIn(raw: unknown): SearchInValue[] {
  if (raw === undefined || raw === null) {
    return [];
  }

  const values = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
    ? raw.split(',')
    : (() => {
        throw new Error('searchIn must be provided as a string or array');
      })();

  const selection = new Set<SearchInValue>();

  for (const value of values) {
    if (typeof value !== 'string') {
      throw new Error('searchIn must contain strings only');
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const lowered = trimmed.toLowerCase();
    if (!SEARCH_IN_SET.has(lowered)) {
      throw new Error(`Unsupported searchIn value: ${trimmed}`);
    }
    selection.add(lowered as SearchInValue);
  }

  return SEARCH_IN_VALUES.filter((option) => selection.has(option));
}

function normalizeDelimitedList(
  raw: unknown,
  {
    field,
    lowercase = false,
    validator,
  }: {
    field: string;
    lowercase?: boolean;
    validator?: (value: string) => boolean;
  }
): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }

  const values = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
    ? raw.split(',')
    : (() => {
        throw new Error(`${field} must be provided as a string or array`);
      })();

  const normalized: string[] = [];

  for (const entry of values) {
    if (typeof entry !== 'string') {
      throw new Error(`${field} must contain strings only`);
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const formatted = lowercase ? trimmed.toLowerCase() : trimmed;
    if (validator && !validator(formatted)) {
      throw new Error(`Invalid value in ${field}: ${trimmed}`);
    }
    normalized.push(formatted);
  }

  return Array.from(new Set(normalized)).slice(0, MAX_FILTER_LIST_ITEMS);
}

function normalizeSources(raw: unknown): string[] {
  return normalizeDelimitedList(raw, {
    field: 'sources',
    lowercase: true,
    validator: (value) => SOURCE_ID_REGEX.test(value),
  });
}

function normalizeDomains(
  raw: unknown,
  field: 'domains' | 'excludeDomains'
): string[] {
  return normalizeDelimitedList(raw, {
    field,
    lowercase: true,
    validator: (value) => DOMAIN_ALLOWED_REGEX.test(value) && value.includes('.'),
  });
}

function normalizeRssFeeds(raw: unknown): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }

  const entries: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
    ? raw.split(/[\r\n,;]+/)
    : (() => {
        throw new Error('rssFeeds must be provided as an array or string list of URLs');
      })();

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (typeof entry !== 'string') {
      throw new Error('rssFeeds must contain only string URLs');
    }

    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(`Invalid RSS feed URL: ${trimmed}`);
    }

    if (!RSS_ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      throw new Error(`RSS feeds must use http or https URLs: ${trimmed}`);
    }

    const normalizedUrl = parsed.toString();
    const key = normalizedUrl.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(normalizedUrl);

    if (normalized.length >= MAX_RSS_FEEDS) {
      break;
    }
  }

  return normalized;
}

function normalizeExcludeUrls(raw: unknown): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }

  const entries: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
    ? raw.split(/[\r\n,;]+/)
    : (() => {
        throw new Error('excludeUrls must be provided as an array or string list of URLs');
      })();

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (typeof entry !== 'string') {
      continue;
    }

    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }

    const normalizedUrl = normalizeUrlForComparison(trimmed);
    if (!normalizedUrl) {
      continue;
    }

    if (seen.has(normalizedUrl)) {
      continue;
    }

    seen.add(normalizedUrl);
    normalized.push(normalizedUrl);

    if (normalized.length >= MAX_EXCLUDE_URLS) {
      break;
    }
  }

  return normalized;
}

type HeadlinesRequestBody = {
  query?: unknown;
  keywords?: unknown;
  description?: unknown;
  limit?: unknown;
  language?: unknown;
  sortBy?: unknown;
  from?: unknown;
  to?: unknown;
  searchIn?: unknown;
  sources?: unknown;
  domains?: unknown;
  excludeDomains?: unknown;
  country?: unknown;
  rssFeeds?: unknown;
  dedupeMode?: unknown;
  excludeUrls?: unknown;
};

type OpenAIClient = {
  chat: {
    completions: {
      create: (
        options: {
          model: string;
          messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
          temperature?: number;
          max_tokens?: number;
        }
      ) => Promise<{
        choices?: Array<{
          message?: {
            content?: string | null;
          } | null;
        }>;
      }>;
    };
  };
};

type HeadlinesHandlerDependencies = {
  fetchImpl?: typeof fetch;
  openaiClient?: OpenAIClient;
  logger?: Pick<typeof console, 'error'>;
  rssRequestTimeoutMs?: number;
};

type TimeoutSignalHandle = {
  signal?: AbortSignal;
  cleanup: () => void;
};

function createAbortSignalWithTimeout(timeoutMs: number): TimeoutSignalHandle {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { cleanup: () => {} };
  }

  if (typeof AbortSignal !== 'undefined') {
    const timeoutFn = (AbortSignal as any)?.timeout;
    if (typeof timeoutFn === 'function') {
      const signal = timeoutFn.call(AbortSignal, timeoutMs) as AbortSignal;
      return { signal, cleanup: () => {} };
    }
  }

  if (typeof AbortController === 'undefined') {
    return { cleanup: () => {} };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId);
    },
  };
}

function normalizeKeywords(raw: unknown): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }

  if (!Array.isArray(raw)) {
    throw new Error('keywords must be provided as an array of strings');
  }

  const selection = new Set<string>();
  const normalized: string[] = [];

  for (const entry of raw) {
    if (typeof entry !== 'string') {
      throw new Error('keywords must be provided as an array of strings');
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const lowered = trimmed.toLowerCase();
    if (selection.has(lowered)) {
      continue;
    }
    selection.add(lowered);
    normalized.push(trimmed);
    if (normalized.length >= MAX_FILTER_LIST_ITEMS) {
      break;
    }
  }

  return normalized;
}

function normalizeStringList(
  values: unknown,
  {
    limit = MAX_FILTER_LIST_ITEMS,
    lowercaseDedup = true,
  }: { limit?: number; lowercaseDedup?: boolean } = {}
): string[] {
  const entries: unknown[] = Array.isArray(values)
    ? values
    : typeof values === 'string'
    ? values.split(/[\r\n,;]+/)
    : [];

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (typeof entry !== 'string') {
      continue;
    }

    const trimmed = entry.replace(/^[\s*-•]+/, '').trim();
    if (!trimmed) {
      continue;
    }

    const key = lowercaseDedup ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(trimmed);

    if (normalized.length >= limit) {
      break;
    }
  }

  return normalized;
}

function normalizeDedupeMode(raw: unknown): DedupeMode {
  if (raw === undefined || raw === null) {
    return 'default';
  }

  if (typeof raw !== 'string') {
    throw new Error('dedupeMode must be a string value');
  }

  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) {
    return 'default';
  }

  if (!DEDUPE_MODE_SET.has(trimmed)) {
    throw new Error(`Unsupported dedupeMode value: ${raw}`);
  }

  return trimmed as DedupeMode;
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (value === undefined || value === null) {
    return [];
  }

  return [value];
}

function extractTextValue(value: unknown): string {
  if (typeof value === 'string') {
    return decodeHtmlEntities(value);
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = extractTextValue(entry);
      if (text) {
        return text;
      }
    }
    return '';
  }

  if (value && typeof value === 'object') {
    const candidate =
      (value as Record<string, unknown>)['#text'] ??
      (value as Record<string, unknown>).text ??
      (value as Record<string, unknown>).value;
    if (typeof candidate === 'string') {
      return decodeHtmlEntities(candidate);
    }
  }

  return '';
}

function extractLinkValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const link = extractLinkValue(entry);
      if (link) {
        return link;
      }
    }
    return '';
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const href = record['@_href'] ?? record.href ?? record.url;
    if (typeof href === 'string') {
      return href.trim();
    }

    const text = record['#text'];
    if (typeof text === 'string') {
      return text.trim();
    }
  }

  return '';
}

function normalizeRssDateValue(value: unknown): string {
  const text = extractTextValue(value);
  if (!text) {
    return '';
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return text;
}

function resolveHostnameFromUrl(url: string): string {
  if (!url) {
    return '';
  }

  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function extractSectionList(text: string, labels: string[]): string[] {
  for (const label of labels) {
    const regex = new RegExp(
      `${label.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\s*:\\s*([\\s\\S]*?)(?:\\n\\s*\\n|$)`,
      'i'
    );
    const match = text.match(regex);
    if (match) {
      return normalizeStringList(match[1]);
    }
  }

  return [];
}

function parseKeywordResponse(raw: string): string[] {
  if (!raw) {
    return [];
  }

  const attemptParse = (text: string) => {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore parse failure
    }

    return null;
  };

  const keywordKeys = ['keywords', 'keywordSuggestions', 'topics', 'queries'];

  const candidates: Record<string, unknown>[] = [];

  const direct = attemptParse(raw);
  if (direct) {
    candidates.push(direct);
  }

  if (!direct) {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const nested = attemptParse(jsonMatch[0]);
      if (nested) {
        candidates.push(nested);
      }
    }
  }

  for (const candidate of candidates) {
    const keywords = keywordKeys.flatMap((key) =>
      key in candidate ? normalizeStringList(candidate[key]) : []
    );

    if (keywords.length > 0) {
      return keywords;
    }
  }

  const fallbackKeywords = extractSectionList(raw, [
    'keywords',
    'keyword ideas',
    'topics',
    'key phrases',
    'search terms',
  ]);

  return fallbackKeywords;
}

function fallbackKeywordsFromDescription(
  description: string,
  limit: number
): string[] {
  const tokens = description
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    const lowered = token.toLowerCase();
    if (seen.has(lowered)) {
      continue;
    }

    seen.add(lowered);
    normalized.push(token);

    if (normalized.length >= limit) {
      break;
    }
  }

  return normalized;
}

async function inferKeywordsFromDescription(
  client: OpenAIClient,
  description: string,
  requestedLimit: number
): Promise<string[]> {
  const keywordTarget = Math.min(
    MAX_FILTER_LIST_ITEMS,
    Math.max(4, Math.ceil(requestedLimit * 1.5))
  );
  const systemPrompt =
    'You analyze news-focused website descriptions to recommend search keywords. ' +
    'Always respond with a valid JSON object that only contains a "keywords" property. ' +
    'Keywords should be short search phrases suitable for the NewsAPI everything endpoint.';
  const userPrompt =
    `The description of the news site is:\n"""${description}"""\n\n` +
    `Return around ${keywordTarget} diverse keywords capturing geographic, topical, and audience angles. ` +
    'Format: {"keywords": [..]}.';

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.5,
    max_tokens: 400,
  });

  const content = response.choices?.[0]?.message?.content?.trim() ?? '';
  const parsedKeywords = parseKeywordResponse(content);

  let keywords = normalizeStringList(parsedKeywords, {
    limit: keywordTarget,
    lowercaseDedup: true,
  });

  if (keywords.length === 0) {
    keywords = fallbackKeywordsFromDescription(description, keywordTarget);
  }

  if (keywords.length === 0) {
    throw new Error('No keywords returned from OpenAI');
  }

  return keywords;
}

type RelatedArticle = {
  title: string;
  description: string;
  url: string;
  source: string;
  publishedAt: string;
};

type NormalizedHeadline = {
  title: string;
  description: string;
  url: string;
  source: string;
  publishedAt: string;
  queryUsed?: string;
  keyword?: string;
  searchQuery?: string;
};

function headlineMatchesKeyword(
  keyword: string,
  headline: Pick<NormalizedHeadline, 'title' | 'description'>
): boolean {
  const trimmed = keyword.trim();
  if (!trimmed) {
    return true;
  }

  const loweredKeyword = trimmed.toLowerCase();
  const loweredTitle = (headline.title || '').toLowerCase();
  const loweredDescription = (headline.description || '').toLowerCase();

  return (
    loweredTitle.includes(loweredKeyword) ||
    loweredDescription.includes(loweredKeyword)
  );
}

function extractRssFeedPayload(parsed: unknown): {
  feedTitle: string;
  items: unknown[];
} {
  if (!parsed || typeof parsed !== 'object') {
    return { feedTitle: '', items: [] };
  }

  const root = parsed as Record<string, unknown>;

  const resolveChannel = (value: unknown) => {
    const channel = value && typeof value === 'object'
      ? (value as Record<string, unknown>).channel ?? value
      : value;
    const resolved = Array.isArray(channel) ? channel[0] : channel;
    return resolved && typeof resolved === 'object'
      ? (resolved as Record<string, unknown>)
      : null;
  };

  let feedTitle = '';
  let items: unknown[] = [];

  const rss = root.rss ?? root.RSS;
  const rssChannel = resolveChannel(rss);
  if (rssChannel) {
    feedTitle = extractTextValue(rssChannel.title) || feedTitle;
    items = toArray(rssChannel.item ?? rssChannel.items);
  }

  if (items.length === 0) {
    const directChannel = resolveChannel(root.channel);
    if (directChannel) {
      feedTitle = extractTextValue(directChannel.title) || feedTitle;
      items = toArray(directChannel.item ?? directChannel.items);
    }
  }

  if (items.length === 0) {
    const feedCandidate = root.feed ?? root.Feed ?? parsed;
    const feedObject = Array.isArray(feedCandidate)
      ? feedCandidate[0]
      : feedCandidate;
    if (feedObject && typeof feedObject === 'object') {
      const feedRecord = feedObject as Record<string, unknown>;
      feedTitle = extractTextValue(feedRecord.title) || feedTitle;
      items = toArray(
        feedRecord.entry ??
          feedRecord.entries ??
          feedRecord.item ??
          feedRecord.items
      );
    }
  }

  return { feedTitle, items };
}

function mapRssItemsToHeadlines(
  items: unknown[],
  feedTitle: string,
  feedUrl: string,
  queryLabel: string,
  fromTimestamp: number | null,
  toTimestamp: number | null
): NormalizedHeadline[] {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const normalized: NormalizedHeadline[] = [];
  for (const rawItem of items) {
    if (normalized.length >= MAX_RSS_ITEMS_PER_FEED) {
      break;
    }

    if (!rawItem || typeof rawItem !== 'object') {
      continue;
    }

    const record = rawItem as Record<string, unknown>;
    const title = extractTextValue(record.title);
    const linkCandidates =
      record.link ?? record.url ?? record.guid ?? record.id ?? null;
    let url = extractLinkValue(linkCandidates);

    if (!title || !url) {
      continue;
    }

    try {
      const parsedUrl = new URL(url);
      if (!RSS_ALLOWED_PROTOCOLS.has(parsedUrl.protocol)) {
        continue;
      }
      url = parsedUrl.toString();
    } catch {
      continue;
    }

    const description =
      extractTextValue(record.description) ||
      extractTextValue(record.summary) ||
      extractTextValue(record['content:encoded']) ||
      extractTextValue(record.content) ||
      extractTextValue(record.subtitle) ||
      '';

    const publishedAt = normalizeRssDateValue(
      record.pubDate ??
        record.pubdate ??
        record.published ??
        record.updated ??
        record['dc:date']
    );

    const itemSource =
      extractTextValue(record.source) ||
      extractTextValue(record['dc:creator']) ||
      '';

    const source =
      itemSource || feedTitle || resolveHostnameFromUrl(url) || 'RSS Feed';

    let publishedTimestamp: number | null = null;
    if (publishedAt) {
      const parsed = new Date(publishedAt);
      if (!Number.isNaN(parsed.getTime())) {
        publishedTimestamp = parsed.getTime();
      }
    }

    if (publishedTimestamp === null) {
      continue;
    }

    if (
      (fromTimestamp !== null && publishedTimestamp < fromTimestamp) ||
      (toTimestamp !== null && publishedTimestamp > toTimestamp)
    ) {
      continue;
    }

    normalized.push({
      title,
      description,
      url,
      source,
      publishedAt,
      queryUsed: queryLabel,
      searchQuery: feedUrl,
    });
  }

  return normalized;
}

type HeadlineResponseEntry = NormalizedHeadline & {
  relatedArticles?: RelatedArticle[];
  ranking?: HeadlineRankingMetadata;
};

type HeadlineCandidate = {
  data: NormalizedHeadline;
  normalizedUrl: string;
  normalizedTitle: string;
  tokenSet: Set<string>;
  normalizedDescription: string;
  related: RelatedArticle[];
};

type DedupeOptions = {
  mode: DedupeMode;
  excludedUrls?: Set<string>;
};

type HeadlineRankingComponents = {
  recency: number;
  sourceDiversity: number;
  topicCoverage: number;
  clusterSupport: number;
};

type HeadlineRankingMetadata = {
  score: number;
  components: HeadlineRankingComponents;
  details: {
    ageHours: number | null;
    sourceOccurrences: number;
    uniqueTokenRatio: number;
    clusterSize: number;
    clusterUniqueSources: number;
  };
  reasons: string[];
};

type RankedHeadlineCandidate = {
  candidate: HeadlineCandidate;
  ranking: HeadlineRankingMetadata;
};

type SearchQueryDefinition = {
  query: string;
  type: 'manual' | 'keyword' | 'description';
  keyword?: string;
  fallback?: boolean;
};

type KeywordAggregation = {
  query: string;
  candidates: HeadlineCandidate[];
};

const MAX_TOKEN_COUNT = 64;
const TOKEN_MIN_LENGTH_DEFAULT = 3;
const TOKEN_MIN_LENGTH_STRICT = 2;
const TOKEN_OVERLAP_THRESHOLD_DEFAULT = 0.7;
const TOKEN_OVERLAP_THRESHOLD_STRICT = 0.55;
const STRICT_TITLE_SIMILARITY_THRESHOLD = 0.88;
const RANKING_RECENCY_WEIGHT = 0.45;
const RANKING_SOURCE_WEIGHT = 0.2;
const RANKING_TOPIC_WEIGHT = 0.2;
const RANKING_CLUSTER_WEIGHT = 0.25;
const CLUSTER_SIZE_FULL_SCORE = 8;
const CLUSTER_SOURCES_FULL_SCORE = 5;

function normalizeUrlForComparison(url: string): string {
  if (!url) {
    return '';
  }

  try {
    const parsed = new URL(url);
    const normalizedPath = parsed.pathname.replace(/\/+$/g, '');
    return `${parsed.protocol}//${parsed.hostname}${normalizedPath}`
      .replace(/\/+$/g, '')
      .toLowerCase();
  } catch {
    return url.trim().replace(/\/+$/g, '').toLowerCase();
  }
}

function normalizeHeadlineText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function getTokenMinLength(mode: DedupeMode): number {
  return mode === 'strict' ? TOKEN_MIN_LENGTH_STRICT : TOKEN_MIN_LENGTH_DEFAULT;
}

function normalizeTokenVariants(token: string, mode: DedupeMode): string[] {
  if (mode !== 'strict') {
    return [token];
  }

  let base = token;
  base = base.replace(/'(?:s|re|d)$/g, '');

  if (base.endsWith('ies') && base.length > 4) {
    base = `${base.slice(0, -3)}y`;
  } else if (base.endsWith('ied') && base.length > 4) {
    base = `${base.slice(0, -3)}y`;
  }

  const suffixes = [
    'ations',
    'ation',
    'ments',
    'ment',
    'izing',
    'ingly',
    'ing',
    'ers',
    'er',
    'ied',
    'ies',
    'ed',
    'ly',
    'es',
    's',
  ];

  let stemmed = base;
  for (const suffix of suffixes) {
    if (stemmed.endsWith(suffix) && stemmed.length - suffix.length >= 3) {
      stemmed = stemmed.slice(0, -suffix.length);
      break;
    }
  }

  const variants = new Set<string>();
  variants.add(token);
  variants.add(base);
  variants.add(stemmed);

  return Array.from(variants).filter(Boolean);
}

function buildTokenSet(
  title: string,
  description: string,
  mode: DedupeMode
): Set<string> {
  const combined = `${title} ${description}`;
  const minLength = getTokenMinLength(mode);
  const rawTokens = combined
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= minLength);

  const tokenSet = new Set<string>();
  for (const token of rawTokens) {
    if (!token) {
      continue;
    }
    const variants = normalizeTokenVariants(token, mode);
    for (const variant of variants) {
      if (!variant || variant.length < minLength) {
        continue;
      }
      tokenSet.add(variant);
      if (tokenSet.size >= MAX_TOKEN_COUNT) {
        return tokenSet;
      }
    }
  }

  return tokenSet;
}

function computeTokenOverlapRatio(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }

  const smaller = a.size <= b.size ? a : b;
  const larger = smaller === a ? b : a;

  let intersection = 0;
  smaller.forEach((token) => {
    if (larger.has(token)) {
      intersection += 1;
    }
  });

  return intersection / Math.max(1, smaller.size);
}

function getTokenOverlapThreshold(mode: DedupeMode): number {
  return mode === 'strict'
    ? TOKEN_OVERLAP_THRESHOLD_STRICT
    : TOKEN_OVERLAP_THRESHOLD_DEFAULT;
}

function computeJaroWinklerSimilarity(a: string, b: string): number {
  if (!a || !b) {
    return 0;
  }

  if (a === b) {
    return 1;
  }

  const aLength = a.length;
  const bLength = b.length;
  const matchDistance = Math.max(0, Math.floor(Math.max(aLength, bLength) / 2) - 1);

  const aMatches = new Array<boolean>(aLength).fill(false);
  const bMatches = new Array<boolean>(bLength).fill(false);

  let matches = 0;
  for (let i = 0; i < aLength; i += 1) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, bLength);

    for (let j = start; j < end; j += 1) {
      if (bMatches[j]) {
        continue;
      }
      if (a[i] !== b[j]) {
        continue;
      }
      aMatches[i] = true;
      bMatches[j] = true;
      matches += 1;
      break;
    }
  }

  if (matches === 0) {
    return 0;
  }

  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < aLength; i += 1) {
    if (!aMatches[i]) {
      continue;
    }

    while (k < bLength && !bMatches[k]) {
      k += 1;
    }

    if (k >= bLength) {
      break;
    }

    if (a[i] !== b[k]) {
      transpositions += 1;
    }
    k += 1;
  }

  const m = matches;
  const jaro =
    (m / aLength + m / bLength + (m - transpositions / 2) / m) / 3;

  let prefix = 0;
  const maxPrefix = Math.min(4, aLength, bLength);
  while (prefix < maxPrefix && a[prefix] === b[prefix]) {
    prefix += 1;
  }

  const winkler = jaro + prefix * 0.1 * (1 - jaro);
  return Math.min(1, winkler);
}

function areHeadlinesNearDuplicate(
  a: HeadlineCandidate,
  b: HeadlineCandidate,
  options: DedupeOptions
): boolean {
  if (a.normalizedUrl && b.normalizedUrl && a.normalizedUrl === b.normalizedUrl) {
    return true;
  }

  if (
    a.normalizedTitle &&
    b.normalizedTitle &&
    a.normalizedTitle === b.normalizedTitle
  ) {
    return true;
  }

  if (
    a.normalizedDescription &&
    b.normalizedDescription &&
    a.normalizedDescription === b.normalizedDescription
  ) {
    return true;
  }

  const overlap = computeTokenOverlapRatio(a.tokenSet, b.tokenSet);
  if (overlap >= getTokenOverlapThreshold(options.mode)) {
    return true;
  }

  if (options.mode === 'strict') {
    const titleSimilarity = computeJaroWinklerSimilarity(
      a.normalizedTitle,
      b.normalizedTitle
    );
    if (titleSimilarity >= STRICT_TITLE_SIMILARITY_THRESHOLD) {
      return true;
    }
  }

  return false;
}

function createHeadlineCandidate(
  headline: NormalizedHeadline,
  options: DedupeOptions
): HeadlineCandidate {
  return {
    data: headline,
    normalizedUrl: normalizeUrlForComparison(headline.url),
    normalizedTitle: normalizeHeadlineText(headline.title),
    normalizedDescription: normalizeHeadlineText(headline.description),
    tokenSet: buildTokenSet(headline.title, headline.description, options.mode),
    related: [],
  };
}

function addHeadlineIfUnique(
  aggregated: HeadlineCandidate[],
  candidate: NormalizedHeadline,
  options: DedupeOptions
): boolean {
  const enriched = createHeadlineCandidate(candidate, options);

  if (
    enriched.normalizedUrl &&
    options.excludedUrls &&
    options.excludedUrls.has(enriched.normalizedUrl)
  ) {
    return false;
  }

  for (const existing of aggregated) {
    if (areHeadlinesNearDuplicate(existing, enriched, options)) {
      const normalizedCandidateUrl = normalizeUrlForComparison(candidate.url);
      if (
        normalizedCandidateUrl &&
        (normalizedCandidateUrl === existing.normalizedUrl ||
          existing.related.some(
            (relatedArticle) =>
              normalizeUrlForComparison(relatedArticle.url) === normalizedCandidateUrl
          ))
      ) {
        return false;
      }

      if (
        candidate.description &&
        candidate.description.length > existing.data.description.length
      ) {
        existing.data.description = candidate.description;
        existing.normalizedDescription = normalizeHeadlineText(candidate.description);
      }

      if (candidate.keyword && !existing.data.keyword) {
        existing.data.keyword = candidate.keyword;
      }

      if (candidate.queryUsed && !existing.data.queryUsed) {
        existing.data.queryUsed = candidate.queryUsed;
      }

      if (candidate.searchQuery && !existing.data.searchQuery) {
        existing.data.searchQuery = candidate.searchQuery;
      }

      existing.related.push({
        title: candidate.title,
        description: candidate.description,
        url: candidate.url,
        source: candidate.source,
        publishedAt: candidate.publishedAt,
      });

      for (const token of enriched.tokenSet) {
        existing.tokenSet.add(token);
      }

      return false;
    }
  }

  aggregated.push(enriched);
  return true;
}

function computeRecencyScore(publishedAt: string): {
  score: number;
  ageHours: number | null;
} {
  if (!publishedAt) {
    return { score: 0, ageHours: null };
  }

  const parsed = Date.parse(publishedAt);
  if (Number.isNaN(parsed)) {
    return { score: 0, ageHours: null };
  }

  const now = Date.now();
  const ageHours = Math.max(0, (now - parsed) / (1000 * 60 * 60));
  const maxHours = 72;
  const clamped = Math.min(ageHours, maxHours);
  const score = Number.isFinite(clamped) ? 1 - clamped / maxHours : 0;
  return { score, ageHours };
}

function computeSourceDiversityScore(
  occurrences: number
): { score: number } {
  if (!Number.isFinite(occurrences) || occurrences <= 0) {
    return { score: 0 };
  }

  const score = 1 / occurrences;
  return { score };
}

function computeTopicCoverageScore(
  tokenSet: Set<string>,
  tokenFrequency: Map<string, number>
): { score: number; ratio: number } {
  if (tokenSet.size === 0) {
    return { score: 0, ratio: 0 };
  }

  let uniqueTokens = 0;
  tokenSet.forEach((token) => {
    if ((tokenFrequency.get(token) ?? 0) <= 1) {
      uniqueTokens += 1;
    }
  });

  const ratio = uniqueTokens / Math.max(1, tokenSet.size);
  return { score: ratio, ratio };
}

function computeClusterSupportScore(
  candidate: HeadlineCandidate
): {
  score: number;
  clusterSize: number;
  clusterUniqueSources: number;
} {
  const clusterSize = Math.max(1, candidate.related.length + 1);
  const sources = new Set<string>();

  const baseSource = candidate.data.source.trim().toLowerCase();
  sources.add(baseSource || 'unknown');

  candidate.related.forEach((article) => {
    const normalized = article.source.trim().toLowerCase();
    sources.add(normalized || 'unknown');
  });

  const clusterUniqueSources = sources.size;

  const normalizedSize =
    CLUSTER_SIZE_FULL_SCORE <= 1
      ? clusterSize > 1
        ? 1
        : 0
      : Math.min(1, (clusterSize - 1) / (CLUSTER_SIZE_FULL_SCORE - 1));

  const normalizedSources =
    CLUSTER_SOURCES_FULL_SCORE <= 1
      ? clusterUniqueSources > 1
        ? 1
        : 0
      : Math.min(
          1,
          (clusterUniqueSources - 1) / (CLUSTER_SOURCES_FULL_SCORE - 1)
        );

  const score = Math.min(1, (normalizedSize + normalizedSources) / 2);

  return { score, clusterSize, clusterUniqueSources };
}

function buildRankingReasons(metadata: HeadlineRankingMetadata): string[] {
  const reasons: string[] = [];

  if (metadata.details.ageHours !== null) {
    if (metadata.components.recency >= 0.75) {
      reasons.push('Published within the last 18 hours');
    } else if (metadata.components.recency >= 0.5) {
      reasons.push('Published recently');
    } else if (metadata.components.recency <= 0.1) {
      reasons.push('Older coverage');
    }
  }

  if (metadata.components.sourceDiversity >= 0.75) {
    reasons.push('Unique source in this set');
  } else if (metadata.components.sourceDiversity <= 0.25) {
    reasons.push('Source appears multiple times');
  }

  if (metadata.components.topicCoverage >= 0.6) {
    reasons.push('Adds distinct topic details');
  } else if (metadata.components.topicCoverage <= 0.2) {
    reasons.push('Overlaps heavily with other articles');
  }

  if (metadata.components.clusterSupport >= 0.6) {
    reasons.push('Covered by many outlets');
  } else if (metadata.components.clusterSupport >= 0.3) {
    reasons.push('Multiple supporting reports');
  } else if (metadata.details.clusterSize <= 1) {
    reasons.push('Limited supporting coverage');
  }

  return reasons;
}

function rankHeadlineCandidates(
  candidates: HeadlineCandidate[]
): RankedHeadlineCandidate[] {
  if (candidates.length === 0) {
    return [];
  }

  const sourceFrequency = new Map<string, number>();
  const tokenFrequency = new Map<string, number>();

  candidates.forEach((candidate) => {
    const sourceKey = candidate.data.source.trim().toLowerCase() || 'unknown';
    sourceFrequency.set(sourceKey, (sourceFrequency.get(sourceKey) ?? 0) + 1);

    candidate.tokenSet.forEach((token) => {
      tokenFrequency.set(token, (tokenFrequency.get(token) ?? 0) + 1);
    });
  });

  const scored = candidates.map((candidate, index) => {
    const sourceKey = candidate.data.source.trim().toLowerCase() || 'unknown';
    const sourceOccurrences = sourceFrequency.get(sourceKey) ?? 1;

    const recency = computeRecencyScore(candidate.data.publishedAt);
    const source = computeSourceDiversityScore(sourceOccurrences);
    const topic = computeTopicCoverageScore(candidate.tokenSet, tokenFrequency);
    const cluster = computeClusterSupportScore(candidate);

    const score =
      recency.score * RANKING_RECENCY_WEIGHT +
      source.score * RANKING_SOURCE_WEIGHT +
      topic.score * RANKING_TOPIC_WEIGHT +
      cluster.score * RANKING_CLUSTER_WEIGHT;

    const metadata: HeadlineRankingMetadata = {
      score,
      components: {
        recency: recency.score,
        sourceDiversity: source.score,
        topicCoverage: topic.score,
        clusterSupport: cluster.score,
      },
      details: {
        ageHours: recency.ageHours,
        sourceOccurrences,
        uniqueTokenRatio: topic.ratio,
        clusterSize: cluster.clusterSize,
        clusterUniqueSources: cluster.clusterUniqueSources,
      },
      reasons: [],
    };

    metadata.reasons = buildRankingReasons(metadata);

    return {
      candidate,
      ranking: metadata,
      index,
    };
  });

  scored.sort((a, b) => {
    if (b.ranking.score !== a.ranking.score) {
      return b.ranking.score - a.ranking.score;
    }

    const aAge = a.ranking.details.ageHours;
    const bAge = b.ranking.details.ageHours;
    if (aAge !== null || bAge !== null) {
      const normalizedAAge = aAge === null ? Number.POSITIVE_INFINITY : aAge;
      const normalizedBAge = bAge === null ? Number.POSITIVE_INFINITY : bAge;
      if (normalizedAAge !== normalizedBAge) {
        return normalizedAAge - normalizedBAge;
      }
    }

    return a.index - b.index;
  });

  return scored.map(({ index: _index, ...rest }) => rest);
}

function buildHeadlineResponses(
  ranked: RankedHeadlineCandidate[]
): HeadlineResponseEntry[] {
  if (ranked.length === 0) {
    return [];
  }

  return ranked.map((entry) => {
    const { candidate, ranking } = entry;
    const relatedArticles =
      candidate.related.length > 0
        ? candidate.related.map((article) => ({ ...article }))
        : undefined;

    return {
      title: candidate.data.title,
      description: candidate.data.description,
      url: candidate.data.url,
      source: candidate.data.source,
      publishedAt: candidate.data.publishedAt,
      relatedArticles,
      ranking,
    };
  });
}

function normalizeSerpResult(result: SerpApiResult): NormalizedHeadline | null {
  const title = decodeTextField(result?.title);
  const url = typeof result?.link === 'string' ? result.link.trim() : '';

  if (!title || !url) {
    return null;
  }

  const description =
    decodeTextField(result?.snippet) || decodeTextField(result?.summary);
  const source = decodeTextField(result?.source);
  const publishedAt =
    decodeTextField(result?.date) ||
    decodeTextField(result?.published_at) ||
    decodeTextField(result?.date_published);

  return {
    title,
    description,
    url,
    source,
    publishedAt,
  };
}

function computeSerpTimeFilter(from: string | null, to: string | null): string {
  const nowCandidate = to ? new Date(to) : new Date();
  const now = Number.isNaN(nowCandidate.getTime()) ? new Date() : nowCandidate;

  if (from) {
    const fromDate = new Date(from);
    if (!Number.isNaN(fromDate.getTime())) {
      const diffHours = Math.max(
        0,
        (now.getTime() - fromDate.getTime()) / (1000 * 60 * 60)
      );

      if (diffHours <= 1) {
        return 'qdr:h';
      }
      if (diffHours <= 6) {
        return 'qdr:h6';
      }
      if (diffHours <= 24) {
        return 'qdr:d';
      }
      if (diffHours <= 24 * 7) {
        return 'qdr:w';
      }
      if (diffHours <= 24 * 14) {
        return 'qdr:w2';
      }
      if (diffHours <= 24 * 30) {
        return 'qdr:m';
      }

      return 'qdr:y';
    }
  }

  return 'qdr:w2';
}

function createHeadlinesHandler(
  {
    fetchImpl,
    openaiClient,
    logger,
    rssRequestTimeoutMs,
  }: HeadlinesHandlerDependencies = {}
) {
  const requester = fetchImpl ?? fetch;
  const log = (logger ?? console) as Pick<typeof console, 'error'>;
  const rssTimeoutMs =
    typeof rssRequestTimeoutMs === 'number' && Number.isFinite(rssRequestTimeoutMs)
      ? Math.max(1, Math.trunc(rssRequestTimeoutMs))
      : RSS_FEED_REQUEST_TIMEOUT_MS;

  return async function handler(req: NextRequest) {
    const aiClient = openaiClient ?? getOpenAI();

    let body: HeadlinesRequestBody;
  try {
    body = await req.json();
  } catch {
    return badRequest('Invalid JSON body');
  }

  const query = typeof body.query === 'string' ? body.query.trim() : '';

  let keywords: string[];
  try {
    keywords = normalizeKeywords(body.keywords);
  } catch (error) {
    return badRequest(
      error instanceof Error ? error.message : 'Invalid keywords parameter'
    );
  }

  let description = '';
  if (body.description === undefined || body.description === null) {
    description = '';
  } else if (typeof body.description === 'string') {
    description = body.description.trim();
  } else {
    return badRequest('description must be a string value');
  }

  let country: CountryCode | null;
  try {
    country = normalizeCountry(body.country);
  } catch (error) {
    return badRequest(
      error instanceof Error ? error.message : 'Invalid country parameter'
    );
  }

  if (!query && keywords.length === 0 && !description) {
    return badRequest('Either query, keywords, or description must be provided');
  }

  const limit = resolveLimit(body.limit);

  let dedupeMode: DedupeMode;
  try {
    dedupeMode = normalizeDedupeMode(body.dedupeMode);
  } catch (error) {
    return badRequest(
      error instanceof Error ? error.message : 'Invalid dedupeMode parameter'
    );
  }

  const dedupeOptions: DedupeOptions = { mode: dedupeMode };

  let language: LanguageCode | null | undefined;
  try {
    language = normalizeLanguage(body.language);
  } catch (error) {
    return badRequest(
      error instanceof Error ? error.message : 'Invalid language parameter'
    );
  }

  let sortBy: SortBy;
  try {
    sortBy = normalizeSortBy(body.sortBy);
  } catch (error) {
    return badRequest(
      error instanceof Error ? error.message : 'Invalid sortBy parameter'
    );
  }

  let from: string | null;
  let to: string | null;
  try {
    from = normalizeDate(body.from, 'from');
    to = normalizeDate(body.to, 'to');
  } catch (error) {
    return badRequest(
      error instanceof Error ? error.message : 'Invalid date filters'
    );
  }

  if (!from && !to) {
    const today = new Date(Date.now());
    const defaultTo = today.toISOString().slice(0, 10);
    const fromDate = new Date(today);
    fromDate.setUTCDate(fromDate.getUTCDate() - 30);
    const defaultFrom = fromDate.toISOString().slice(0, 10);

    from = defaultFrom;
    to = defaultTo;
  }

  if (from && to && new Date(from).getTime() > new Date(to).getTime()) {
    return badRequest('from must be earlier than or equal to to');
  }

  let searchInValues: SearchInValue[];
  try {
    searchInValues = normalizeSearchIn(body.searchIn);
  } catch (error) {
    return badRequest(
      error instanceof Error ? error.message : 'Invalid searchIn parameter'
    );
  }

  let sources: string[];
  let domains: string[];
  let excludeDomains: string[];
  let rssFeeds: string[];
  let excludeUrls: string[];
  try {
    sources = normalizeSources(body.sources);
    domains = normalizeDomains(body.domains, 'domains');
    excludeDomains = normalizeDomains(body.excludeDomains, 'excludeDomains');
    rssFeeds = normalizeRssFeeds(body.rssFeeds);
    excludeUrls = normalizeExcludeUrls(body.excludeUrls);
  } catch (error) {
    return badRequest(
      error instanceof Error ? error.message : 'Invalid domain or RSS feed filters'
    );
  }

  if (excludeUrls.length > 0) {
    dedupeOptions.excludedUrls = new Set(excludeUrls);
  }

  if (sources.length > 0 && (domains.length > 0 || excludeDomains.length > 0)) {
    return badRequest('sources cannot be combined with domains or excludeDomains');
  }

  const apiKey = process.env.NEWSAPI_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: 'NEWSAPI_API_KEY is not configured' },
      { status: 500 }
    );
  }

  let inferredKeywords: string[] | null = null;

  if (keywords.length === 0 && description) {
    try {
      inferredKeywords = await inferKeywordsFromDescription(
        aiClient,
        description,
        limit
      );
      keywords = inferredKeywords;
    } catch (error) {
      log.error('[api/headlines] keyword inference failed', error);
      return NextResponse.json(
        { error: 'Failed to infer keywords from description' },
        { status: 502 }
      );
    }

    if (keywords.length === 0) {
      return badRequest('Unable to infer keywords from the provided description');
    }
  }

  const searchQueryCandidates: SearchQueryDefinition[] = [];
  const fallbackKeywordCandidates: SearchQueryDefinition[] = [];

  if (query) {
    searchQueryCandidates.push({ query, type: 'manual' });
  }

  if (keywords.length > 0) {
    const trimmedKeywords = keywords
      .map((keyword) => keyword.trim())
      .filter((keyword) => keyword.length > 0);

    if (trimmedKeywords.length > 0) {
      for (const trimmedKeyword of trimmedKeywords) {
        const queryValue = /\s/.test(trimmedKeyword)
          ? `"${trimmedKeyword}"`
          : trimmedKeyword;

        fallbackKeywordCandidates.push({
          query: queryValue,
          type: 'keyword',
          keyword: trimmedKeyword,
          fallback: true,
        });
      }
    }
  }

  const seenQueries = new Set<string>();
  const searchQueries: SearchQueryDefinition[] = [];

  for (const candidate of [
    ...searchQueryCandidates,
    ...fallbackKeywordCandidates,
  ]) {
    const normalizedQuery = candidate.query.trim();
    if (!normalizedQuery) {
      continue;
    }

    const dedupeKey = normalizedQuery.toLowerCase();
    if (seenQueries.has(dedupeKey)) {
      continue;
    }

    seenQueries.add(dedupeKey);
    searchQueries.push({
      ...candidate,
      query: normalizedQuery,
    });
  }

  if (searchQueries.length === 0) {
    return badRequest('No valid search queries were provided');
  }

  const buildUrl = (q: string, pageSize: number, page = 1) => {
    const requestUrl = new URL('https://newsapi.org/v2/everything');
    requestUrl.searchParams.set('q', q);
    requestUrl.searchParams.set('pageSize', String(Math.max(1, pageSize)));
    const normalizedPage =
      Number.isFinite(page) && page ? Math.max(1, Math.trunc(page)) : 1;
    requestUrl.searchParams.set('page', String(normalizedPage));
    requestUrl.searchParams.set('sortBy', sortBy);

    if (language === undefined) {
      requestUrl.searchParams.set('language', 'en');
    } else if (language !== null) {
      requestUrl.searchParams.set('language', language);
    }

    if (from) {
      requestUrl.searchParams.set('from', from);
    }

    if (to) {
      requestUrl.searchParams.set('to', to);
    }

    if (searchInValues.length > 0) {
      requestUrl.searchParams.set('searchIn', searchInValues.join(','));
    }

    if (sources.length > 0) {
      requestUrl.searchParams.set('sources', sources.join(','));
    }

    if (domains.length > 0) {
      requestUrl.searchParams.set('domains', domains.join(','));
    }

    if (excludeDomains.length > 0) {
      requestUrl.searchParams.set('excludeDomains', excludeDomains.join(','));
    }

    return requestUrl;
  };

  const aggregatedHeadlines: HeadlineCandidate[] = [];
  const fromDateLimit = from ? new Date(from) : null;
  const toDateLimit = to ? new Date(to) : null;
  const fromTimestamp =
    fromDateLimit && !Number.isNaN(fromDateLimit.getTime())
      ? fromDateLimit.getTime()
      : null;
  const toTimestamp =
    toDateLimit && !Number.isNaN(toDateLimit.getTime())
      ? toDateLimit.getTime()
      : null;
  const queriesAttempted: string[] = [];
  const queryWarnings: string[] = [];
  let successfulQueries = 0;
  const primaryQueryCount = searchQueries.filter((entry) => !entry.fallback).length;
  const fallbackQueryCount = searchQueries.filter((entry) => entry.fallback).length;
  const perQuery = Math.max(1, Math.ceil(limit / Math.max(1, primaryQueryCount)));
  let remainingFallbackQueries = fallbackQueryCount;
  const serpApiConfigured = Boolean(process.env.SERPAPI_KEY);
  const serpTimeFilter = computeSerpTimeFilter(from, to);
  const keywordHeadlineResults = new Map<string, KeywordAggregation>();
  const keywordOrder: string[] = [];

  const ensureKeywordEntry = (keyword: string, queryValue: string) => {
    let existing = keywordHeadlineResults.get(keyword);
    if (!existing) {
      existing = { query: queryValue, candidates: [] };
      keywordHeadlineResults.set(keyword, existing);
      keywordOrder.push(keyword);
    }
    return existing;
  };

  if (rssFeeds.length > 0) {
    const xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
    });

    const rssPerFeedQuota = Math.max(1, Math.min(3, Math.ceil(perQuery / 2)));
    const rssTotalQuota = Math.max(rssFeeds.length, rssPerFeedQuota * rssFeeds.length);
    let rssAdded = 0;

    for (const feedUrl of rssFeeds) {
      if (rssAdded >= rssTotalQuota) {
        break;
      }

      let queryLabel = `RSS: ${feedUrl}`;
      let addedFromFeed = 0;
      let feedQuotaRemaining = rssPerFeedQuota;

      try {
        let response: Response;
        const { signal, cleanup } = createAbortSignalWithTimeout(rssTimeoutMs);
        try {
          if (signal) {
            response = await requester(feedUrl, { signal });
          } else {
            response = await requester(feedUrl);
          }
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            queryWarnings.push(`RSS feed request timed out for ${feedUrl}`);
            queriesAttempted.push(queryLabel);
            continue;
          }
          throw error;
        } finally {
          cleanup();
        }
        if (!response.ok) {
          queryWarnings.push(
            `RSS feed request failed (${response.status}) for ${feedUrl}`
          );
          queriesAttempted.push(queryLabel);
          continue;
        }

        const bodyText = await response.text();
        if (!bodyText.trim()) {
          queryWarnings.push(`RSS feed returned empty response for ${feedUrl}`);
          queriesAttempted.push(queryLabel);
          continue;
        }

        let parsedFeed: unknown;
        try {
          parsedFeed = xmlParser.parse(bodyText);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Unable to parse RSS XML';
          queryWarnings.push(`RSS feed parse error (${feedUrl}): ${message}`);
          queriesAttempted.push(queryLabel);
          continue;
        }

        const { feedTitle, items } = extractRssFeedPayload(parsedFeed);
        if (feedTitle) {
          queryLabel = `RSS: ${feedTitle}`;
        }

        const headlines = mapRssItemsToHeadlines(
          items,
          feedTitle,
          feedUrl,
          queryLabel,
          fromTimestamp,
          toTimestamp
        );

        for (const headline of headlines) {
          if (rssAdded >= rssTotalQuota || feedQuotaRemaining <= 0) {
            break;
          }

          if (addHeadlineIfUnique(aggregatedHeadlines, headline, dedupeOptions)) {
            addedFromFeed += 1;
            rssAdded += 1;
            feedQuotaRemaining -= 1;
          }
        }

        if (addedFromFeed > 0) {
          successfulQueries += 1;
        } else {
          queryWarnings.push(`No headlines found for RSS feed: ${feedUrl}`);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown RSS error';
        queryWarnings.push(`RSS feed error (${feedUrl}): ${message}`);
      }

      queriesAttempted.push(queryLabel);
    }
  }

  for (const searchEntry of searchQueries) {
    if (aggregatedHeadlines.length >= limit) {
      break;
    }

    const search = searchEntry.query;

    if (searchEntry.fallback && aggregatedHeadlines.length >= limit) {
      continue;
    }

    queriesAttempted.push(search);
    let page = 1;
    let querySucceeded = false;
    let addedByQuery = 0;

    let maxForQuery = perQuery;

    if (searchEntry.fallback) {
      const remainingCapacity = Math.max(0, limit - aggregatedHeadlines.length);
      if (remainingCapacity <= 0) {
        continue;
      }

      const rawQuota =
        remainingFallbackQueries > 0
          ? Math.ceil(remainingCapacity / remainingFallbackQueries)
          : remainingCapacity;
      const fallbackQuota = Math.max(
        1,
        Math.min(rawQuota, remainingCapacity)
      );

      maxForQuery = fallbackQuota;
    }

    while (addedByQuery < maxForQuery && aggregatedHeadlines.length < limit) {
      const globalRemaining = Math.max(0, limit - aggregatedHeadlines.length);
      const perQueryRemaining = maxForQuery - addedByQuery;
      const queryRemaining = Math.min(globalRemaining, perQueryRemaining);
      if (queryRemaining <= 0) {
        break;
      }

      const pageSize = Math.max(1, queryRemaining);
      const requestUrl = buildUrl(search, pageSize, page);

      let response: Response;
      try {
        response = await requester(requestUrl, {
          method: 'GET',
          headers: {
            'X-Api-Key': apiKey,
          },
        });
      } catch (error) {
        log.error('[api/headlines] request failed', error);
        queryWarnings.push(`Failed to reach NewsAPI for query: ${search}`);
        break;
      }

      let data: any = null;
      try {
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          data = await response.json();
        } else {
          const text = await response.text();
          data = text ? { message: text } : null;
        }
      } catch (error) {
        log.error('[api/headlines] failed to parse response', error);
        if (!response.ok) {
          queryWarnings.push(
            `NewsAPI request failed for query: ${search} (status ${response.status || 502})`
          );
          break;
        }
        queryWarnings.push(`Invalid response from NewsAPI for query: ${search}`);
        break;
      }

      if (!response.ok) {
        const message =
          (data && typeof data.message === 'string' && data.message) ||
          'NewsAPI request failed';
        queryWarnings.push(`NewsAPI error for query "${search}": ${message}`);
        break;
      }

      if (!data || data.status !== 'ok' || !Array.isArray(data.articles)) {
        queryWarnings.push(`Unexpected response from NewsAPI for query: ${search}`);
        break;
      }

      querySucceeded = true;

      let addedThisPage = 0;

      for (const article of data.articles) {
        const normalized: NormalizedHeadline = {
          title: decodeTextField(article?.title),
          description:
            decodeTextField(article?.description) ||
            decodeTextField(article?.content),
          url: typeof article?.url === 'string' ? article.url.trim() : '',
          source:
            decodeTextField(
              typeof article?.source === 'string'
                ? article.source
                : article?.source?.name
            ),
          publishedAt:
            decodeTextField(article?.publishedAt) ||
            decodeTextField(article?.published_at),
          queryUsed: search,
          searchQuery: search,
          ...(searchEntry.type === 'keyword' && searchEntry.keyword
            ? { keyword: searchEntry.keyword }
            : {}),
        };

        if (!normalized.title || !normalized.url) {
          continue;
        }

        const keywordFilterValue =
          searchEntry.type === 'keyword' && searchEntry.keyword
            ? searchEntry.keyword.trim()
            : '';

        if (
          keywordFilterValue &&
          !headlineMatchesKeyword(keywordFilterValue, normalized)
        ) {
          continue;
        }

        if (addHeadlineIfUnique(aggregatedHeadlines, normalized, dedupeOptions)) {
          addedByQuery += 1;
          addedThisPage += 1;

          if (addedByQuery >= maxForQuery || aggregatedHeadlines.length >= limit) {
            break;
          }
        }

        if (searchEntry.type === 'keyword' && searchEntry.keyword) {
          const keywordEntry = ensureKeywordEntry(searchEntry.keyword, search);
          addHeadlineIfUnique(keywordEntry.candidates, normalized, dedupeOptions);
        }
      }

      if (addedByQuery >= maxForQuery || aggregatedHeadlines.length >= limit) {
        break;
      }

      const receivedCount = Array.isArray(data.articles)
        ? data.articles.length
        : 0;

      if (addedThisPage === 0 || receivedCount < pageSize) {
        break;
      }

      page += 1;
    }

    if (searchEntry.fallback) {
      remainingFallbackQueries = Math.max(0, remainingFallbackQueries - 1);
    }

    if (
      serpApiConfigured &&
      addedByQuery < maxForQuery &&
      aggregatedHeadlines.length < limit
    ) {
      const baseParams: Record<string, string> = {
        tbs: serpTimeFilter,
      };

      if (language && language !== null) {
        baseParams.hl = language;
      }

      if (country) {
        baseParams.gl = country;
      }

      const serpQueryRemaining = Math.max(
        1,
        Math.min(maxForQuery - addedByQuery, limit - aggregatedHeadlines.length)
      );
      const serpEngines: Array<{
        engine: string;
        limit: number;
        params: Record<string, string>;
      }> = [
        {
          engine: 'google_news',
          limit: Math.max(6, serpQueryRemaining * 2),
          params: {
            ...baseParams,
            num: String(Math.max(6, serpQueryRemaining * 2)),
          },
        },
      ];

      if (addedByQuery < maxForQuery) {
        serpEngines.push({
          engine: 'google',
          limit: Math.max(5, serpQueryRemaining),
          params: {
            ...baseParams,
            num: String(Math.max(5, serpQueryRemaining)),
          },
        });
      }

      for (const { engine, limit: serpLimit, params } of serpEngines) {
        if (addedByQuery >= maxForQuery || aggregatedHeadlines.length >= limit) {
          break;
        }

        const serpResults = await serpapiSearch({
          query: search,
          engine,
          extraParams: params,
          limit: serpLimit,
        });

        for (const result of serpResults) {
          if (addedByQuery >= maxForQuery || aggregatedHeadlines.length >= limit) {
            break;
          }

          const normalized = normalizeSerpResult(result);
          if (!normalized) {
            continue;
          }

          normalized.queryUsed = search;
          normalized.searchQuery = search;
          if (searchEntry.type === 'keyword' && searchEntry.keyword) {
            normalized.keyword = searchEntry.keyword;
          }

          const keywordFilterValue =
            searchEntry.type === 'keyword' && searchEntry.keyword
              ? searchEntry.keyword.trim()
              : '';

          if (
            keywordFilterValue &&
            !headlineMatchesKeyword(keywordFilterValue, normalized)
          ) {
            continue;
          }

          if (addHeadlineIfUnique(aggregatedHeadlines, normalized, dedupeOptions)) {
            addedByQuery += 1;
          }

          if (searchEntry.type === 'keyword' && searchEntry.keyword) {
            const keywordEntry = ensureKeywordEntry(searchEntry.keyword, search);
            addHeadlineIfUnique(keywordEntry.candidates, normalized, dedupeOptions);
          }
        }
      }
    }

    if (querySucceeded) {
      successfulQueries += 1;
    }
  }

  if (successfulQueries === 0 && aggregatedHeadlines.length === 0) {
    const message =
      queryWarnings[0] || 'NewsAPI request failed for all generated queries';
    const errorPayload: Record<string, unknown> = {
      error: message,
      queryErrors: queryWarnings,
      queriesAttempted,
    };

    if (inferredKeywords) {
      errorPayload.inferredKeywords = inferredKeywords;
    }

    return NextResponse.json(errorPayload, { status: 502 });
  }

  const keywordGroups = keywordOrder
    .map((keyword) => {
      const aggregation = keywordHeadlineResults.get(keyword);
      if (!aggregation || aggregation.candidates.length === 0) {
        return null;
      }

      const rankedGroup = rankHeadlineCandidates(aggregation.candidates);
      if (rankedGroup.length === 0) {
        return null;
      }

      const groupLimit = Math.max(
        1,
        Math.min(perQuery, limit, rankedGroup.length)
      );
      const headlines = buildHeadlineResponses(
        rankedGroup.slice(0, groupLimit)
      );

      if (headlines.length === 0) {
        return null;
      }

      return {
        keyword,
        query: aggregation.query,
        totalResults: aggregation.candidates.length,
        headlines,
      };
    })
    .filter(
      (group): group is {
        keyword: string;
        query: string;
        totalResults: number;
        headlines: HeadlineResponseEntry[];
      } => Boolean(group)
    );

  const rankedCandidates = rankHeadlineCandidates(aggregatedHeadlines);
  const topRanked = rankedCandidates.slice(0, limit);
  const headlineEntries = buildHeadlineResponses(topRanked);

  const payload: Record<string, unknown> = {
    headlines: headlineEntries,
    totalResults: aggregatedHeadlines.length,
    queriesAttempted,
    successfulQueries,
  };

  if (rankedCandidates.length > 0) {
    payload.ranking = {
      totalRanked: rankedCandidates.length,
      weights: {
        recency: RANKING_RECENCY_WEIGHT,
        sourceDiversity: RANKING_SOURCE_WEIGHT,
        topicCoverage: RANKING_TOPIC_WEIGHT,
        clusterSupport: RANKING_CLUSTER_WEIGHT,
      },
      explanations: {
        clusterSupport:
          'Boosts headlines that are supported by multiple related articles and unique sources.',
      },
    };
  }

  if (inferredKeywords) {
    payload.inferredKeywords = inferredKeywords;
  }

  if (queryWarnings.length > 0) {
    payload.warnings = queryWarnings;
  }

  if (keywordGroups.length > 0) {
    payload.keywordHeadlines = keywordGroups;
  }

  return NextResponse.json(payload);
  };
}

export const POST = createHeadlinesHandler();
