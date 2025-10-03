// page.tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../../lib/supabase';
import clsx from 'clsx';
import { DEFAULT_WORDS, WORD_RANGES } from '../../constants/lengthOptions';
import { buildHeadlineRequest } from './headlineFormHelpers';
import {
  formatHeadlinesForClipboard,
  HEADLINE_CLIPBOARD_HEADERS,
  type HeadlineClipboardColumn,
  type HeadlineClipboardFormat,
} from './headlineClipboardHelpers';
import { HEADLINE_SITES, type HeadlineSiteKey } from '../../constants/headlineSites';
import type {
  HeadlineItem,
  RelatedArticle,
} from './types';

const SORT_BY_OPTIONS = [
  { value: 'publishedAt' as const, label: 'Newest first' },
  { value: 'relevancy' as const, label: 'Most relevant' },
  { value: 'popularity' as const, label: 'Most popular' },
];

const DEFAULT_HEADLINE_LIMIT = 100;
const HEADLINE_LANGUAGE = 'en';

const NO_RECENT_NEWS_MESSAGE =
  'No recent news on this topic. Adjust your topic, keywords, or timeframe to broaden the search for relevant reporting.';

const HEADLINE_COPY_COLUMN_OPTIONS: {
  value: HeadlineClipboardColumn;
  label: string;
}[] = [
  { value: 'all', label: 'All columns' },
  { value: 'title', label: HEADLINE_CLIPBOARD_HEADERS.title },
  {
    value: 'sourcePublished',
    label: HEADLINE_CLIPBOARD_HEADERS.sourcePublished,
  },
  { value: 'url', label: HEADLINE_CLIPBOARD_HEADERS.url },
];

const HEADLINE_COPY_FORMAT_LABELS: Record<HeadlineClipboardFormat, string> = {
  csv: 'CSV',
  tsv: 'tab-separated text',
};

const DEFAULT_FETCH_ERROR_MESSAGE = 'Failed to fetch headlines.';

const HEADLINE_SEEN_STORAGE_KEY = 'headlineSeenUrls';
const DEFAULT_HEADLINE_SEEN_KEY = '__default__';
const MAX_TRACKED_SEEN_PER_KEY = 400;
const MAX_EXCLUDE_URLS = 200;

const TRENDING_CLUSTER_SUPPORT_THRESHOLD = 0.35;
const TRENDING_CLUSTER_SIZE_THRESHOLD = 3;

type SeenHeadlineMetadata = {
  firstSeenAt: number;
  lastSeenAt: number;
  publishedAt?: string;
};

type SeenHeadlineCollection = Record<string, Record<string, SeenHeadlineMetadata>>;

const normalizeHeadlineUrlForTracking = (url?: string | null): string | null => {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    const normalizedPath = parsed.pathname.replace(/\/+$/g, '');
    const normalized = `${parsed.protocol}//${parsed.hostname}${normalizedPath}`
      .replace(/\/+$/g, '')
      .toLowerCase();
    return normalized || null;
  } catch {
    const trimmed = url.trim().replace(/\/+$/g, '').toLowerCase();
    return trimmed || null;
  }
};

const loadSeenHeadlineCollection = (): SeenHeadlineCollection => {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(HEADLINE_SEEN_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }

    const sanitized: SeenHeadlineCollection = {};

    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof key !== 'string' || !value || typeof value !== 'object') {
        continue;
      }

      const entryMap: Record<string, SeenHeadlineMetadata> = {};

      for (const [rawUrl, meta] of Object.entries(value as Record<string, unknown>)) {
        if (!rawUrl || typeof rawUrl !== 'string' || !meta || typeof meta !== 'object') {
          continue;
        }

        const normalizedUrl = normalizeHeadlineUrlForTracking(rawUrl);
        if (!normalizedUrl) {
          continue;
        }

        const typedMeta = meta as Partial<SeenHeadlineMetadata>;
        const firstSeenAt = Number.isFinite(typedMeta.firstSeenAt)
          ? Number(typedMeta.firstSeenAt)
          : Date.now();
        const lastSeenAt = Number.isFinite(typedMeta.lastSeenAt)
          ? Number(typedMeta.lastSeenAt)
          : firstSeenAt;
        const publishedAt =
          typeof typedMeta.publishedAt === 'string' && typedMeta.publishedAt.trim()
            ? typedMeta.publishedAt
            : undefined;

        entryMap[normalizedUrl] = {
          firstSeenAt,
          lastSeenAt,
          ...(publishedAt ? { publishedAt } : {}),
        };
      }

      if (Object.keys(entryMap).length > 0) {
        sanitized[key] = entryMap;
      }
    }

    return sanitized;
  } catch {
    return {};
  }
};

const persistSeenHeadlineCollection = (collection: SeenHeadlineCollection) => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(
      HEADLINE_SEEN_STORAGE_KEY,
      JSON.stringify(collection)
    );
  } catch {
    // Ignore persistence errors (e.g., storage quota exceeded).
  }
};

const resolveSeenHeadlineKey = (presetKey: HeadlineSiteKey | null | undefined) =>
  presetKey ? `preset:${presetKey}` : DEFAULT_HEADLINE_SEEN_KEY;

const collectExcludeUrls = (
  collection: SeenHeadlineCollection,
  storageKey: string
): string[] => {
  const entries = Object.entries(collection[storageKey] ?? {});
  if (entries.length === 0) {
    return [];
  }

  return entries
    .sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt)
    .slice(0, MAX_EXCLUDE_URLS)
    .map(([url]) => url);
};

const upsertSeenHeadlines = (
  collectionRef: MutableRefObject<SeenHeadlineCollection>,
  storageKey: string,
  headlines: HeadlineItem[]
) => {
  if (headlines.length === 0) {
    return;
  }

  const currentCollection = collectionRef.current;
  const existing = currentCollection[storageKey]
    ? { ...currentCollection[storageKey] }
    : {};

  let changed = false;
  const now = Date.now();

  for (const headline of headlines) {
    const normalizedUrl = normalizeHeadlineUrlForTracking(headline.url);
    if (!normalizedUrl) {
      continue;
    }

    const publishedAt =
      typeof headline.publishedAt === 'string' && headline.publishedAt.trim()
        ? headline.publishedAt
        : undefined;

    const previous = existing[normalizedUrl];
    if (previous) {
      const nextPublishedAt = publishedAt ?? previous.publishedAt;
      if (previous.lastSeenAt !== now || previous.publishedAt !== nextPublishedAt) {
        existing[normalizedUrl] = {
          firstSeenAt: previous.firstSeenAt,
          lastSeenAt: now,
          ...(nextPublishedAt ? { publishedAt: nextPublishedAt } : {}),
        };
        changed = true;
      }
      continue;
    }

    existing[normalizedUrl] = {
      firstSeenAt: now,
      lastSeenAt: now,
      ...(publishedAt ? { publishedAt } : {}),
    };
    changed = true;
  }

  if (!changed) {
    return;
  }

  const trimmedEntries = Object.entries(existing)
    .sort((a, b) => a[1].firstSeenAt - b[1].firstSeenAt)
    .slice(-MAX_TRACKED_SEEN_PER_KEY);

  const nextMap = Object.fromEntries(trimmedEntries);
  currentCollection[storageKey] = nextMap;
  collectionRef.current = { ...currentCollection };
  persistSeenHeadlineCollection(collectionRef.current);
};

type HeadlineFetchErrorInput = {
  data: any;
  fallbackText: string | null;
  response: Response;
};

const sanitizeFallbackText = (text: string | null): string | null => {
  if (!text) {
    return null;
  }

  const stripped = text.replace(/<[^>]*>/g, ' ');
  const collapsed = stripped.replace(/\s+/g, ' ').trim();

  if (!collapsed) {
    return null;
  }

  const hasPlainText =
    /[A-Za-z0-9]/.test(collapsed) ||
    Array.from(collapsed).some((char) => char.charCodeAt(0) > 127);

  if (!hasPlainText) {
    return null;
  }

  const MAX_LENGTH = 200;
  if (collapsed.length > MAX_LENGTH) {
    return `${collapsed.slice(0, MAX_LENGTH - 1).trimEnd()}…`;
  }

  return collapsed;
};

const deriveHeadlineFetchErrorMessage = ({
  data,
  fallbackText,
  response,
}: HeadlineFetchErrorInput): string => {
  const dataMessage =
    typeof data?.error === 'string'
      ? data.error.trim()
      : typeof data?.message === 'string'
      ? data.message.trim()
      : null;

  if (dataMessage) {
    return dataMessage;
  }

  const sanitizedFallback = sanitizeFallbackText(fallbackText);
  if (sanitizedFallback) {
    return sanitizedFallback;
  }

  const statusText = response?.statusText?.trim();
  if (statusText) {
    return statusText;
  }

  return DEFAULT_FETCH_ERROR_MESSAGE;
};

export default function GeneratePage() {
  const router = useRouter();
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [activeTab, setActiveTab] = useState<'writing' | 'headlines'>('writing');
  const [headlinesUnlocked, setHeadlinesUnlocked] = useState(false);

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') as 'light' | 'dark' | null;
    const defaultTheme = savedTheme || 'light';
    setTheme(defaultTheme);
    document.documentElement.classList.toggle('dark', defaultTheme === 'dark');
  }, []);

  

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    document.documentElement.classList.toggle('dark', newTheme === 'dark');
    localStorage.setItem('theme', newTheme);
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.push('/auth');
  };

  const [title, setTitle] = useState('');
  const [articleType, setArticleType] = useState<
    | 'Blog post'
    | 'Listicle/Gallery'
    | 'Recipe article'
    | 'News article'
  >('Blog post');

  // for blog posts
  const [lengthOption, setLengthOption] = useState<
    | 'default'
    | 'custom'
    | 'shorter'
    | 'short'
    | 'medium'
    | 'longForm'
    | 'longer'
  >('default');
  const [customSections, setCustomSections] = useState<number>(5);

  const [customInstructions, setCustomInstructions] = useState('');
  const [loading, setLoading] = useState(false);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [headlineLoading, setHeadlineLoading] = useState(false);
  const [headlineError, setHeadlineError] = useState<string | null>(null);
  const [headlineResults, setHeadlineResults] = useState<HeadlineItem[]>([]);
  const [headlineQueries, setHeadlineQueries] = useState<string[]>([]);
  const [headlineDescription, setHeadlineDescription] = useState('');
  const [activeSiteKey, setActiveSiteKey] = useState<HeadlineSiteKey | null>(
    null
  );
  const [activeSiteRssFeeds, setActiveSiteRssFeeds] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState<'publishedAt' | 'relevancy' | 'popularity'>(
    'popularity'
  );
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const searchIn: string[] = [];
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [selectedCopyColumn, setSelectedCopyColumn] =
    useState<HeadlineClipboardColumn>('all');
  const [copyFeedback, setCopyFeedback] = useState<
    | {
        type: 'success' | 'error';
        message: string;
      }
    | null
  >(null);
  const seenHeadlinesRef = useRef<SeenHeadlineCollection>({});

  useEffect(() => {
    setCopyFeedback(null);
  }, [headlineResults]);

  useEffect(() => {
    seenHeadlinesRef.current = loadSeenHeadlineCollection();
  }, []);

  const handleCopyHeadlines = async (format: HeadlineClipboardFormat) => {
    setCopyFeedback(null);

    const clipboardText = formatHeadlinesForClipboard(headlineResults, {
      column: selectedCopyColumn,
      format,
    });

    if (!clipboardText) {
      setCopyFeedback({
        type: 'error',
        message: 'No headline data available to copy.',
      });
      return;
    }

    if (
      typeof navigator === 'undefined' ||
      !navigator.clipboard ||
      typeof navigator.clipboard.writeText !== 'function'
    ) {
      setCopyFeedback({
        type: 'error',
        message: 'Clipboard copying is not supported in this browser.',
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(clipboardText);
      const selectionLabel =
        selectedCopyColumn === 'all'
          ? 'all columns'
          : HEADLINE_CLIPBOARD_HEADERS[selectedCopyColumn];
      const formatLabel = HEADLINE_COPY_FORMAT_LABELS[format];
      setCopyFeedback({
        type: 'success',
        message: `Copied ${selectionLabel} as ${formatLabel}.`,
      });
    } catch (error) {
      setCopyFeedback({
        type: 'error',
        message: 'Failed to copy to clipboard. Try again.',
      });
    }
  };

  const handleRemoveHeadline = (headline: HeadlineItem, index: number) => {
    setHeadlineResults((previous) =>
      previous.filter((item, itemIndex) =>
        headline.url
          ? item.url !== headline.url
          : itemIndex !== index
      )
    );
  };

  const formatPublishedDate = (value?: string) => {
    if (!value) {
      return null;
    }

    const parsedDate = new Date(value);
    if (!Number.isNaN(parsedDate.getTime())) {
      return parsedDate.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
    }

    return value;
  };

  const siteEntries = Object.entries(HEADLINE_SITES) as Array<
    [HeadlineSiteKey, (typeof HEADLINE_SITES)[HeadlineSiteKey]]
  >;

  // Tone of Voice
  const [toneOfVoice, setToneOfVoice] = useState<
    | 'SEO Optimized (Confident, Knowledgeable, Neutral, and Clear)'
    | 'Excited'
    | 'Professional'
    | 'Friendly'
    | 'Formal'
    | 'Casual'
    | 'Humorous'
    | 'Custom'
  >('SEO Optimized (Confident, Knowledgeable, Neutral, and Clear)');
  const [customTone, setCustomTone] = useState<string>('');

  // Point of View
  const [pointOfView, setPointOfView] = useState<
    | 'First Person Singular'
    | 'First Person Plural'
    | 'Second Person'
    | 'Third Person'
  >('First Person Singular');

  // Listicle/Recipe fields
  const [numberingFormat, setNumberingFormat] = useState<
    | '1), 2), 3)'
    | '1., 2., 3.'
    | '1:, 2:, 3:'
    | 'None'
  >('1), 2), 3)');
  const [itemWordCount, setItemWordCount] = useState<number>(100);
  const [recipeItemCount, setRecipeItemCount] = useState<number>(5);
  
  // Recipe query field
  const [recipeQuery, setRecipeQuery] = useState<string>('');

  // ─── NEW: MODEL VERSION ───────────────────────────────────────────────────────
  const models = ['gpt-4', 'gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo'];
  const [modelVersion, setModelVersion] = useState<string>(models[0]);
  const [useSerpApi, setUseSerpApi] = useState<boolean>(true);
  const [includeLinks, setIncludeLinks] = useState<boolean>(true);

  useEffect(() => {
    if (activeTab !== 'headlines') {
      setHeadlineLoading(false);
      setHeadlineError(null);
    }
  }, [activeTab]);

  const handleHeadlinesTabClick = () => {
    if (headlinesUnlocked) {
      setActiveTab('headlines');
      return;
    }

    if (typeof window === 'undefined') {
      return;
    }

    const input = window.prompt('Enter password');

    if (input !== '12345') {
      if (input !== null) {
        window.alert('Incorrect password');
      }
      return;
    }

    setHeadlinesUnlocked(true);
    setActiveTab('headlines');
  };

  const handleClearSitePreset = () => {
    setActiveSiteKey(null);
    setActiveSiteRssFeeds([]);
    setHeadlineDescription('');
    setKeywords([]);
    setFromDate('');
    setToDate('');
  };

  const handleGenerateSiteHeadlines = async (siteKey: HeadlineSiteKey) => {
    const preset = HEADLINE_SITES[siteKey];
    if (!preset) {
      return;
    }

    setActiveSiteKey(siteKey);
    setFromDate('');
    setToDate('');
    const presetKeywords =
      'keywords' in preset && Array.isArray(preset.keywords)
        ? [...preset.keywords]
        : [];
    const presetRssFeeds =
      'rssFeeds' in preset && Array.isArray(preset.rssFeeds)
        ? [...preset.rssFeeds]
        : [];
    const hasPresetFilters =
      presetKeywords.length > 0 || presetRssFeeds.length > 0;
    const presetDescription = hasPresetFilters
      ? ''
      : `Top headlines for ${preset.name}`;
    setKeywords(presetKeywords);
    setActiveSiteRssFeeds(presetRssFeeds);

    let dateOverrides: { fromDate?: string; toDate?: string } = {
      fromDate: '',
      toDate: '',
    };

    if (siteKey === 'oregonAdventure') {
      const now = new Date();
      const todayUtc = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
      );
      const fiveYearsAgoUtc = new Date(todayUtc);
      fiveYearsAgoUtc.setUTCFullYear(todayUtc.getUTCFullYear() - 5);

      const nextFromDate = fiveYearsAgoUtc.toISOString().slice(0, 10);
      const nextToDate = todayUtc.toISOString().slice(0, 10);

      setFromDate(nextFromDate);
      setToDate(nextToDate);
      dateOverrides = {
        fromDate: nextFromDate,
        toDate: nextToDate,
      };
    }

    await handleFetchHeadlines({
      description: presetDescription,
      keywords: presetKeywords,
      rssFeeds: presetRssFeeds,
      presetKey: siteKey,
      ...dateOverrides,
    });
  };

  const handleGenerate = async () => {
    if (!title.trim()) {
      alert('Enter a title first');
      return;
    }
    if (articleType === 'Blog post' && lengthOption === 'custom' && customSections < 1) {
      alert('Enter a valid number of sections');
      return;
    }
    if (articleType === 'Recipe article' && recipeItemCount < 1) {
      alert('Enter a valid number of recipes');
      return;
    }
    if (articleType === 'Recipe article' && !recipeQuery.trim()) {
      alert('Enter a recipe query (e.g., "5 italian pasta dishes")');
      return;
    }

    setLoading(true);
    setGenerateError(null);
    try {
      const instructions = customInstructions.trim();

      const payload: any = {
        title,
        articleType,
        ...(instructions && { customInstructions: instructions }),
        toneOfVoice,
        ...(toneOfVoice === 'Custom' && { customTone }),
        pointOfView,
        modelVersion,
        useSerpApi,
        includeLinks,
      };

      if (articleType === 'Listicle/Gallery') {
        payload.listNumberingFormat = numberingFormat;
        payload.listItemWordCount = itemWordCount;
      } else if (articleType === 'Recipe article') {
        payload.numberingFormat = numberingFormat;
        payload.wordsPerItem = itemWordCount;
        payload.itemCount = recipeItemCount;
      } else {
        payload.lengthOption = lengthOption;
        payload.customSections =
          lengthOption === 'custom' ? customSections : undefined;
      }

      // Save payload for future regeneration
      try {
        localStorage.setItem('lastPrompt', JSON.stringify(payload));
      } catch {}

      let url, requestBody;
      
      if (articleType === 'Recipe article') {
        // Use recipe generation endpoint
        url = '/api/recipe-generate';
        requestBody = { query: recipeQuery };
      } else {
        // Use regular generation endpoint
        url = '/api/generate';
        requestBody = payload;
      }
      
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      const contentType = res.headers.get('content-type') ?? '';

      const defaultFriendlyMessage =
        'The article generator timed out—please try again.';

      if (!res.ok) {
        let message = res.statusText || `Request failed with status ${res.status}`;
        let errorCode: string | null = null;

        if (contentType.includes('application/json')) {
          try {
            const errorBody = await res.clone().json();
            errorCode = typeof errorBody?.code === 'string' ? errorBody.code : null;
            message =
              errorBody?.error ||
              errorBody?.airtableError ||
              message;

            if (errorCode === 'NO_RECENT_SOURCES') {
              const inlineMessage =
                errorBody?.suggestion ||
                errorBody?.error ||
                NO_RECENT_NEWS_MESSAGE;
              alert(inlineMessage);
              setGenerateError(null);
              return;
            }
          } catch {
            try {
              const fallbackText = await res.text();
              if (fallbackText) {
                console.error('[generate] non-ok JSON response body:', fallbackText);

                const normalized = fallbackText
                  .replace(/<[^>]+>/g, ' ')
                  .replace(/\s+/g, ' ')
                  .trim();
                const looksHtml = /<html/i.test(fallbackText) || /<body/i.test(fallbackText);
                const isVerbose = normalized.length > 200;

                message =
                  !looksHtml && !isVerbose && normalized
                    ? normalized
                    : defaultFriendlyMessage;
              } else {
                message = defaultFriendlyMessage;
              }
            } catch {}
          }
        } else {
          try {
            const fallbackText = await res.text();
            if (fallbackText) {
              const normalized = fallbackText
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
              const looksHtml = /<html/i.test(fallbackText) || /<body/i.test(fallbackText);
              const isVerbose = normalized.length > 200;

              console.error('[generate] non-ok response body:', fallbackText);

              message =
                !looksHtml && !isVerbose && normalized
                  ? normalized
                  : defaultFriendlyMessage;
            } else {
              message = defaultFriendlyMessage;
            }
          } catch {}
        }

        const friendlyMessage =
          message ||
          NO_RECENT_NEWS_MESSAGE;

        alert(`Failed to generate article: ${friendlyMessage}`);
        return;
      }

      if (!contentType.includes('application/json')) {
        let fallbackText: string | null = null;
        try {
          fallbackText = await res.text();
        } catch {}

        const friendlyMessage =
          (() => {
            if (!fallbackText) {
              return defaultFriendlyMessage;
            }

            console.error('[generate] unexpected content-type body:', fallbackText);

            const normalized = fallbackText
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();
            const looksHtml = /<html/i.test(fallbackText) || /<body/i.test(fallbackText);
            const isVerbose = normalized.length > 200;

            if (!looksHtml && !isVerbose && normalized) {
              return normalized;
            }

            return defaultFriendlyMessage;
          })() ||
          'Received an unexpected response format while generating the article.';

        alert(`Failed to generate article: ${friendlyMessage}`);
        return;
      }

      const data = await res.json();

      if (!data.content) {
        if (data?.code === 'NO_RECENT_SOURCES') {
          const inlineMessage =
            data?.suggestion ||
            data?.error ||
            NO_RECENT_NEWS_MESSAGE;
          alert(inlineMessage);
          setGenerateError(null);
          return;
        }

        const friendlyMessage =
          data.error ||
          data.airtableError ||
          NO_RECENT_NEWS_MESSAGE;
        alert(`Failed to generate article: ${friendlyMessage}`);
        return;
      }

      try {
        localStorage.setItem('lastArticleContent', data.content);
        localStorage.setItem(
          'lastArticleSources',
          JSON.stringify(data.sources || [])
        );
      } catch {}

      router.push(`/editor?title=${encodeURIComponent(title)}`);
      setGenerateError(null);
    } catch (err) {
      console.error('[generate] fetch error:', err);
      alert('Error generating article — check console');
    } finally {
      setLoading(false);
    }
  };

  const handleFetchHeadlines = async (
    overrides?: {
      description?: string;
      keywords?: string[];
      rssFeeds?: string[];
      presetKey?: HeadlineSiteKey | null;
      fromDate?: string;
      toDate?: string;
    }
  ) => {
    const nextDescriptionRaw =
      overrides && overrides.description !== undefined
        ? overrides.description
        : headlineDescription;
    const nextDescription = nextDescriptionRaw.trim();
    const nextKeywords = overrides?.keywords ?? keywords;
    const nextRssFeeds = overrides?.rssFeeds ?? activeSiteRssFeeds;
    const nextFromDate =
      overrides && overrides.fromDate !== undefined
        ? overrides.fromDate
        : fromDate;
    const nextToDate =
      overrides && overrides.toDate !== undefined ? overrides.toDate : toDate;

    if (nextDescription !== headlineDescription) {
      setHeadlineDescription(nextDescription);
    }

    if (overrides?.keywords) {
      setKeywords(overrides.keywords);
    }

    if (overrides?.rssFeeds) {
      setActiveSiteRssFeeds(overrides.rssFeeds);
    }

    if (overrides?.fromDate !== undefined) {
      setFromDate(overrides.fromDate);
    }

    if (overrides?.toDate !== undefined) {
      setToDate(overrides.toDate);
    }

    const targetPresetKey = overrides?.presetKey ?? activeSiteKey;
    const storageKey = resolveSeenHeadlineKey(targetPresetKey);
    const excludeUrls = collectExcludeUrls(seenHeadlinesRef.current, storageKey);

    const buildResult = buildHeadlineRequest({
      keywords: nextKeywords,
      profileQuery: '',
      profileLanguage: null,
      limit: DEFAULT_HEADLINE_LIMIT,
      sortBy,
      language: HEADLINE_LANGUAGE,
      fromDate: nextFromDate,
      toDate: nextToDate,
      searchIn,
      description: nextDescription,
      rssFeeds: nextRssFeeds,
      dedupeMode: 'strict',
      excludeUrls,
    });

    setActiveSiteRssFeeds(buildResult.sanitizedRssFeeds);

    if (buildResult.ok === false) {
      setHeadlineError(buildResult.error);
      setHeadlineQueries([]);
      return;
    }

    setHeadlineLoading(true);
    setHeadlineError(null);
    setHeadlineQueries([]);

    try {
      const response = await fetch('/api/headlines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildResult.payload),
      });
      const contentType = response.headers.get('content-type') ?? '';
      let data: any = null;
      let fallbackText: string | null = null;

      if (contentType.includes('application/json')) {
        try {
          data = await response.json();
        } catch (error) {
          fallbackText = await response.text();
        }
      } else {
        fallbackText = await response.text();
      }

      if (!response.ok) {
        const errorMessage = deriveHeadlineFetchErrorMessage({
          data,
          fallbackText,
          response,
        });
        console.error('[headlines] fetch error response', {
          status: response.status,
          statusText: response.statusText,
          fallbackText,
        });
        throw new Error(errorMessage);
      }

      if (!data) {
        const errorMessage = deriveHeadlineFetchErrorMessage({
          data,
          fallbackText,
          response,
        });
        console.error('[headlines] empty response payload', {
          status: response.status,
          statusText: response.statusText,
          fallbackText,
        });
        throw new Error(errorMessage);
      }

      const rawHeadlines = Array.isArray(data?.headlines)
        ? data.headlines
        : Array.isArray(data?.results)
        ? data.results
        : null;

      if (!rawHeadlines) {
        throw new Error('Invalid response from server');
      }

      const normalizedQueries = Array.isArray(data?.queriesAttempted)
        ? (() => {
            const seen = new Set<string>();
            const collected: string[] = [];
            for (const raw of data.queriesAttempted) {
              if (typeof raw !== 'string') {
                continue;
              }
              const trimmed = raw.trim();
              if (!trimmed || seen.has(trimmed)) {
                continue;
              }
              seen.add(trimmed);
              collected.push(trimmed);
            }
            return collected;
          })()
        : [];

      const normalizeHeadline = (item: any): HeadlineItem => {
        const source =
          typeof item?.source === 'string'
            ? item.source
            : item?.source?.name ?? item?.source?.title ?? '';

        const relatedArticles: RelatedArticle[] = Array.isArray(item?.relatedArticles)
          ? item.relatedArticles
              .map((related: any) => {
                const relatedSource =
                  typeof related?.source === 'string'
                    ? related.source
                    : related?.source?.name ?? related?.source?.title ?? '';

                return {
                  title: typeof related?.title === 'string' ? related.title : undefined,
                  description:
                    typeof related?.description === 'string'
                      ? related.description
                      : undefined,
                  url: typeof related?.url === 'string' ? related.url : undefined,
                  source: relatedSource || undefined,
                  publishedAt:
                    typeof related?.publishedAt === 'string'
                      ? related.publishedAt
                      : typeof related?.published_at === 'string'
                      ? related.published_at
                      : undefined,
                };
              })
              .filter((related: RelatedArticle) =>
                Boolean(
                  related.title ||
                    related.description ||
                    related.url ||
                    related.source ||
                    related.publishedAt
                )
              )
          : [];

        const description =
          typeof item?.description === 'string'
            ? item.description
            : typeof item?.snippet === 'string'
            ? item.snippet
            : '';

        const matchedQuery =
          typeof item?.queryUsed === 'string'
            ? item.queryUsed
            : typeof item?.query === 'string'
            ? item.query
            : typeof item?.generatedBy === 'string'
            ? item.generatedBy
            : typeof item?.keyword === 'string'
            ? item.keyword
            : typeof item?.searchQuery === 'string'
            ? item.searchQuery
            : undefined;

        const keywordValue =
          typeof item?.keyword === 'string' ? item.keyword : undefined;
        const queryUsedValue =
          typeof item?.queryUsed === 'string' ? item.queryUsed : undefined;
        const searchQueryValue =
          typeof item?.searchQuery === 'string' ? item.searchQuery : undefined;

        const rankingMetadata = (() => {
          const rawRanking = item?.ranking;
          if (!rawRanking || typeof rawRanking !== 'object') {
            return undefined;
          }

          const score =
            typeof rawRanking.score === 'number' ? rawRanking.score : undefined;
          const rawComponents =
            rawRanking.components && typeof rawRanking.components === 'object'
              ? rawRanking.components
              : undefined;
          const rawDetails =
            rawRanking.details && typeof rawRanking.details === 'object'
              ? rawRanking.details
              : undefined;

          const components = rawComponents
            ? {
                clusterSupport:
                  typeof rawComponents.clusterSupport === 'number'
                    ? rawComponents.clusterSupport
                    : undefined,
              }
            : undefined;

          const details = rawDetails
            ? {
                clusterSize:
                  typeof rawDetails.clusterSize === 'number'
                    ? rawDetails.clusterSize
                    : undefined,
                clusterUniqueSources:
                  typeof rawDetails.clusterUniqueSources === 'number'
                    ? rawDetails.clusterUniqueSources
                    : undefined,
              }
            : undefined;

          if (!score && !components && !details) {
            return undefined;
          }

          return {
            ...(score !== undefined ? { score } : {}),
            ...(components ? { components } : {}),
            ...(details ? { details } : {}),
          };
        })();

        return {
          title: item?.title ?? '',
          source,
          url: item?.url ?? item?.link ?? item?.href ?? '',
          publishedAt: item?.publishedAt ?? item?.published_at ?? '',
          description,
          matchedQuery,
          relatedArticles: relatedArticles.length > 0 ? relatedArticles : undefined,
          keyword: keywordValue,
          queryUsed: queryUsedValue,
          searchQuery: searchQueryValue,
          ranking: rankingMetadata,
        };
      };

      const normalized = rawHeadlines.map((item: any) => normalizeHeadline(item));

      setHeadlineResults(normalized);
      setHeadlineQueries(normalizedQueries);

      if (normalized.length > 0) {
        upsertSeenHeadlines(seenHeadlinesRef, storageKey, normalized);
      }
    } catch (error: any) {
      console.error('[headlines] fetch error:', error);
      setHeadlineError(error?.message || 'Unable to fetch headlines.');
      setHeadlineResults([]);
      setHeadlineQueries([]);
    } finally {
      setHeadlineLoading(false);
    }
  };

  const labelStyle = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';
  const inputStyle =
    'border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-black dark:text-white rounded-md px-3 py-2 w-full focus:outline-none focus:ring-2 focus:ring-blue-500';
  return (
    <div
      className={clsx(
        'min-h-screen transition-colors',
        theme === 'dark' ? 'bg-gray-900 text-white' : 'bg-gray-50 text-black'
      )}
    >
      {/* TOP BAR */}
      <div className="w-full px-6 py-4 flex justify-between items-center bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <h1 className="text-xl font-semibold">Generate New Article</h1>
        <div className="flex space-x-2">
          <button
            onClick={toggleTheme}
            className="text-sm border border-gray-400 dark:border-gray-600 px-3 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            Switch to {theme === 'light' ? 'Dark' : 'Light'} Mode
          </button>
          <button
            onClick={handleSignOut}
            className="bg-red-500 text-white px-4 py-2 rounded"
          >
            Sign Out
          </button>
        </div>
      </div>

      <div className="w-full px-6 py-3 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="flex space-x-2">
          <button
            onClick={() => setActiveTab('writing')}
            className={clsx(
              'px-4 py-2 rounded-md text-sm font-medium transition-colors',
              activeTab === 'writing'
                ? 'bg-blue-600 text-white shadow'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
            )}
          >
            Writing
          </button>
          <button
            onClick={handleHeadlinesTabClick}
            className={clsx(
              'px-4 py-2 rounded-md text-sm font-medium transition-colors',
              activeTab === 'headlines'
                ? 'bg-blue-600 text-white shadow'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
            )}
          >
            Headlines
          </button>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-10">
        {activeTab === 'writing' ? (
          <div className="space-y-6 bg-white dark:bg-gray-800 shadow-md rounded-lg p-6">
          {/* TITLE */}
          <div>
            <label className={labelStyle} htmlFor="generate-title">
              Title
            </label>
            <input
              type="text"
              className={inputStyle}
              placeholder="Enter article title"
              value={title}
              id="generate-title"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          {/* ARTICLE TYPE */}
          <div>
            <label className={labelStyle} htmlFor="generate-article-type">
              Article Type
            </label>
            <select
              className={inputStyle}
              value={articleType}
              id="generate-article-type"
              onChange={(e) => setArticleType(e.target.value as any)}
            >
              <option value="Blog post">Blog post</option>
              <option value="Listicle/Gallery">Listicle/Gallery</option>
              <option value="Recipe article">Recipe article</option>
              <option value="News article">News article</option>
            </select>
          </div>

          {/* CUSTOM INSTRUCTIONS */}
          <div>
            <label className={labelStyle}>Custom Instructions (optional)</label>
            <textarea
              className={inputStyle}
              rows={3}
              placeholder="Any additional guidance for the article"
              value={customInstructions}
              onChange={(e) => setCustomInstructions(e.target.value)}
            />
          </div>

          {/* NUMBERING FORMAT */}
          {(articleType === 'Listicle/Gallery' || articleType === 'Recipe article') && (
            <div>
              <label className={labelStyle}>Numbering Format</label>
              <select
                className={clsx(inputStyle, 'mb-2')}
                value={numberingFormat}
                onChange={(e) => setNumberingFormat(e.target.value as any)}
              >
                <option value="1), 2), 3)">1), 2), 3)</option>
                <option value="1., 2., 3.">1., 2., 3.</option>
                <option value="1:, 2:, 3:">1:, 2:, 3:</option>
                <option value="None">None</option>
              </select>
            </div>
          )}

          {/* MAIN INPUT: scenarios */}
          {articleType === 'Listicle/Gallery' ? (
            <div>
              <div className="mt-2 flex items-center space-x-2">
                <label className={labelStyle + ' mb-0'}>Words per item</label>
                <input
                  type="number"
                  min={1}
                  className={inputStyle + ' w-24'}
                  value={itemWordCount}
                  onChange={(e) => setItemWordCount(Number(e.target.value))}
                />
              </div>
            </div>
          ) : articleType === 'Recipe article' ? (
            <div>
              <div>
                <label className={labelStyle}>Recipe Query</label>
                <input
                  type="text"
                  className={inputStyle}
                  placeholder="e.g., '5 italian pasta dishes' or 'healthy breakfast recipes'"
                  value={recipeQuery}
                  onChange={(e) => setRecipeQuery(e.target.value)}
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  Describe what recipes you want. The system will automatically detect the number and cuisine type.
                </p>
              </div>
              <div className="mt-4 flex items-center space-x-2">
                <label className={labelStyle + ' mb-0'}>Number of recipes</label>
                <input
                  type="number"
                  min={1}
                  className={inputStyle + ' w-24'}
                  value={recipeItemCount}
                  onChange={(e) => setRecipeItemCount(Number(e.target.value))}
                />
              </div>
              <div className="mt-2 flex items-center space-x-2">
                <label className={labelStyle + ' mb-0'}>Words per item</label>
                <input
                  type="number"
                  min={1}
                  className={inputStyle + ' w-24'}
                  value={itemWordCount}
                  onChange={(e) => setItemWordCount(Number(e.target.value))}
                />
              </div>
              </div>
          ) : (
            <div>
              <label className={labelStyle}>Article Length / Sections</label>
              <select
                className={clsx(inputStyle, 'mb-2')}
                value={lengthOption}
                onChange={(e) => setLengthOption(e.target.value as any)}
              >
                <option value="default">
                  Default (AI chooses ~9 sections / ~{DEFAULT_WORDS.toLocaleString()} words)
                </option>
                <option value="custom">Custom Number of Sections</option>
                <option value="shorter">Shorter (2–3 sections, {WORD_RANGES.shorter[0]}–{WORD_RANGES.shorter[1]} words)</option>
                <option value="short">Short (3–5 sections, {WORD_RANGES.short[0]}–{WORD_RANGES.short[1]} words)</option>
                <option value="medium">Medium (5–7 sections, {WORD_RANGES.medium[0]}–{WORD_RANGES.medium[1]} words)</option>
                <option value="longForm">
                  Long Form (7–10 sections, {WORD_RANGES.longForm[0]}–{WORD_RANGES.longForm[1]} words)
                </option>
                <option value="longer">
                  Longer (10–12 sections, {WORD_RANGES.longer[0]}–{WORD_RANGES.longer[1]} words)
                </option>
              </select>
              {lengthOption === 'default' && (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  AI will choose how comprehensive the article should be (~9 sections /
                  {DEFAULT_WORDS.toLocaleString()} words avg).
                </p>
              )}
              {lengthOption === 'custom' && (
                <div className="mt-2">
                  <input
                    type="number"
                    min={1}
                    className={inputStyle + ' w-1/2'}
                    placeholder="Number of sections"
                    value={customSections}
                    onChange={(e) => setCustomSections(Number(e.target.value))}
                  />
                </div>
              )}
            </div>
          )}

          {/* TONE OF VOICE */}
          <div>
            <label className={labelStyle}>Tone of Voice</label>
            <select
              className={clsx(inputStyle, 'mb-2')}
              value={toneOfVoice}
              onChange={(e) => setToneOfVoice(e.target.value as any)}
            >
              <option value="SEO Optimized (Confident, Knowledgeable, Neutral, and Clear)">
                SEO Optimized (Confident, Knowledgeable, Neutral, and Clear)
              </option>
              <option value="Excited">Excited</option>
              <option value="Professional">Professional</option>
              <option value="Friendly">Friendly</option>
              <option value="Formal">Formal</option>
              <option value="Casual">Casual</option>
              <option value="Humorous">Humorous</option>
              <option value="Custom">Custom</option>
            </select>
            {toneOfVoice === 'Custom' && (
              <input
                type="text"
                className={inputStyle + ' mt-2'}
                placeholder="Enter custom tone"
                value={customTone}
                onChange={(e) => setCustomTone(e.target.value)}
              />
            )}
          </div>

          {/* POINT OF VIEW */}
          <div>
            <label className={labelStyle}>Point of View</label>
            <select
              className={clsx(inputStyle, 'mb-2')}
              value={pointOfView}
              onChange={(e) => setPointOfView(e.target.value as any)}
            >
              <option value="First Person Singular">
                First Person Singular (I, me, my, mine)
              </option>
              <option value="First Person Plural">
                First Person Plural (we, us, our, ours)
              </option>
              <option value="Second Person">Second Person (you, your, yours)</option>
              <option value="Third Person">
                Third Person (he, she, it, they)
              </option>
            </select>
          </div>

          {/* USE SERP API */}
          <div className="flex items-center">
          <input id="use-serp-api" type="checkbox" checked={useSerpApi} onChange={(e) => setUseSerpApi(e.target.checked)} className="mr-2 h-4 w-4" />
          <label htmlFor="use-serp-api" className="text-sm font-medium text-gray-700 dark:text-gray-300">Use SERP API for sources</label>
        </div>
        <div className="flex items-center">
          <input
            id="include-links"
            type="checkbox"
            checked={includeLinks}
            onChange={(e) => setIncludeLinks(e.target.checked)}
            className="mr-2 h-4 w-4"
          />
          <label htmlFor="include-links" className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Include links in article
          </label>
        </div>
          {/* ─── MODEL VERSION ─────────────────────────────────────────────────────── */}
          <div>
            <label className={labelStyle}>Model Version</label>
            <div className="flex space-x-2">
              {models.map((m) => (
                <button
                  key={m}
                  onClick={() => setModelVersion(m)}
                  className={clsx(
                    'px-3 py-1 rounded-md border',
                    modelVersion === m
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 border-gray-300 dark:border-gray-600'
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          {/* GENERATE BUTTON */}
          <div className="pt-4">
            <button
              onClick={handleGenerate}
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded shadow"
            >
              {loading ? 'Generating…' : 'Generate & Edit'}
            </button>
            {generateError && (
              <p className="mt-2 text-sm text-red-600 dark:text-red-400">
                {generateError}
              </p>
            )}
          </div>
          </div>
        ) : (
            <div className="space-y-6 bg-white dark:bg-gray-800 shadow-md rounded-lg p-6">
            <div className="space-y-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                    Site presets
                  </h2>
                  <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                    Apply a newsroom preset to load curated filters and instantly request 100 story leads tailored to that brand.
                  </p>
                </div>
                {activeSiteKey && (
                  <button
                    type="button"
                    onClick={handleClearSitePreset}
                    className="self-start rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm transition hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
                  >
                    Clear active preset
                  </button>
                )}
              </div>
              <div className="grid gap-4">
                {siteEntries.map(([siteKey, site]) => {
                  const isActive = activeSiteKey === siteKey;
                  const keywordCount = Number(
                    'keywords' in site && Array.isArray(site.keywords)
                      ? site.keywords.length
                      : 0
                  );
                  const rssFeedCount = Number(
                    'rssFeeds' in site && Array.isArray(site.rssFeeds)
                      ? site.rssFeeds.length
                      : 0
                  );
                  const metadataSummary = (() => {
                    const parts: string[] = [];
                    if (keywordCount > 0) {
                      parts.push(`${keywordCount} keyword${keywordCount === 1 ? '' : 's'}`);
                    }
                    if (rssFeedCount > 0) {
                      parts.push(`${rssFeedCount} RSS feed${rssFeedCount === 1 ? '' : 's'}`);
                    }
                    if (parts.length === 0) {
                      return 'Uses default discovery settings.';
                    }
                    if (parts.length === 1) {
                      return `Includes ${parts[0]}.`;
                    }
                    return `Includes ${parts[0]} and ${parts[1]}.`;
                  })();

                  return (
                    <div
                      key={siteKey}
                      className={clsx(
                        'rounded-lg border p-4 transition-colors',
                        isActive
                          ? 'border-blue-500 bg-blue-50 dark:border-blue-300 dark:bg-blue-900/30'
                          : 'border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900'
                      )}
                    >
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                              {site.name}
                            </h3>
                            {isActive && (
                              <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/60 dark:text-blue-200">
                                Active
                              </span>
                            )}
                          </div>
                          <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
                            {metadataSummary}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            void handleGenerateSiteHeadlines(siteKey);
                          }}
                          className={clsx(
                            'w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:bg-blue-500 dark:hover:bg-blue-400 sm:w-auto',
                            headlineLoading && 'disabled:cursor-not-allowed disabled:opacity-60'
                          )}
                          disabled={headlineLoading}
                        >
                          {headlineLoading && isActive
                            ? 'Generating…'
                            : `Generate ${DEFAULT_HEADLINE_LIMIT} articles`}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div>
              <label className={labelStyle}>Sort by</label>
              <select
                className={inputStyle}
                value={sortBy}
                onChange={(e) =>
                  setSortBy(e.target.value as 'publishedAt' | 'relevancy' | 'popularity')
                }
              >
                {SORT_BY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                Newest first mirrors the previous default.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className={labelStyle}>From date (optional)</label>
                <input
                  type="date"
                  className={inputStyle}
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  max={toDate || undefined}
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  Limits the earliest article date. Leave blank to automatically
                  cover the last 30 days.
                </p>
              </div>
              <div>
                <label className={labelStyle}>To date (optional)</label>
                <input
                  type="date"
                  className={inputStyle}
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  min={fromDate || undefined}
                />
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  Must be on or after the "From" date when both are set. Leave
                  blank to include today.
                </p>
              </div>
            </div>

            <div className="pt-2">
              <button
                onClick={() => handleFetchHeadlines()}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded shadow disabled:opacity-60 disabled:cursor-not-allowed"
                disabled={
                  headlineLoading ||
                  (keywords.length === 0 && headlineDescription.length === 0)
                }
              >
                {headlineLoading ? 'Fetching…' : 'Fetch Headlines'}
              </button>
            </div>

            {headlineError && (
              <p className="text-sm text-red-500" role="alert">
                {headlineError}
              </p>
            )}

            {headlineLoading && !headlineError && (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Fetching headlines…
              </p>
            )}

            {!headlineLoading &&
              !headlineError &&
              headlineResults.length === 0 && (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Headlines will appear here after fetching.
              </p>
            )}

            {headlineQueries.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-gray-800 dark:text-gray-200">
                  Queries attempted
                </h3>
                <div className="flex flex-wrap gap-2">
                  {headlineQueries.map((query) => (
                    <span
                      key={query}
                      className="inline-flex items-center rounded-full bg-blue-100 dark:bg-blue-900/40 px-3 py-1 text-xs font-medium text-blue-700 dark:text-blue-300"
                    >
                      {query}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {headlineResults.length > 0 && (
              <div className="space-y-6">
                <h2 className="text-lg font-semibold">Headlines</h2>

                {headlineResults.length > 0 && (
                  <div className="space-y-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <label
                          htmlFor="copy-column-select"
                          className="text-sm font-medium text-gray-700 dark:text-gray-300"
                        >
                          Copy selection
                        </label>
                        <select
                          id="copy-column-select"
                          value={selectedCopyColumn}
                          onChange={(event) =>
                            setSelectedCopyColumn(
                              event.target.value as HeadlineClipboardColumn
                            )
                          }
                          className="block rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:focus:border-blue-400 dark:focus:ring-blue-400"
                        >
                          {HEADLINE_COPY_COLUMN_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => handleCopyHeadlines('tsv')}
                          className="inline-flex items-center rounded-md border border-transparent bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900"
                        >
                          Copy as TSV
                        </button>
                        <button
                          type="button"
                          onClick={() => handleCopyHeadlines('csv')}
                          className="inline-flex items-center rounded-md border border-blue-600 px-4 py-2 text-sm font-semibold text-blue-600 transition hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:border-blue-500 dark:text-blue-300 dark:hover:bg-blue-900/40 dark:focus:ring-offset-gray-900"
                        >
                          Copy as CSV
                        </button>
                      </div>
                    </div>
                    {copyFeedback && (
                      <p
                        className={clsx(
                          'text-sm',
                          copyFeedback.type === 'success'
                            ? 'text-green-600 dark:text-green-400'
                            : 'text-red-500 dark:text-red-400'
                        )}
                        role="status"
                        aria-live="polite"
                      >
                        {copyFeedback.message}
                      </p>
                    )}
                    <div className="overflow-x-auto">
                      <table className="min-w-full table-auto divide-y divide-gray-200 dark:divide-gray-700">
                        <thead className="bg-gray-100 dark:bg-gray-800">
                          <tr>
                            <th
                              scope="col"
                              className="px-4 py-2 text-left text-sm font-semibold text-gray-900 dark:text-gray-100"
                            >
                              Actions
                            </th>
                            <th
                              scope="col"
                              className="min-w-[14rem] px-4 py-2 text-left text-sm font-semibold text-gray-900 dark:text-gray-100 sm:w-[45%]"
                            >
                              Headline
                            </th>
                            <th
                              scope="col"
                              className="min-w-[11rem] px-4 py-2 text-left text-sm font-semibold text-gray-900 dark:text-gray-100 sm:w-[30%]"
                            >
                              Source &amp; Published
                            </th>
                            <th
                              scope="col"
                              className="min-w-[12rem] max-w-[20rem] px-4 py-2 text-left text-sm font-semibold text-gray-900 dark:text-gray-100 sm:w-[25%]"
                            >
                              Original Link
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                          {headlineResults.map((headline, index) => {
                            const headlineUrl = headline.url;
                            const formattedDate = formatPublishedDate(
                              headline.publishedAt
                            );
                            const relatedCount =
                              headline.relatedArticles?.length ?? 0;
                            const totalOutlets = relatedCount + 1;
                            const clusterSupportScore =
                              typeof headline.ranking?.components?.clusterSupport ===
                              'number'
                                ? headline.ranking.components.clusterSupport
                                : null;
                            const rankingClusterSize =
                              typeof headline.ranking?.details?.clusterSize === 'number'
                                ? headline.ranking.details.clusterSize
                                : null;
                            const uniqueSources =
                              typeof headline.ranking?.details?.clusterUniqueSources ===
                              'number'
                                ? headline.ranking.details.clusterUniqueSources
                                : null;
                            const effectiveClusterSize =
                              rankingClusterSize ?? totalOutlets;
                            const meetsClusterThreshold =
                              effectiveClusterSize !== null &&
                              effectiveClusterSize >= TRENDING_CLUSTER_SIZE_THRESHOLD;
                            const meetsSupportThreshold =
                              clusterSupportScore !== null &&
                              clusterSupportScore >= TRENDING_CLUSTER_SUPPORT_THRESHOLD;
                            const isTrending =
                              meetsClusterThreshold || meetsSupportThreshold;
                            const outletsLabel =
                              totalOutlets > 1
                                ? `${totalOutlets} outlets covering`
                                : totalOutlets === 1
                                ? '1 outlet covering'
                                : null;
                            const uniqueSourcesLabel =
                              uniqueSources && uniqueSources > 0
                                ? `${uniqueSources} unique sources`
                                : null;
                            const supportLabel =
                              clusterSupportScore !== null
                                ? `${Math.round(clusterSupportScore * 100)}% cluster support`
                                : null;
                            const trendingDetails = [
                              outletsLabel,
                              uniqueSourcesLabel,
                              supportLabel,
                            ]
                              .filter(Boolean)
                              .join(' • ');

                            return (
                              <tr
                                key={headlineUrl || index}
                                className="odd:bg-white even:bg-gray-50 dark:odd:bg-gray-900 dark:even:bg-gray-800"
                              >
                                <td className="px-4 py-3 align-top text-sm">
                                  <button
                                    type="button"
                                    onClick={() => handleRemoveHeadline(headline, index)}
                                    className="inline-flex items-center rounded-md border border-red-600 px-3 py-1 text-sm font-semibold text-red-600 transition hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 dark:border-red-500 dark:text-red-300 dark:hover:bg-red-900/40 dark:focus:ring-offset-gray-900"
                                    aria-label={`Remove headline ${
                                      headline.title || `#${index + 1}`
                                    }`}
                                  >
                                    Remove
                                  </button>
                                </td>
                                <td className="min-w-[14rem] align-top px-4 py-3 text-sm text-gray-900 dark:text-gray-100 sm:w-[45%]">
                                  <div className="font-semibold">
                                    {headline.title || 'Untitled headline'}
                                  </div>
                                  {isTrending && (
                                    <div
                                      className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
                                      role="status"
                                      aria-live="polite"
                                    >
                                      <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 font-semibold uppercase tracking-wide text-amber-800 dark:bg-amber-900/60 dark:text-amber-200">
                                        Trending
                                      </span>
                                      {trendingDetails && (
                                        <span className="text-amber-700 dark:text-amber-200/90">
                                          {trendingDetails}
                                        </span>
                                      )}
                                    </div>
                                  )}
                                  {headline.matchedQuery && (
                                    <div className="mt-2 text-xs text-blue-700 dark:text-blue-300">
                                      Matched query:{' '}
                                      <span className="font-medium">
                                        {headline.matchedQuery}
                                      </span>
                                    </div>
                                  )}
                                </td>
                                <td className="min-w-[11rem] align-top px-4 py-3 text-sm text-gray-700 dark:text-gray-300 sm:w-[30%]">
                                  <div className="space-y-1">
                                    {headline.source ? (
                                      <div className="font-medium text-gray-900 dark:text-gray-100">
                                        {headline.source}
                                      </div>
                                    ) : (
                                      <div className="text-gray-500 dark:text-gray-400">
                                        Source unavailable
                                      </div>
                                    )}
                                    {formattedDate && (
                                      <div className="text-xs text-gray-500 dark:text-gray-400">
                                        Published {formattedDate}
                                      </div>
                                    )}
                                  </div>
                                </td>
                                <td className="min-w-[12rem] max-w-[20rem] align-top break-words px-4 py-3 text-sm sm:w-[25%]">
                                  {headlineUrl ? (
                                    <a
                                      href={headlineUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="break-words text-blue-600 hover:underline dark:text-blue-400"
                                    >
                                      {headlineUrl}
                                    </a>
                                  ) : (
                                    <span className="text-gray-500 dark:text-gray-400">
                                      No link available
                                    </span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
