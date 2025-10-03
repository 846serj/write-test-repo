// route.ts
import { NextResponse } from 'next/server';
import { getOpenAI } from '../../../lib/openai';
import { DEFAULT_WORDS, WORD_RANGES } from '../../../constants/lengthOptions';
import { serpapiSearch, type SerpApiResult } from '../../../lib/serpapi';
import {
  formatThemeCoverageIssue,
  parseThemeCoverageIssue,
  resolveThemeThreshold,
  validateThemeCoverage,
  type ThemeCoverageIssue,
} from '../../../lib/themeCoverage';

export const runtime = 'edge';
export const revalidate = 0;

interface NewsArticle {
  title: string;
  url: string;
  summary: string;
  publishedAt: string;
}

interface ReportingSource {
  title: string;
  url: string;
  summary: string;
  publishedAt: string;
  categories?: string[];
  sourceName?: string;
  sourceType?: string;
}

type ReportingContext = {
  reportingSources: ReportingSource[];
  reportingBlock: string;
  groundingInstruction: string;
  linkSources: string[];
  referenceBlock: string;
};

type VerificationSource =
  | string
  | {
      url?: string | null;
      title?: string | null;
      summary?: string | null;
      publishedAt?: string | null;
    };

const MILLIS_IN_MINUTE = 60 * 1000;
const MILLIS_IN_HOUR = 60 * MILLIS_IN_MINUTE;
const MILLIS_IN_DAY = 24 * MILLIS_IN_HOUR;
const MILLIS_IN_WEEK = 7 * MILLIS_IN_DAY;
const RELATIVE_TIME_UNIT_MS: Record<string, number> = {
  m: MILLIS_IN_MINUTE,
  min: MILLIS_IN_MINUTE,
  mins: MILLIS_IN_MINUTE,
  minute: MILLIS_IN_MINUTE,
  minutes: MILLIS_IN_MINUTE,
  h: MILLIS_IN_HOUR,
  hr: MILLIS_IN_HOUR,
  hrs: MILLIS_IN_HOUR,
  hour: MILLIS_IN_HOUR,
  hours: MILLIS_IN_HOUR,
  d: MILLIS_IN_DAY,
  day: MILLIS_IN_DAY,
  days: MILLIS_IN_DAY,
  w: MILLIS_IN_WEEK,
  week: MILLIS_IN_WEEK,
  weeks: MILLIS_IN_WEEK,
  mo: 30 * MILLIS_IN_DAY,
  mos: 30 * MILLIS_IN_DAY,
  month: 30 * MILLIS_IN_DAY,
  months: 30 * MILLIS_IN_DAY,
  y: 365 * MILLIS_IN_DAY,
  yr: 365 * MILLIS_IN_DAY,
  yrs: 365 * MILLIS_IN_DAY,
  year: 365 * MILLIS_IN_DAY,
  years: 365 * MILLIS_IN_DAY,
};

const MAX_SOURCE_WINDOW_MS = 14 * MILLIS_IN_DAY;
const SERP_14_DAY_TBS = 'qdr:d14';
const MAX_FUTURE_DRIFT_MS = 5 * MILLIS_IN_MINUTE;

const sectionRanges: Record<string, [number, number]> = {
  shorter: [2, 3],
  short: [3, 5],
  medium: [5, 7],
  longForm: [7, 10],
  longer: [10, 12],
};

type OutlinePromptOptions = {
  title: string;
  reportingContext: string;
  sectionInstruction: string;
  referenceBlock: string;
  extraBullets?: string[];
};

function buildOutlinePrompt({
  title,
  reportingContext,
  sectionInstruction,
  referenceBlock,
  extraBullets = [],
}: OutlinePromptOptions): string {
  const extraBulletBlock = extraBullets.length
    ? `${extraBullets.map((bullet) => `• ${bullet}`).join('\n')}\n`
    : '';
  const referenceSection = referenceBlock ? `${referenceBlock}\n` : '';

  return `
You are a professional writer creating a factually accurate, well-structured outline for the article titled "${title}".

${reportingContext}Outline requirements:
• Begin with a section labeled "INTRO:" and include a single bullet with a 2–3 sentence introduction (no <h2>).
• The INTRO bullet must highlight the most newsworthy concrete facts—names, figures, locations, and only dates that materially change the story—from the reporting summaries and cite the matching sources instead of offering generic context; if a date is essential, weave it in after the subject rather than opening the intro with it.
• After the "INTRO:" section, ${sectionInstruction}.
${extraBulletBlock}• Under each <h2>, list 2–3 bullet-point subtopics describing what evidence, examples, or angles to cover.
• Preserve every concrete fact from the reporting block and Key details list—names, dates, figures, locations, quotes—and restate them verbatim within the relevant subtopic bullets rather than summarizing vaguely.
• For every bullet that draws on reporting, append " (Source: URL)" with the matching link.
• Do not combine multiple unrelated facts in a single bullet; give each person, organization, metric, or timestamp its own bullet so it can be cited precisely.
• Do NOT use "Introduction" or "Intro" as an <h2> heading.
• Do NOT use "Conclusion" or "Bottom line" as an <h2> heading.
${referenceSection}• Do not invent information beyond the provided reporting.
`.trim();
}

type ArticlePromptOptions = {
  title: string;
  outline: string;
  reportingSection: string;
  toneInstruction: string;
  povInstruction: string;
  lengthInstruction: string;
  groundingInstruction: string;
  customInstructionBlock: string;
  linkInstruction: string;
  extraRequirements?: string[];
};

function buildArticlePrompt({
  title,
  outline,
  reportingSection,
  toneInstruction,
  povInstruction,
  lengthInstruction,
  groundingInstruction,
  customInstructionBlock,
  linkInstruction,
  extraRequirements = [],
}: ArticlePromptOptions): string {
  const extraRequirementBlock = extraRequirements.length
    ? `${extraRequirements.map((item) => `  - ${item}`).join('\n')}\n`
    : '';

  return `
You are a professional journalist writing a web article.

Title: "${title}"
Do NOT include the title or any <h1> tag in the HTML output.

Outline:
${outline}

${reportingSection}${toneInstruction}${povInstruction}Requirements:
  ${lengthInstruction}
  - Use the outline's introduction bullet to write a 2–3 sentence introduction (no <h2> tags) without including the words "INTRO:" or "Introduction".
  - For each <h2> in the outline, write 2–3 paragraphs under it.
  - Keep every section anchored to the authoritative reporting summaries provided so each paragraph reflects accurate, highly relevant sourcing.
  ${extraRequirementBlock}  - Use standard HTML tags such as <h2>, <h3>, <p>, <a>, <ul>, and <li> as needed.
  - Avoid cheesy or overly rigid language (e.g., "gem", "embodiment", "endeavor", "Vigilant", "Daunting", etc.).
  - Avoid referring to the article itself (e.g., “This article explores…” or “In this article…”) anywhere in the introduction.
  - Do NOT wrap your output in markdown code fences or extra <p> tags.
  ${DETAIL_INSTRUCTION}${customInstructionBlock}${groundingInstruction}${linkInstruction}
  - Do NOT label the intro under "Introduction" or with prefixes like "INTRO:", and do not end with a "Conclusion" heading or closing phrases like "In conclusion".
  - Do NOT invent sources, links, or information not present in the provided reporting.

Output raw HTML only:
`.trim();
}

function normalizeTitleValue(title: string | undefined | null): string {
  const holder = normalizeTitleValue as unknown as {
    _publisherData?: {
      knownWords: Set<string>;
      knownExact: Set<string>;
    };
  };

  if (!holder._publisherData) {
    holder._publisherData = {
      knownWords: new Set([
        'news',
        'times',
        'post',
        'journal',
        'tribune',
        'guardian',
        'gazette',
        'review',
        'report',
        'chronicle',
        'daily',
        'herald',
        'press',
        'today',
        'insider',
        'bloomberg',
        'reuters',
        'axios',
        'politico',
        'verge',
        'engadget',
        'techcrunch',
        'wired',
        'cnbc',
        'cnn',
        'bbc',
        'cbs',
        'abc',
        'fox',
        'fortune',
        'forbes',
        'npr',
        'yahoo',
        'ap',
        'barron',
        "barron's",
        'wsj',
        'telegraph',
        'independent',
        'register',
        'observer',
        'courier',
        'star',
        'globe',
        'sun',
        'mirror',
        'economist',
        'financial',
      ]),
      knownExact: new Set([
        'new york times',
        'washington post',
        'wall street journal',
        'associated press',
        'financial times',
        'usa today',
        'los angeles times',
        'la times',
        'business insider',
        'the verge',
        'the guardian',
        'the atlantic',
        'the economist',
        'sky news',
        'cnet',
        'buzzfeed news',
      ]),
    };
  }

  const { knownWords, knownExact } = holder._publisherData;

  function isLikelyPublisherSegment(segment: string): boolean {
    const trimmed = segment.trim();
    if (!trimmed) return false;

    const stripped = trimmed.replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '');
    if (!stripped) return false;

    const lowered = stripped.toLowerCase();
    if (knownExact.has(lowered)) {
      return true;
    }

    if (lowered.includes('.com') || lowered.includes('.net') || lowered.includes('.org')) {
      return true;
    }

    const loweredWords = lowered.split(/\s+/);
    if (loweredWords.length === 0 || loweredWords.length > 6) {
      return false;
    }

    if (loweredWords.some((word) => knownWords.has(word))) {
      return true;
    }

    const originalWords = trimmed.split(/\s+/);
    let alphaWordCount = 0;
    let titleCasedCount = 0;

    for (const word of originalWords) {
      if (!/[A-Za-z]/.test(word)) {
        continue;
      }
      alphaWordCount += 1;

      if (word === word.toUpperCase()) {
        titleCasedCount += 1;
        continue;
      }

      const first = word.charAt(0);
      const rest = word.slice(1);
      if (first === first.toUpperCase() && rest === rest.toLowerCase()) {
        titleCasedCount += 1;
      }
    }

    if (alphaWordCount > 0 && titleCasedCount >= alphaWordCount - 1) {
      return true;
    }

    return false;
  }

  let normalized = (title ?? '').trim();
  const trailingSeparatorRegex = /\s*[\-–—|]\s*([^\-–—|]+)$/;

  while (true) {
    const match = normalized.match(trailingSeparatorRegex);
    if (!match) {
      break;
    }

    const segment = match[1]?.trim() ?? '';
    if (!segment) {
      break;
    }

    if (!isLikelyPublisherSegment(segment)) {
      break;
    }

    normalized = normalized.slice(0, normalized.length - match[0].length).trimEnd();
  }

  normalized = normalized.replace(/[\s]*[\-–—|:;,]+$/g, '').trim();

  return normalized.toLowerCase().replace(/\s+/g, ' ');
}

function getWordBounds(
  lengthOption: string | undefined,
  customSections: number | undefined
): [number, number] {
  if (lengthOption === 'custom' && customSections) {
    const approx = customSections * 220;
    return [Math.floor(approx * 0.8), Math.ceil(approx * 1.2)];
  }
  if (lengthOption && WORD_RANGES[lengthOption]) {
    return WORD_RANGES[lengthOption];
  }
  return [DEFAULT_WORDS - 150, DEFAULT_WORDS + 150];
}


// Minimum number of source links to include in generated content
const MIN_LINKS = 3;
const STRICT_LINK_RETRY_THRESHOLD = 2;
const LENGTH_EXPANSION_ATTEMPTS = 2;
const VERIFICATION_DISCREPANCY_THRESHOLD = 0;
const VERIFICATION_MAX_SOURCE_FIELD_LENGTH = 600;
const VERIFICATION_MAX_SOURCES = 8;

const DEFAULT_VERIFICATION_TIMEOUT_MS = 9_000;
const VERIFICATION_TIMEOUT_MS = (() => {
  const raw = process.env.OPENAI_VERIFICATION_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : DEFAULT_VERIFICATION_TIMEOUT_MS;
})();

const VERIFICATION_MODEL = process.env.OPENAI_VERIFICATION_MODEL ?? 'gpt-4o-mini';

const THEME_COVERAGE_THRESHOLD = (() => {
  const raw = process.env.TRAVEL_THEME_COVERAGE_THRESHOLD;
  if (!raw) {
    return resolveThemeThreshold(undefined);
  }
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) {
    return resolveThemeThreshold(undefined);
  }
  return resolveThemeThreshold(parsed);
})();

// Low temperature to encourage factual consistency for reporting prompts
const FACTUAL_TEMPERATURE = 0.2;

const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'gpt-4o': 16384,
  'gpt-4o-mini': 16384,
  'gpt-4': 8192,
  'gpt-3.5-turbo': 16000,
};

const COMPLETION_SAFETY_MARGIN_TOKENS = 256;

// Encourage more concrete examples by default
const DETAIL_INSTRUCTION =
  '- Provide specific real-world examples (e.g., car model years or actual app names) instead of generic placeholders like "App 1".\n' +
  '- When sources include concrete facts, repeat them precisely: list full names, give unrounded figures, and preserve other specific details; include exact dates only when they materially affect the narrative and are required for clarity.\n' +
  '- Keep official names, model numbers, and other exact designations verbatim when they appear in the sources (e.g., "IL-20" instead of "plane").\n' +
  '- When summarizing, never replace explicit metrics, named individuals, or timelines with vague substitutes such as "many", "recently", or "officials"—quote the exact figures, crucial dates, and proper nouns provided.\n' +
  '- Integrate any necessary dates into sentences after the lead clause (e.g., "Company X said on March 3, 2024") instead of starting paragraphs or sentences with the date.\n' +
  '- Do not speculate or embellish beyond what the sources explicitly provide.\n' +
  '- Treat every "Key details" line in the reporting block as mandatory: restate those exact metrics, names, and timelines in the article body and attribute them to the correct source with an inline citation.\n' +
  '- Each paragraph that introduces a factual statement must contain at least one inline citation tied to a concrete detail such as a number, date, named person, organization, or location, and paragraphs covering multiple facts should cite each one individually.\n' +
  '- When outlining developments over time, pair each essential milestone with the exact date or timeframe reported in the sources (e.g., "on March 3, 2024") and cite it inline while keeping the date after the subject.\n' +
  '- Enumerate every figure, location, and named stakeholder the sources mention instead of collapsing them into a single vague summary—spell them out verbatim and cite them inline.\n' +
  '- Explicitly reference the titles or roles that identify key people or organizations when the sources provide them, and cite the matching link.\n' +
  '- When a source explains impact or stakes (e.g., job losses, funding amounts, geographic coverage), restate those outcomes verbatim with citations rather than summarizing them abstractly.\n' +
  '- Treat the outline as a factual checklist: every specific name, title, figure, location, quote, and date it contains must appear in the article body with identical wording and an inline citation to the same source noted in the outline.\n' +
  '- If the outline introduction bullet includes concrete facts, repeat them in the article introduction with the same explicit data points and citations instead of replacing them with generic framing.\n' +
  '- If a potentially important fact cannot be verified in the provided sources, omit it and instead note "Unverified based on available sources."\n';

const TIMELINE_REGEX =
  /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\s+\d{1,2}(?:st|nd|rd|th)?)?(?:,\s*\d{4})?\b/gi;
const QUARTER_REGEX = /\b(?:Q[1-4]|H[12])\s*(?:\d{4})?\b/gi;
const ISO_DATE_REGEX = /\b\d{4}[-\/](?:0?[1-9]|1[0-2])[-\/](?:0?[1-9]|[12]\d|3[01])\b/g;
const YEAR_WITH_CONTEXT_REGEX = /\b(?:in|by|during|through|since|from)\s+(19\d{2}|20\d{2})\b/gi;
const NUMERIC_METRIC_REGEX =
  /(?:[$£€]\s?)?\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\b(?:\s?(?:%|percent|percentage|pp|basis points|people|patients|respondents|cases|votes|points|miles|mile|kilometers|kilometres|km|meters|metres|m|kilograms|kg|grams|g|pounds|lbs|°f|°c|usd|dollars|euros|pounds|yen|yuan|won|rupees|million|billion|trillion|k|units|devices|users|students|employees|samples|tests|surveys|mg|ml|gwh|mwh|kw|mw|gw|tons|tonnes|barrels|gallons|liters|litres|ppm|ppb|per\s+capita|per\s+share|per\s+day|per\s+hour))?/gi;
const METHOD_KEYWORDS = [
  'randomized controlled trial',
  'double-blind trial',
  'placebo-controlled trial',
  'longitudinal study',
  'cross-sectional study',
  'pilot study',
  'observational study',
  'clinical trial',
  'survey',
  'poll',
  'census',
  'analysis',
  'benchmark',
  'simulation',
  'prototype',
  'sensor',
  'algorithm',
  'dataset',
  'measurement',
  'sampling',
  'methodology',
  'technique',
  'audit',
  'assessment',
  'evaluation',
  'regression model',
  'machine learning model',
  'laboratory test',
  'peer-reviewed'
];
const ENTITY_STOPWORDS = new Set([
  'Recent',
  'Reporting',
  'Summary',
  'URL',
  'The',
  'A',
  'An',
  'And',
  'For',
  'With',
  'From',
  'This',
  'That',
  'These',
  'Those',
  'First',
  'Second',
  'Third',
  'Fourth',
  'Fifth',
  'Sixth',
  'Seventh',
  'Eighth',
  'Ninth',
  'Tenth',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]);

interface StructuredFacts {
  metrics: string[];
  timelines: string[];
  methods: string[];
  entities: string[];
}

function dedupeDetails(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function extractMethodPhrases(text: string): string[] {
  if (!text) {
    return [];
  }
  const lowered = text.toLowerCase();
  const phrases: string[] = [];
  for (const keyword of METHOD_KEYWORDS) {
    const index = lowered.indexOf(keyword);
    if (index === -1) {
      continue;
    }
    const snippet = text.slice(index, index + keyword.length);
    phrases.push(snippet);
  }
  return phrases;
}

function extractProperNouns(text: string): string[] {
  if (!text) {
    return [];
  }
  const matches = text.match(/\b(?:[A-Z][a-z]+(?:\s+(?:[A-Z][a-z]+|[A-Z]{2,}|of|and|the|for|de|la|di|van|von|da|der|del|du|le))*|[A-Z]{3,})\b/g);
  if (!matches) {
    return [];
  }
  const filtered = matches.filter((match) => {
    const cleaned = match.replace(/\s+/g, ' ').trim();
    if (!cleaned) {
      return false;
    }
    if (ENTITY_STOPWORDS.has(cleaned)) {
      return false;
    }
    const wordCount = cleaned.split(/\s+/g).length;
    if (wordCount === 1) {
      if (/^[A-Z]{3,}$/.test(cleaned)) {
        return true;
      }
      if (/^[A-Z][a-z]+(?:['-][A-Za-z]+)?$/.test(cleaned) && cleaned.length > 2) {
        return true;
      }
      return false;
    }
    return true;
  });
  return filtered;
}

function collectMetricTokens(text: string): string[] {
  if (!text) {
    return [];
  }
  const metrics: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = NUMERIC_METRIC_REGEX.exec(text))) {
    let token = match[0];
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 30);
    const hyphenMatch = after.match(/^-[A-Za-z]+(?:-[A-Za-z]+)?/);
    if (hyphenMatch) {
      token += hyphenMatch[0];
    }
    const perMatch = after.match(/^\s+(?:per|each)\s+[A-Za-z%°/$-]+/i);
    if (perMatch) {
      token += perMatch[0];
    }
    metrics.push(token);
  }
  const currencyMatches = text.match(/[$£€]\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?(?:\s*(?:million|billion|trillion))?/gi);
  if (currencyMatches) {
    metrics.push(...currencyMatches);
  }
  return metrics;
}

function collectTimelineTokens(text: string): string[] {
  if (!text) {
    return [];
  }
  const timelines: string[] = [];
  const monthMatches = text.match(TIMELINE_REGEX);
  if (monthMatches) {
    timelines.push(...monthMatches);
  }
  const quarterMatches = text.match(QUARTER_REGEX);
  if (quarterMatches) {
    timelines.push(...quarterMatches);
  }
  const isoMatches = text.match(ISO_DATE_REGEX);
  if (isoMatches) {
    timelines.push(...isoMatches);
  }
  let contextualMatch: RegExpExecArray | null;
  while ((contextualMatch = YEAR_WITH_CONTEXT_REGEX.exec(text))) {
    timelines.push(contextualMatch[0]);
  }
  return timelines;
}

function extractStructuredFacts(summary: string | undefined | null): StructuredFacts {
  if (!summary) {
    return { metrics: [], timelines: [], methods: [], entities: [] };
  }
  const normalized = summary.replace(/\s+/g, ' ').trim();
  if (!normalized || /^no summary provided\.?$/i.test(normalized)) {
    return { metrics: [], timelines: [], methods: [], entities: [] };
  }

  const metrics = dedupeDetails(collectMetricTokens(normalized), 6);
  const timelinesRaw = collectTimelineTokens(normalized);
  const timelines = dedupeDetails(timelinesRaw, 5);
  const methods = dedupeDetails(extractMethodPhrases(normalized), 4);
  const entities = dedupeDetails(extractProperNouns(normalized), 6);

  const timelineSet = new Set(timelines.map((item) => item.toLowerCase()));
  const filteredMetrics = metrics.filter((item) => !timelineSet.has(item.toLowerCase()));
  const refinedMetrics = filteredMetrics.filter((item) => {
    const numeric = item.replace(/[^0-9.]/g, '');
    if (!numeric) {
      return true;
    }
    const numericValue = Number.parseFloat(numeric);
    if (!Number.isFinite(numericValue)) {
      return true;
    }
    if (Number.isInteger(numericValue) && numericValue <= 31 && item.replace(/[^0-9]/g, '').length <= 2) {
      return false;
    }
    return true;
  });

  return {
    metrics: refinedMetrics,
    timelines,
    methods,
    entities,
  };
}

function formatKeyDetails(summary: string | undefined | null): string[] {
  const facts = extractStructuredFacts(summary);
  const segments: string[] = [];
  if (facts.metrics.length) {
    segments.push(`Cite these metrics verbatim: ${facts.metrics.join(', ')}`);
  }
  if (facts.timelines.length) {
    segments.push(`State these reported timelines exactly: ${facts.timelines.join(', ')}`);
  }
  if (facts.methods.length) {
    segments.push(`Reference the research methods noted: ${facts.methods.join('; ')}`);
  }
  if (facts.entities.length) {
    segments.push(`Name these entities precisely: ${facts.entities.join(', ')}`);
  }
  return segments;
}

async function generateOutlineWithFallback(
  prompt: string,
  fallbackModel: string,
  temperature = 0.7
): Promise<string> {
  const openai = getOpenAI();
  const outlineRes = await openai.chat.completions.create({
    model: fallbackModel,
    messages: [{ role: 'user', content: prompt }],
    temperature,
  });

  const outline = outlineRes.choices[0]?.message?.content?.trim();
  if (!outline) throw new Error('Outline generation failed');
  return outline;
}

function calcMaxTokens(
  lengthOption: string | undefined,
  customSections: number | undefined,
  model: string
): number {
  let desiredWords: number;
  if (lengthOption === 'custom' && customSections) {
    desiredWords = customSections * 220;
  } else if (lengthOption && WORD_RANGES[lengthOption]) {
    const [minW, maxW] = WORD_RANGES[lengthOption];
    desiredWords = (minW + maxW) / 2;
  } else {
    desiredWords = DEFAULT_WORDS;
  }
  const tokens = Math.ceil(desiredWords / 0.75);
  const limit = MODEL_CONTEXT_LIMITS[model] || 8000;
  return Math.min(tokens, limit);
}

type FetchSourcesOptions = {
  maxAgeMs?: number | null;
  serpParams?: Record<string, string>;
};

const SOURCE_TOKEN_MIN_LENGTH = 3;
const SOURCE_MAX_TOKEN_COUNT = 64;
const SOURCE_MIN_SCORE = 0.2;

function buildSourceTokenSet(
  ...fields: Array<string | null | undefined>
): Set<string> {
  const combined = fields
    .filter((field): field is string => typeof field === 'string')
    .join(' ')
    .toLowerCase();

  if (!combined) {
    return new Set();
  }

  const rawTokens = combined
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= SOURCE_TOKEN_MIN_LENGTH);

  const tokenSet = new Set<string>();
  for (const token of rawTokens) {
    if (!token) {
      continue;
    }
    tokenSet.add(token);
    if (tokenSet.size >= SOURCE_MAX_TOKEN_COUNT) {
      break;
    }
  }

  return tokenSet;
}

function computeSourceOverlapScore(
  headlineTokens: Set<string>,
  candidateTokens: Set<string>
): number {
  if (headlineTokens.size === 0 || candidateTokens.size === 0) {
    return 0;
  }

  let intersection = 0;
  candidateTokens.forEach((token) => {
    if (headlineTokens.has(token)) {
      intersection += 1;
    }
  });

  if (intersection === 0) {
    return 0;
  }

  const precision = intersection / Math.max(1, candidateTokens.size);
  const recall = intersection / Math.max(1, headlineTokens.size);

  return (2 * precision * recall) / Math.max(precision + recall, Number.EPSILON);
}

type ScoredReportingSource = ReportingSource & {
  score: number;
  publishedTimestamp: number;
};

async function fetchSources(
  headline: string,
  { maxAgeMs = MAX_SOURCE_WINDOW_MS, serpParams }: FetchSourcesOptions = {}
): Promise<ReportingSource[]> {
  const nowMs = Date.now();
  const seenLinks = new Set<string>();
  const seenPublishers = new Set<string>();
  const seenTitles = new Set<string>();
  const headlineTokens = buildSourceTokenSet(headline);
  const candidateSources: ScoredReportingSource[] = [];

  const newsPromise: Promise<NewsArticle[]> = process.env.NEWS_API_KEY
    ? fetchNewsArticles(headline, false).catch((err) => {
        console.warn(
          '[api/generate] news api sourcing failed, continuing with SERP',
          err
        );
        return [];
      })
    : Promise.resolve([]);

  const serpPromise = serpapiSearch({
    query: headline,
    engine: 'google_news',
    extraParams: serpParams ?? { tbs: SERP_14_DAY_TBS },
    limit: 12,
  });

  const [newsArticles, serpResults] = await Promise.all([
    newsPromise,
    serpPromise,
  ]);

  for (const article of newsArticles) {
    const url = article.url;
    const normalizedTitle = normalizeTitleValue(article.title);
    if (!url || seenLinks.has(url)) {
      continue;
    }

    if (normalizedTitle && seenTitles.has(normalizedTitle)) {
      continue;
    }

    const publishedTimestamp = parsePublishedTimestamp(article.publishedAt, nowMs);
    if (
      publishedTimestamp === null ||
      !isTimestampWithinWindow(publishedTimestamp, nowMs, maxAgeMs)
    ) {
      continue;
    }

    let publisherId: string | null = null;
    try {
      publisherId = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      publisherId = null;
    }

    if (publisherId && seenPublishers.has(publisherId)) {
      continue;
    }

    const summary = (article.summary || '').replace(/\s+/g, ' ').trim();
    const rawTitle = article.title;
    const title = rawTitle || 'Untitled';
    const candidateTokens = buildSourceTokenSet(rawTitle, summary);
    const hasCandidateTokens = candidateTokens.size > 0;
    const score = hasCandidateTokens
      ? computeSourceOverlapScore(headlineTokens, candidateTokens)
      : 0;

    if (
      headlineTokens.size > 0 &&
      hasCandidateTokens &&
      score < SOURCE_MIN_SCORE
    ) {
      continue;
    }

    const reportingSource: ScoredReportingSource = {
      title,
      url,
      summary,
      publishedAt: normalizePublishedAt(publishedTimestamp),
      score,
      publishedTimestamp,
    };

    candidateSources.push(reportingSource);

    seenLinks.add(url);
    if (publisherId) {
      seenPublishers.add(publisherId);
    }
    if (normalizedTitle) {
      seenTitles.add(normalizedTitle);
    }
  }

  for (const result of serpResults) {
    const normalizedTitle = normalizeTitleValue(result.title);
    if (normalizedTitle && seenTitles.has(normalizedTitle)) {
      continue;
    }

    const link = result.link;
    if (!link || seenLinks.has(link)) {
      continue;
    }

    const publisherId = normalizePublisher(result);
    if (!publisherId || seenPublishers.has(publisherId)) {
      continue;
    }

    const summary = (result.snippet || result.summary || '')
      .replace(/\s+/g, ' ')
      .trim();
    const publishedAtRaw =
      result.published_at || result.date_published || result.date || '';
    const publishedTimestamp = parsePublishedTimestamp(publishedAtRaw, nowMs);
    if (
      publishedTimestamp === null ||
      !isTimestampWithinWindow(publishedTimestamp, nowMs, maxAgeMs)
    ) {
      continue;
    }
    const rawTitle = result.title;
    const title = rawTitle || 'Untitled';
    const candidateTokens = buildSourceTokenSet(rawTitle, summary);
    const hasCandidateTokens = candidateTokens.size > 0;
    const score = hasCandidateTokens
      ? computeSourceOverlapScore(headlineTokens, candidateTokens)
      : 0;

    if (
      headlineTokens.size > 0 &&
      hasCandidateTokens &&
      score < SOURCE_MIN_SCORE
    ) {
      continue;
    }

    seenLinks.add(link);
    seenPublishers.add(publisherId);
    if (normalizedTitle) {
      seenTitles.add(normalizedTitle);
    }

    candidateSources.push({
      title,
      url: link,
      summary,
      publishedAt: normalizePublishedAt(publishedTimestamp),
      score,
      publishedTimestamp,
    });
  }

  if (!candidateSources.length) {
    return [];
  }

  candidateSources.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    return b.publishedTimestamp - a.publishedTimestamp;
  });

  return candidateSources.slice(0, 5).map((candidate) => {
    const { score: _score, publishedTimestamp: _publishedTimestamp, ...source } =
      candidate;
    return source;
  });
}

function normalizeHeadlineWhitespace(headline: string): string {
  return headline.replace(/\s+/g, ' ').trim();
}

function getRegistrableDomain(hostname: string): string | null {
  if (!hostname) {
    return null;
  }

  const normalized = hostname.toLowerCase();
  const parts = normalized.split('.').filter(Boolean);
  if (!parts.length) {
    return null;
  }

  if (parts.length <= 2) {
    return parts.join('.');
  }

  const lastTwo = parts.slice(-2).join('.');
  const secondLevelTlds = new Set([
    'co.uk',
    'org.uk',
    'gov.uk',
    'ac.uk',
    'co.jp',
    'com.au',
    'net.au',
  ]);

  if (secondLevelTlds.has(lastTwo) && parts.length >= 3) {
    return `${parts[parts.length - 3]}.${lastTwo}`;
  }

  return lastTwo;
}

function formatPublishedTimestamp(value: string): string {
  if (!value) {
    return 'Unknown publication time';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown publication time';
  }
  return date.toISOString();
}

function normalizeSummary(summary: string): string {
  const trimmed = summary.replace(/\s+/g, ' ').trim();
  return trimmed || 'No summary provided.';
}

function buildRecentReportingBlock(sources: ReportingSource[]): string {
  if (!sources.length) {
    return '';
  }

  const entries = sources
    .map((item) => {
      const timestamp = formatPublishedTimestamp(item.publishedAt);
      const summary = normalizeSummary(item.summary);
      const keyDetails = formatKeyDetails(item.summary);
      const title = item.title || 'Untitled';
      const detailLine =
        keyDetails.length > 0
          ? `\n  Must include and cite each item below as a distinct, cited sentence:\n${keyDetails
              .map((detail) => `    - ${detail}`)
              .join('\n')}`
          : '';
      return `- "${title}" (${timestamp})\n  Summary: ${summary}${detailLine}\n  URL: ${item.url}`;
    })
    .join('\n');

  return `Key facts from recent reporting (weave them into the narrative; do not write standalone paragraphs about the outlets, and treat the URLs as attribution only):\n${entries}`;
}

function normalizePublisher(result: SerpApiResult): string | null {
  const rawSource = typeof result.source === 'string' ? result.source : '';
  const normalizedSource = rawSource.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalizedSource) {
    return normalizedSource;
  }

  const link = result.link;
  if (!link) return null;

  try {
    const hostname = new URL(link).hostname.toLowerCase();
    if (!hostname) return null;
    return hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function parseRelativeTimestamp(value: string, referenceMs: number): number | null {
  const cleaned = value.trim().toLowerCase();
  if (!cleaned) {
    return null;
  }

  if (cleaned === 'yesterday') {
    return referenceMs - MILLIS_IN_DAY;
  }

  if (cleaned === 'today') {
    return referenceMs;
  }

  const normalized = cleaned.replace(/,/g, '');
  const fullMatch = normalized.match(/^(\d+|an|a)\s*([a-z]+)\s+ago$/);
  const compactMatch = normalized.match(/^(\d+)([a-z]+)\s+ago$/);
  const match = fullMatch ?? compactMatch;
  if (!match) {
    return null;
  }

  const amountRaw = match[1];
  const unitRaw = match[2];
  const amount = amountRaw === 'a' || amountRaw === 'an' ? 1 : Number.parseInt(amountRaw, 10);
  const unitMs = RELATIVE_TIME_UNIT_MS[unitRaw];

  if (!Number.isFinite(amount) || !unitMs) {
    return null;
  }

  return referenceMs - amount * unitMs;
}

function parsePublishedTimestamp(
  raw: string | null | undefined,
  referenceMs: number
): number | null {
  if (!raw) {
    return null;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    return parsed;
  }

  return parseRelativeTimestamp(trimmed, referenceMs);
}

function isTimestampWithinWindow(
  timestamp: number,
  referenceMs: number,
  maxAgeMs: number | null | undefined = MAX_SOURCE_WINDOW_MS
): boolean {
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  if (timestamp > referenceMs + MAX_FUTURE_DRIFT_MS) {
    return false;
  }

  if (maxAgeMs == null) {
    return true;
  }

  return referenceMs - timestamp <= maxAgeMs;
}

function normalizePublishedAt(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

async function fetchNewsArticles(
  query: string,
  serpFallbackEnabled: boolean
): Promise<NewsArticle[]> {
  const nowMs = Date.now();
  const fromIso = new Date(nowMs - MAX_SOURCE_WINDOW_MS).toISOString();
  const newsKey = process.env.NEWS_API_KEY;

  if (newsKey) {
    try {
      const url = new URL('https://newsapi.org/v2/everything');
      url.searchParams.set('q', query);
      url.searchParams.set('from', fromIso);
      url.searchParams.set('sortBy', 'publishedAt');
      url.searchParams.set('language', 'en');
      url.searchParams.set('pageSize', '12');
      const resp = await fetch(url, {
        headers: { 'X-Api-Key': newsKey },
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data?.status === 'ok' && Array.isArray(data.articles)) {
          const parsed = (data.articles as any[])
            .map((article) => {
              const publishedRaw =
                article?.publishedAt || article?.updatedAt || article?.date || '';
              const publishedTimestamp = parsePublishedTimestamp(publishedRaw, nowMs);

              if (
                publishedTimestamp === null ||
                !isTimestampWithinWindow(publishedTimestamp, nowMs)
              ) {
                return null;
              }

              const summaryValue =
                article?.description || article?.content || article?.summary || '';

              const summary = typeof summaryValue === 'string'
                ? summaryValue.replace(/\s+/g, ' ').trim()
                : '';

              const mapped: NewsArticle = {
                title: article?.title || article?.headline || 'Untitled',
                url: article?.url || '',
                summary,
                publishedAt: normalizePublishedAt(publishedTimestamp),
              };

              return mapped.title && mapped.url ? mapped : null;
            })
            .filter((item: NewsArticle | null): item is NewsArticle => Boolean(item));
          if (parsed.length > 0) {
            return parsed.slice(0, 8);
          }
        }
      }
    } catch (err) {
      console.warn('[api/generate] news api fetch failed, falling back to SerpAPI', err);
    }
  }

  if (!serpFallbackEnabled || !process.env.SERPAPI_KEY) {
    return [];
  }

  try {
    const serpResults = await serpapiSearch({
      query,
      engine: 'google_news',
      extraParams: { tbs: SERP_14_DAY_TBS },
      limit: 8,
    });

    const seenTitles = new Set<string>();
    const articles: NewsArticle[] = [];

    for (const item of serpResults) {
      const normalizedTitle = normalizeTitleValue(item.title);
      if (normalizedTitle && seenTitles.has(normalizedTitle)) {
        continue;
      }

      const article: NewsArticle = {
        title: item.title || 'Untitled',
        url: item.link || '',
        summary: (item.snippet || '').replace(/\s+/g, ' ').trim(),
        publishedAt: '',
      };

      if (!article.title || !article.url) {
        continue;
      }

      const publishedTimestamp = parsePublishedTimestamp(
        item.published_at || item.date_published || item.date || '',
        nowMs
      );

      if (publishedTimestamp === null || !isTimestampWithinWindow(publishedTimestamp, nowMs)) {
        continue;
      }

      article.publishedAt = normalizePublishedAt(publishedTimestamp);

      if (normalizedTitle) {
        seenTitles.add(normalizedTitle);
      }

      articles.push(article);

      if (articles.length >= 8) {
        break;
      }
    }

    return articles;
  } catch (err) {
    console.warn('[api/generate] serpapi fallback failed', err);
    return [];
  }
}

function normalizeHrefValue(url: string): string {
  return url.replace(/&amp;/g, '&').trim();
}

function buildUrlVariants(url: string): string[] {
  const normalized = normalizeHrefValue(url);
  if (!normalized) {
    return [];
  }

  const variants = new Set<string>();
  const addVariant = (value: string | null | undefined) => {
    if (!value) {
      return;
    }
    variants.add(value);
    if (value.endsWith('/')) {
      variants.add(value.slice(0, -1));
    } else {
      variants.add(`${value}/`);
    }
  };

  const normalizePathname = (pathname: string): string => {
    if (!pathname) {
      return '/';
    }
    let result = pathname;
    if (!result.startsWith('/')) {
      result = `/${result}`;
    }
    while (result.length > 1 && result.endsWith('/')) {
      result = result.slice(0, -1);
    }
    return result || '/';
  };

  const addHostPathVariants = (urlObj: URL) => {
    const hostname = urlObj.hostname.toLowerCase();
    if (!hostname) {
      return;
    }
    const normalizedPath = normalizePathname(urlObj.pathname);
    const hostVariants = new Set<string>([hostname]);
    if (hostname.startsWith('www.')) {
      hostVariants.add(hostname.slice(4));
    } else {
      hostVariants.add(`www.${hostname}`);
    }
    for (const host of hostVariants) {
      if (!host) {
        continue;
      }
      variants.add(`hostpath:${host}${normalizedPath}`);
    }
  };

  const globalObj = globalThis as {
    Buffer?: { from(data: string, encoding: string): { toString(encoding: string): string } };
    atob?: (input: string) => string;
  };

  const decodeBase64 = (value: string): string | null => {
    if (!value) {
      return null;
    }
    const normalizedValue = value.replace(/-/g, '+').replace(/_/g, '/');
    const padding = (4 - (normalizedValue.length % 4 || 0)) % 4;
    const padded = normalizedValue.padEnd(normalizedValue.length + padding, '=');

    if (globalObj.Buffer) {
      try {
        return globalObj.Buffer.from(padded, 'base64').toString('utf8');
      } catch {
        // Ignore decoding errors.
      }
    }

    if (typeof globalObj.atob === 'function') {
      try {
        const binary = globalObj.atob(padded);
        let result = '';
        for (let i = 0; i < binary.length; i += 1) {
          result += String.fromCharCode(binary.charCodeAt(i));
        }
        return result;
      } catch {
        // Ignore decoding errors.
      }
    }

    return null;
  };

  const tryParseUrl = (value: string | null | undefined): URL | null => {
    if (!value) {
      return null;
    }
    try {
      return new URL(value);
    } catch {
      return null;
    }
  };

  const resolveRedirectTarget = (urlObj: URL): URL | null => {
    const hostname = urlObj.hostname.toLowerCase();
    if (!hostname) {
      return null;
    }

    if (hostname === 'news.google.com') {
      const paramTarget = tryParseUrl(urlObj.searchParams.get('url') || urlObj.searchParams.get('u'));
      if (paramTarget) {
        return paramTarget;
      }

      const segments = urlObj.pathname.split('/');
      for (let i = segments.length - 1; i >= 0; i -= 1) {
        const segment = segments[i];
        if (!segment) {
          continue;
        }
        const decoded = decodeBase64(segment);
        if (!decoded) {
          continue;
        }
        const match = decoded.match(/https?:\/\/[^\s"'<>]+/i);
        if (match) {
          const candidate = tryParseUrl(match[0]);
          if (candidate) {
            return candidate;
          }
        }
      }
    }

    if (hostname === 'www.google.com' && urlObj.pathname === '/url') {
      const paramTarget = tryParseUrl(urlObj.searchParams.get('url') || urlObj.searchParams.get('q'));
      if (paramTarget) {
        return paramTarget;
      }
    }

    return null;
  };

  addVariant(normalized);

  try {
    const initial = new URL(normalized);
    const seen = new Set<string>();
    const queue: URL[] = [];

    const enqueue = (candidate: URL) => {
      candidate.hash = '';
      const key = candidate.toString();
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      queue.push(candidate);
    };

    enqueue(initial);

    while (queue.length) {
      const current = queue.pop()!;
      const currentString = current.toString();
      addVariant(currentString);
      addHostPathVariants(current);

      const redirectTarget = resolveRedirectTarget(current);
      if (redirectTarget) {
        enqueue(redirectTarget);
      }

      if (current.search) {
        const withoutQuery = new URL(currentString);
        withoutQuery.search = '';
        enqueue(withoutQuery);
      }

      const hostnames = new Set<string>();
      if (current.hostname) {
        hostnames.add(current.hostname);
        if (current.hostname.startsWith('www.')) {
          hostnames.add(current.hostname.slice(4));
        } else {
          hostnames.add(`www.${current.hostname}`);
        }
      }

      const protocols = new Set<string>();
      if (current.protocol) {
        protocols.add(current.protocol);
        if (current.protocol === 'https:') {
          protocols.add('http:');
        } else if (current.protocol === 'http:') {
          protocols.add('https:');
        }
      }

      for (const hostname of hostnames) {
        if (!hostname) {
          continue;
        }
        for (const protocol of protocols) {
          if (!protocol) {
            continue;
          }
          const variantUrl = new URL(currentString);
          variantUrl.hostname = hostname;
          variantUrl.protocol = protocol;
          enqueue(variantUrl);
        }
      }
    }
  } catch {
    // Ignore malformed URLs that cannot be parsed.
  }

  return Array.from(variants);
}

function cleanModelOutput(raw: string | null | undefined): string {
  return (raw || '')
    .replace(/^```(?:html)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
}

function findMissingSources(content: string, sources: string[]): string[] {
  if (!sources.length) {
    return [];
  }

  const cited = new Set<string>();
  const anchorRegex = /<a\s+[^>]*href\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(content)) !== null) {
    const href = match[1];
    for (const variant of buildUrlVariants(href)) {
      if (variant) {
        cited.add(variant);
      }
    }
  }

  const missing: string[] = [];
  for (const source of sources) {
    if (!source) {
      continue;
    }
    let found = false;
    for (const variant of buildUrlVariants(source)) {
      if (variant && cited.has(variant)) {
        found = true;
        break;
      }
    }
    if (!found) {
      missing.push(source);
    }
  }

  return missing;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripHtmlTags(value: string): string {
  if (!value) {
    return '';
  }
  return value.replace(/<[^>]*>/g, ' ');
}

function countWordsFromHtml(html: string): number {
  if (!html) {
    return 0;
  }
  const withoutTags = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(nbsp|#160);/gi, ' ');
  const normalized = withoutTags.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 0;
  }
  return normalized.split(' ').length;
}

interface SourceContext {
  url: string;
  title?: string;
  summary?: string;
}

interface SectionStats {
  heading: string;
  start: number;
  end: number;
  paragraphCount: number;
  wordCount: number;
}

interface ArticleStructure {
  intro: {
    paragraphCount: number;
    wordCount: number;
  };
  sections: SectionStats[];
}

const MIN_PARAGRAPHS_PER_SECTION = 2;
const UNDER_DEVELOPED_WORD_THRESHOLD = 120;

function analyzeArticleStructure(html: string): ArticleStructure {
  const headingRegex = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  const matches: Array<{ heading: string; index: number; endOfHeading: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = headingRegex.exec(html)) !== null) {
    const headingHtml = match[1] ?? '';
    const headingText = stripHtmlTags(headingHtml).replace(/\s+/g, ' ').trim();
    matches.push({
      heading: headingText,
      index: match.index,
      endOfHeading: match.index + match[0].length,
    });
  }

  const firstHeadingIndex = matches.length > 0 ? matches[0].index : html.length;
  const introHtml = html.slice(0, firstHeadingIndex);
  const introParagraphCount = (introHtml.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) ?? []).length;
  const introWordCount = countWordsFromHtml(introHtml);

  const sections: SectionStats[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i];
    const nextStart = i + 1 < matches.length ? matches[i + 1].index : html.length;
    const sectionHtml = html.slice(current.endOfHeading, nextStart);
    const paragraphCount = (sectionHtml.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) ?? []).length;
    const wordCount = countWordsFromHtml(sectionHtml);
    sections.push({
      heading: current.heading,
      start: current.endOfHeading,
      end: nextStart,
      paragraphCount,
      wordCount,
    });
  }

  return {
    intro: {
      paragraphCount: introParagraphCount,
      wordCount: introWordCount,
    },
    sections,
  };
}

interface SectionExpansion {
  heading: string;
  html: string;
}

function parseExpansionResponse(raw: string): SectionExpansion[] {
  if (!raw) {
    return [];
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return [];
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed || !Array.isArray(parsed.expansions)) {
      return [];
    }

    return parsed.expansions
      .map((entry: any) => {
        if (!entry) {
          return null;
        }
        const heading = typeof entry.heading === 'string' ? entry.heading.trim() : '';
        const html = typeof entry.html === 'string' ? entry.html.trim() : '';
        if (!heading || !html) {
          return null;
        }
        return { heading, html } as SectionExpansion;
      })
      .filter((entry: SectionExpansion | null): entry is SectionExpansion => Boolean(entry));
  } catch {
    return [];
  }
}

function applySectionExpansions(
  originalContent: string,
  expansions: SectionExpansion[]
): string {
  let content = originalContent;

  for (const expansion of expansions) {
    const addition = expansion.html?.trim();
    const heading = expansion.heading?.trim();
    if (!addition || !heading) {
      continue;
    }

    if (heading === '__INTRO__') {
      const firstHeadingMatch = content.match(/<h2[^>]*>/i);
      const insertIndex = firstHeadingMatch?.index ?? content.length;
      const before = content.slice(0, insertIndex);
      const after = content.slice(insertIndex);
      const joiner = before.endsWith('\n') || addition.startsWith('<') ? '' : '\n';
      content = `${before}${joiner}${addition}${after}`;
      continue;
    }

    const structure = analyzeArticleStructure(content);
    const normalizedTarget = heading.replace(/\s+/g, ' ').trim().toLowerCase();
    const targetSection = structure.sections.find(
      (section) => section.heading.replace(/\s+/g, ' ').trim().toLowerCase() === normalizedTarget
    );

    if (!targetSection) {
      const joiner = content.endsWith('\n') || addition.startsWith('<') ? '' : '\n';
      content = `${content}${joiner}${addition}`;
      continue;
    }

    const before = content.slice(0, targetSection.end);
    const after = content.slice(targetSection.end);
    const joiner = before.endsWith('\n') || addition.startsWith('<') ? '' : '\n';
    content = `${before}${joiner}${addition}${after}`;
  }

  return content;
}

interface KeywordEntry {
  value: string;
  isExact: boolean;
}

const FALLBACK_STOPWORDS = new Set<string>([
  'a',
  'an',
  'and',
  'or',
  'but',
  'if',
  'nor',
  'for',
  'so',
  'yet',
  'the',
  'of',
  'in',
  'on',
  'to',
  'with',
  'by',
  'as',
  'at',
  'from',
  'into',
  'about',
  'after',
  'before',
  'during',
  'while',
  'since',
  'until',
  'amid',
  'among',
  'between',
  'across',
  'around',
  'because',
  'that',
  'this',
  'those',
  'these',
  'their',
  'his',
  'her',
  'its',
  'our',
  'your',
  'my',
  'mine',
  'ours',
  'yours',
  'them',
  'they',
  'are',
  'is',
  'was',
  'were',
  'be',
  'being',
  'been',
  'has',
  'have',
  'had',
  'do',
  'does',
  'did',
  'not',
  'no',
  'it',
  'he',
  'she',
  'we',
  'you',
  'i',
  'me',
  'him',
  'her',
  'than',
  'then',
  'over',
  'under',
  'per',
  'via',
  'through',
  'toward',
  'towards',
]);

// Generate article content and ensure a minimum number of links are present
// prompt   - text prompt to send to the model
// model    - model name to use
// sources  - list of source URLs that may be linked
// minLinks - minimum number of <a href> links required in the output
async function generateWithLinks(
  prompt: string,
  model: string,
  sources: string[],
  systemPrompt?: string,
  minLinks: number = MIN_LINKS,
  maxTokens = 2000,
  minWords = 0,
  contextualSources: SourceContext[] = [],
  strictLinking = true,
  lengthRetryCount = 0
): Promise<string> {
  const limit = MODEL_CONTEXT_LIMITS[model] || 8000;
  const requiredCount = Math.min(Math.max(MIN_LINKS, sources.length), 5);
  const requiredSources = sources.slice(0, requiredCount);
  const trimmedPrompt = prompt.trim();
  let augmentedPrompt = trimmedPrompt;
  let reminderList: string | null = null;
  if (requiredSources.length > 0) {
    reminderList = requiredSources
      .map((source, index) => `${index + 1}. ${source}`)
      .join('\n');
    const totalLinksNeeded = Math.max(minLinks, requiredSources.length);
    augmentedPrompt = `${trimmedPrompt}\n\nCite every required source inside natural sentences exactly once. Include at least ${totalLinksNeeded} total hyperlinks and do not fabricate extra citations.\nRequired sources (one citation per URL):\n${reminderList}`;
  }

  const estimateTokens = (text: string) => Math.ceil(text.length / 4);
  const promptLengthTokens = estimateTokens(augmentedPrompt);
  const systemPromptTokens = systemPrompt ? estimateTokens(systemPrompt) : 0;
  const expectedFromWords = minWords > 0 ? Math.ceil(minWords * 1.6) : 0;
  const baseBudget = Math.max(maxTokens, expectedFromWords, promptLengthTokens * 2, 800);
  const availableContext = Math.max(limit - promptLengthTokens - systemPromptTokens, 0);
  const safetyAdjustedBudget = Math.max(
    availableContext - COMPLETION_SAFETY_MARGIN_TOKENS,
    0
  );
  const maxCompletionTokens = Math.max(
    safetyAdjustedBudget,
    availableContext > 0 ? Math.min(availableContext, 1) : 0
  );
  let tokens = Math.min(baseBudget, maxCompletionTokens);
  if (tokens <= 0 && availableContext > 0) {
    tokens = Math.min(baseBudget, availableContext);
    tokens = Math.max(tokens, 1);
  }
  if (tokens <= 0 && availableContext === 0) {
    throw new Error('Prompt exceeds the model context limit.');
  }
  const buildMessages = (content: string) =>
    systemPrompt
      ? [
          { role: 'system' as const, content: systemPrompt },
          { role: 'user' as const, content },
        ]
      : [{ role: 'user' as const, content }];

  const openai = getOpenAI();
  let baseRes = await openai.chat.completions.create({
    model,
    messages: buildMessages(augmentedPrompt),
    temperature: FACTUAL_TEMPERATURE,
    max_tokens: tokens,
  });

  // If the response was cut off due to max_tokens, retry once with more room
  if (baseRes.choices[0]?.finish_reason === 'length') {
    const retryBudget = Math.max(maxCompletionTokens, tokens);
    if (retryBudget > tokens) {
      tokens = retryBudget;
      baseRes = await openai.chat.completions.create({
        model,
        messages: buildMessages(augmentedPrompt),
        temperature: FACTUAL_TEMPERATURE,
        max_tokens: tokens,
      });
    }
  }

  let content = cleanModelOutput(baseRes.choices[0]?.message?.content) || '';

  let linkCount = content.match(/<a\s+href=/gi)?.length || 0;

  const runLinkAndCitationRepair = async () => {
    linkCount = content.match(/<a\s+href=/gi)?.length || 0;

    if (requiredSources.length === 0) {
      return;
    }

    let missingSources = new Set(findMissingSources(content, requiredSources));
    const MAX_LINKS = 5;

    if (missingSources.size > 0) {
      const containerRegex = /<(p|li)(\b[^>]*)>([\s\S]*?)<\/\1>/gi;
      const containers: {
        start: number;
        end: number;
        tag: string;
        attrs: string;
        inner: string;
      }[] = [];

      let match: RegExpExecArray | null;
      while ((match = containerRegex.exec(content)) !== null) {
        containers.push({
          start: match.index,
          end: match.index + match[0].length,
          tag: match[1],
          attrs: match[2] ?? '',
          inner: match[3] ?? '',
        });
      }

      if (containers.length === 0) {
        containers.push({
          start: 0,
          end: content.length,
          tag: '',
          attrs: '',
          inner: content,
        });
      }

      const contextByUrl = new Map<string, SourceContext>();
      for (const item of contextualSources) {
        if (!item?.url || contextByUrl.has(item.url)) {
          continue;
        }
        contextByUrl.set(item.url, item);
      }

      const keywordCache = new Map<string, KeywordEntry[]>();
      const wordCharRegex = /[\p{L}\p{N}'’\-]/u;

      const deriveKeywordsFor = (url: string): KeywordEntry[] => {
        if (keywordCache.has(url)) {
          return keywordCache.get(url)!;
        }
        const context = contextByUrl.get(url);
        const exactKeywords: KeywordEntry[] = [];
        const fuzzyKeywords: KeywordEntry[] = [];
        const seen = new Map<string, boolean>();

        const addKeyword = (value: string, isExact: boolean) => {
          const trimmed = value.replace(/\s+/g, ' ').trim();
          if (!trimmed || trimmed.length > 120) {
            return;
          }
          const normalized = trimmed.toLowerCase();
          const existing = seen.get(normalized);
          if (existing === true) {
            return;
          }
          if (existing === false) {
            if (!isExact) {
              return;
            }
            const index = fuzzyKeywords.findIndex(
              (entry) => entry.value.toLowerCase() === normalized
            );
            if (index !== -1) {
              fuzzyKeywords.splice(index, 1);
            }
          }

          seen.set(normalized, isExact);
          const bucket = isExact ? exactKeywords : fuzzyKeywords;
          bucket.push({ value: trimmed, isExact });
        };

        const rawTitle = context?.title?.replace(/\s+/g, ' ').trim();
        if (rawTitle) {
          addKeyword(rawTitle, true);
          const normalized = normalizeTitleValue(rawTitle);
          if (normalized) {
            const words = normalized.split(' ').filter((word) => word);
            for (let size = Math.min(4, words.length); size >= 2; size -= 1) {
              for (let i = 0; i <= words.length - size; i += 1) {
                const slice = words.slice(i, i + size);
                if (slice.every((word) => FALLBACK_STOPWORDS.has(word))) {
                  continue;
                }
                if (slice.some((word) => word.length > 3)) {
                  addKeyword(slice.join(' '), false);
                }
              }
            }
            const filtered = words.filter((word) => !FALLBACK_STOPWORDS.has(word));
            for (const word of filtered) {
              if (word.length > 2) {
                addKeyword(word, false);
              }
            }
          }

          const delimiterParts = rawTitle
            .split(/[–—|:]+/)
            .map((part) => part.trim())
            .filter(Boolean);
          for (const part of delimiterParts) {
            if (/[A-Za-z0-9]/.test(part)) {
              addKeyword(part, true);
            }
          }

          const capitalizedMatches = rawTitle.match(
            /\b([A-Z][A-Za-z0-9&'’\-]*(?:\s+[A-Z][A-Za-z0-9&'’\-]*)*)\b/g
          );
          if (capitalizedMatches) {
            for (const phrase of capitalizedMatches) {
              addKeyword(phrase, true);
            }
          }
        }

        const summary = context?.summary?.replace(/\s+/g, ' ').trim();
        if (summary) {
          const capitalizedMatches = summary.match(
            /\b([A-Z][A-Za-z0-9&'’\-]*(?:\s+[A-Z][A-Za-z0-9&'’\-]*)*)\b/g
          );
          if (capitalizedMatches) {
            for (const phrase of capitalizedMatches.slice(0, 6)) {
              addKeyword(phrase, true);
            }
          }
        }

        try {
          const host = new URL(url).hostname.replace(/^www\./i, '');
          if (host) {
            addKeyword(host, false);
            const parts = host.split('.');
            if (parts.length > 1) {
              addKeyword(parts.slice(0, -1).join(' '), false);
            }
            const primary = parts[0];
            if (primary) {
              addKeyword(primary.replace(/[-_]+/g, ' '), false);
            }
          }
        } catch {
          // Ignore invalid URLs
        }

        const combined = [...exactKeywords, ...fuzzyKeywords];
        keywordCache.set(url, combined);
        return combined;
      };

      const collectSegments = (html: string) => {
        const segments: { text: string; start: number; end: number }[] = [];
        let index = 0;
        let anchorDepth = 0;
        while (index < html.length) {
          if (html[index] === '<') {
            const closeIndex = html.indexOf('>', index + 1);
            if (closeIndex === -1) {
              break;
            }
            const rawTag = html.slice(index + 1, closeIndex).trim();
            const isClosing = rawTag.startsWith('/');
            const tagName = rawTag
              .replace(/^\//, '')
              .replace(/\s+[\s\S]*$/, '')
              .toLowerCase();
            if (!isClosing && tagName === 'a') {
              anchorDepth += 1;
            } else if (isClosing && tagName === 'a' && anchorDepth > 0) {
              anchorDepth -= 1;
            }
            index = closeIndex + 1;
            continue;
          }
          const start = index;
          while (index < html.length && html[index] !== '<') {
            index += 1;
          }
          if (anchorDepth === 0 && start < index) {
            segments.push({ text: html.slice(start, index), start, end: index });
          }
        }
        return segments;
      };

      const findKeywordMatch = (html: string, keywords: KeywordEntry[]) => {
        const segments = collectSegments(html);
        if (!segments.length) {
          return null;
        }
        const prioritized = [
          ...keywords.filter((entry) => entry.isExact),
          ...keywords.filter((entry) => !entry.isExact),
        ];
        for (const keyword of prioritized) {
          const target = keyword.value.trim();
          if (!target) {
            continue;
          }
          const searchTarget = keyword.isExact ? target : target.toLowerCase();
          for (const segment of segments) {
            const haystack = keyword.isExact
              ? segment.text
              : segment.text.toLowerCase();
            let searchIndex = 0;
            while (searchIndex <= haystack.length) {
              const foundIndex = haystack.indexOf(searchTarget, searchIndex);
              if (foundIndex === -1) {
                break;
              }
              const beforeChar = segment.text[foundIndex - 1];
              const afterChar = segment.text[foundIndex + target.length];
              const hasBefore = beforeChar ? wordCharRegex.test(beforeChar) : false;
              const hasAfter = afterChar ? wordCharRegex.test(afterChar) : false;
              if (!hasBefore && !hasAfter) {
                return {
                  start: segment.start + foundIndex,
                  end: segment.start + foundIndex + target.length,
                };
              }
              searchIndex = foundIndex + 1;
            }
          }
        }
        return null;
      };

      const findFallbackMatch = (html: string) => {
        const segments = collectSegments(html);
        let firstTextRange: { start: number; end: number } | null = null;
        for (const segment of segments) {
          const regex = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;
          let match: RegExpExecArray | null;
          while ((match = regex.exec(segment.text)) !== null) {
            const word = match[0];
            if (word.length < 3) {
              continue;
            }
            if (FALLBACK_STOPWORDS.has(word.toLowerCase())) {
              continue;
            }
            return {
              start: segment.start + match.index,
              end: segment.start + match.index + word.length,
            };
          }
          if (!firstTextRange) {
            const trimmed = segment.text.replace(/^\s+/, '');
            if (trimmed) {
              const leadingWhitespaceLength = segment.text.length - trimmed.length;
              firstTextRange = {
                start: segment.start + leadingWhitespaceLength,
                end: segment.start + leadingWhitespaceLength + trimmed.length,
              };
            }
          }
        }
        return firstTextRange;
      };

      const wrapRange = (html: string, range: { start: number; end: number }, safeUrl: string) => {
        const anchorStart = `<a href="${safeUrl}" target="_blank" rel="noopener">`;
        const anchorEnd = '</a>';
        return (
          html.slice(0, range.start) +
          anchorStart +
          html.slice(range.start, range.end) +
          anchorEnd +
          html.slice(range.end)
        );
      };

      const missingQueue = requiredSources.filter((source) => missingSources.has(source));
      let containerIndex = 0;
      let modified = false;

      for (const source of missingQueue) {
        if (!missingSources.has(source) || linkCount >= MAX_LINKS) {
          continue;
        }
        const safeUrl = escapeHtml(source);
        const keywords = deriveKeywordsFor(source);
        const containerCount = containers.length;
        let inserted = false;

        for (let offset = 0; offset < containerCount; offset += 1) {
          const container = containers[(containerIndex + offset) % containerCount];
          const matchRange = findKeywordMatch(container.inner, keywords);
          if (matchRange) {
            container.inner = wrapRange(container.inner, matchRange, safeUrl);
            missingSources.delete(source);
            linkCount += 1;
            containerIndex = (containerIndex + offset + 1) % containerCount;
            inserted = true;
            modified = true;
            break;
          }
        }

        if (!inserted) {
          for (let offset = 0; offset < containers.length; offset += 1) {
            const container = containers[(containerIndex + offset) % containers.length];
            const fallbackRange = findFallbackMatch(container.inner);
            if (fallbackRange) {
              container.inner = wrapRange(container.inner, fallbackRange, safeUrl);
              missingSources.delete(source);
              linkCount += 1;
              containerIndex = (containerIndex + offset + 1) % containers.length;
              inserted = true;
              modified = true;
              break;
            }
          }
        }

        if (linkCount >= MAX_LINKS) {
          break;
        }
      }

      if (modified) {
        let rebuilt = '';
        let lastIndex = 0;
        for (const container of containers) {
          rebuilt += content.slice(lastIndex, container.start);
          if (container.tag) {
            rebuilt += `<${container.tag}${container.attrs}>${container.inner}</${container.tag}>`;
          } else {
            rebuilt += container.inner;
          }
          lastIndex = container.end;
        }
        rebuilt += content.slice(lastIndex);
        content = rebuilt;
      }
    }

    if (
      strictLinking &&
      missingSources.size > STRICT_LINK_RETRY_THRESHOLD &&
      requiredSources.length > 0
    ) {
      const contextByUrl = new Map<string, SourceContext>();
      for (const item of contextualSources) {
        if (!item?.url || contextByUrl.has(item.url)) {
          continue;
        }
        contextByUrl.set(item.url, item);
      }

      const missingList = requiredSources.filter((source) =>
        missingSources.has(source)
      );
      if (missingList.length > 0) {
        const summaryList = missingList
          .map((url, index) => {
            const context = contextByUrl.get(url);
            const parts = [`${index + 1}. ${url}`];
            if (context?.title) {
              parts.push(`Title: ${context.title}`);
            }
            if (context?.summary) {
              parts.push(`Summary: ${context.summary}`);
            }
            return parts.join('\n');
          })
          .join('\n\n');

        const paragraphLabel =
          missingList.length === 1 ? 'paragraph' : 'paragraphs';
        const repairLines = [
          `Write ${missingList.length} concise HTML ${paragraphLabel} that can be appended to an article.`,
          'Each paragraph must naturally cite the matching source exactly once using descriptive anchor text and must not include any other links.',
          'Keep each paragraph to two sentences or fewer.',
        ];
        if (summaryList) {
          repairLines.push('', summaryList);
        }
        const repairPrompt = repairLines.join('\n');

        let repairTokens = Math.min(
          Math.max(400, Math.ceil(missingList.length * 220)),
          limit
        );
        let retryRes = await openai.chat.completions.create({
          model,
          messages: buildMessages(repairPrompt),
          temperature: FACTUAL_TEMPERATURE,
          max_tokens: repairTokens,
        });

        if (
          retryRes.choices[0]?.finish_reason === 'length' &&
          repairTokens < limit
        ) {
          repairTokens = limit;
          retryRes = await openai.chat.completions.create({
            model,
            messages: buildMessages(repairPrompt),
            temperature: FACTUAL_TEMPERATURE,
            max_tokens: repairTokens,
          });
        }

        const repairContent = cleanModelOutput(
          retryRes.choices[0]?.message?.content
        );
        if (repairContent) {
          const trimmed = repairContent.trim();
          const joiner = trimmed.startsWith('<') ? '' : '\n';
          content = `${content}${joiner}${trimmed}`;
        }
        linkCount = content.match(/<a\s+href=/gi)?.length || 0;
        missingSources = new Set(findMissingSources(content, requiredSources));
      }
    }
  };

  await runLinkAndCitationRepair();

  if (minWords > 0) {
    let wordCount = countWordsFromHtml(content);
    let attempts = lengthRetryCount;
    const maxAttempts = Math.max(0, LENGTH_EXPANSION_ATTEMPTS - 1);

    while (wordCount < minWords && attempts < maxAttempts) {
      const structure = analyzeArticleStructure(content);
      const underDeveloped = structure.sections.filter(
        (section) =>
          section.paragraphCount < MIN_PARAGRAPHS_PER_SECTION ||
          section.wordCount < UNDER_DEVELOPED_WORD_THRESHOLD
      );

      const underDevelopedSummary = underDeveloped.length
        ? underDeveloped
            .map(
              (section) =>
                `- "${section.heading || 'Untitled section'}": ${section.paragraphCount} paragraphs / ${section.wordCount} words`
            )
            .join('\n')
        : '- No <h2> sections met the under-developed threshold; add grounded detail where it best strengthens the reporting.';

      const promptSections = [
        'You are refining an existing article so it meets its required length without changing tone or structure.',
        '',
        `Minimum words: ${minWords}. Current words: ${wordCount}.`,
        '',
        'Sections needing more depth (fewer than 2 paragraphs or under 120 words):',
        underDevelopedSummary,
        '',
        'Current article HTML (do not rewrite existing sentences; only add new grounded paragraphs that belong in the listed sections):',
        content.trim(),
        '',
        'Instructions:',
        '- Append new paragraphs that expand the highlighted sections with concrete, source-grounded facts.',
        '- Preserve the current tone, point of view, and hyperlink formatting.',
        '- Do not repeat or delete existing material.',
        '- Reuse the existing source URLs; do not invent new links.',
        '- Return valid JSON exactly matching {"expansions":[{"heading":"Existing <h2> text or __INTRO__","html":"<p>...</p>"}]} with double quotes.',
        '- Only include entries for sections that actually receive new content.',
        '- Ensure the appended paragraphs will bring the article above the minimum word count.'
      ];

      if (reminderList) {
        promptSections.push(
          '',
          'Required sources (keep cited exactly once each):',
          reminderList
        );
      }

      const expansionPrompt = promptSections.join('\n');
      let expansionTokens = Math.min(
        Math.max(600, Math.ceil(Math.max(0, minWords - wordCount) * 2)),
        limit
      );

      let expansionRes = await openai.chat.completions.create({
        model,
        messages: buildMessages(expansionPrompt),
        temperature: FACTUAL_TEMPERATURE,
        max_tokens: expansionTokens,
      });

      if (
        expansionRes.choices[0]?.finish_reason === 'length' &&
        expansionTokens < limit
      ) {
        expansionTokens = limit;
        expansionRes = await openai.chat.completions.create({
          model,
          messages: buildMessages(expansionPrompt),
          temperature: FACTUAL_TEMPERATURE,
          max_tokens: expansionTokens,
        });
      }

      const expansionContent = cleanModelOutput(
        expansionRes.choices[0]?.message?.content
      )?.trim();
      const expansions = parseExpansionResponse(expansionContent || '');

      if (expansions.length === 0) {
        if (expansionContent) {
          const joiner = expansionContent.startsWith('<') ? '' : '\n';
          content = `${content}${joiner}${expansionContent}`;
          await runLinkAndCitationRepair();
          wordCount = countWordsFromHtml(content);
          attempts += 1;
          continue;
        }
        break;
      }

      const updatedContent = applySectionExpansions(content, expansions);
      if (updatedContent === content) {
        break;
      }

      content = updatedContent;
      await runLinkAndCitationRepair();
      wordCount = countWordsFromHtml(content);
      attempts += 1;
    }
  }

  return content;
}

interface VerificationResult {
  isAccurate: boolean;
  discrepancies: string[];
  themeCoverageIssue?: ThemeCoverageIssue | null;
}

interface VerifyOutputOptions {
  themeLabel?: string | null;
  themeCoverageThreshold?: number;
}

function truncateField(value: string | null | undefined): string {
  if (!value) {
    return '';
  }
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= VERIFICATION_MAX_SOURCE_FIELD_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, VERIFICATION_MAX_SOURCE_FIELD_LENGTH - 1)}…`;
}

function normalizeVerificationSources(
  sources: VerificationSource[]
): Array<{ url: string; title?: string; summary?: string; publishedAt?: string }> {
  const seen = new Set<string>();
  const normalized: Array<{
    url: string;
    title?: string;
    summary?: string;
    publishedAt?: string;
  }> = [];

  for (const source of sources) {
    if (normalized.length >= VERIFICATION_MAX_SOURCES) {
      break;
    }

    let url: string | undefined;
    let title: string | undefined;
    let summary: string | undefined;
    let publishedAt: string | undefined;

    if (typeof source === 'string') {
      url = source;
    } else if (source) {
      url = source.url ?? undefined;
      title = source.title ?? undefined;
      summary = source.summary ?? undefined;
      publishedAt = source.publishedAt ?? undefined;
    }

    const trimmedUrl = url?.trim();
    if (!trimmedUrl) {
      continue;
    }

    const normalizedUrl = trimmedUrl.replace(/\s+/g, ' ');
    if (seen.has(normalizedUrl)) {
      continue;
    }

    seen.add(normalizedUrl);
    normalized.push({
      url: normalizedUrl,
      title,
      summary,
      publishedAt,
    });
  }

  return normalized;
}

function isRetriableOpenAIError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const status = (err as { status?: number }).status;
    if (typeof status === 'number') {
      return status >= 500 && status < 600;
    }
  }

  if (!(err instanceof Error)) {
    return false;
  }

  const match = err.message.match(/status\s+(\d{3})/i);
  if (!match) {
    return false;
  }
  const status = Number.parseInt(match[1], 10);
  return Number.isFinite(status) && status >= 500 && status < 600;
}

async function runOpenAIVerificationWithRetry(prompt: string): Promise<string> {
  const openai = getOpenAI();
  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VERIFICATION_TIMEOUT_MS);

    try {
      const response = await openai.chat.completions.create(
        {
          model: VERIFICATION_MODEL,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }],
        },
        { signal: controller.signal }
      );

      clearTimeout(timeout);

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) {
        throw new Error('Verification response contained no content');
      }
      return content;
    } catch (err) {
      clearTimeout(timeout);
      lastError = err;
      if (attempt < 2 && isRetriableOpenAIError(err)) {
        console.warn('[api/generate] verification attempt failed, retrying', err);
        continue;
      }
      throw err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('OpenAI verification failed unexpectedly');
}

async function verifyOutput(
  content: string,
  sources: VerificationSource[],
  options: VerifyOutputOptions = {}
): Promise<VerificationResult> {
  const trimmedContent = content?.trim();
  if (!trimmedContent) {
    return { isAccurate: true, discrepancies: [], themeCoverageIssue: null };
  }

  const themeLabel = options.themeLabel?.trim();
  const themeThreshold =
    typeof options.themeCoverageThreshold === 'number'
      ? resolveThemeThreshold(options.themeCoverageThreshold)
      : THEME_COVERAGE_THRESHOLD;
  const themeCoverageIssue = themeLabel
    ? validateThemeCoverage(trimmedContent, themeLabel, {
        threshold: themeThreshold,
      })
    : null;

  const normalizedSources = normalizeVerificationSources(sources);
  const shouldRunAccuracyCheck =
    Boolean(process.env.OPENAI_API_KEY) && normalizedSources.length > 0;

  if (!shouldRunAccuracyCheck) {
    if (themeCoverageIssue) {
      console.warn('Theme coverage issue detected:', themeCoverageIssue);
      return {
        isAccurate: false,
        discrepancies: [formatThemeCoverageIssue(themeCoverageIssue)],
        themeCoverageIssue,
      };
    }
    return { isAccurate: true, discrepancies: [], themeCoverageIssue: null };
  }

  const formattedSources = normalizedSources
    .map((item, index) => {
      const parts = [`${index + 1}. URL: ${item.url}`];
      const title = truncateField(item.title);
      const summary = truncateField(item.summary);
      const publishedAt = truncateField(item.publishedAt);
      if (title) {
        parts.push(`   Title: ${title}`);
      }
      if (summary) {
        parts.push(`   Summary: ${summary}`);
      }
      if (publishedAt) {
        parts.push(`   Published: ${publishedAt}`);
      }
      return parts.join('\n');
    })
    .join('\n');

  const prompt = [
    'Check if this article matches sources; list discrepancies.',
    '',
    'You are a post-generation fact-checking assistant. Compare the article HTML to the provided sources and highlight any unsupported or contradictory claims.',
    'Respond with JSON using this schema: {"discrepancies":[{"description":string,"severity":"minor"|"major"|"critical"}]}.',
    'Only include discrepancies that materially change the accuracy of the piece. Ignore nitpicks, emphasis changes, or speculative language.',
    'Reserve "critical" severity for issues that would seriously mislead the reader about the core facts. Use "major" for notable but non-critical gaps and "minor" for everything else.',
    '',
    'Article HTML:',
    trimmedContent,
    '',
    'Sources:',
    formattedSources || 'No sources provided.',
  ].join('\n');

  try {
    const response = await runOpenAIVerificationWithRetry(prompt);
    let parsed: any;
    try {
      parsed = JSON.parse(response);
    } catch {
      const match = response.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      }
    }

    if (!parsed || !Array.isArray(parsed.discrepancies)) {
      if (themeCoverageIssue) {
        console.warn('Theme coverage issue detected:', themeCoverageIssue);
        return {
          isAccurate: false,
          discrepancies: [formatThemeCoverageIssue(themeCoverageIssue)],
          themeCoverageIssue,
        };
      }
      return { isAccurate: true, discrepancies: [], themeCoverageIssue: null };
    }

    const normalizedDiscrepancies = parsed.discrepancies
      .map((item: any) => {
        if (!item) {
          return null;
        }
        if (typeof item === 'string') {
          return { description: item.trim(), severity: 'critical' };
        }
        if (typeof item === 'object') {
          const description = typeof item.description === 'string' ? item.description.trim() : '';
          if (!description) {
            return null;
          }
          const severity = typeof item.severity === 'string' ? item.severity.toLowerCase() : 'critical';
          return { description, severity };
        }
        return null;
      })
      .filter((item: { description: string; severity: string } | null): item is {
        description: string;
        severity: string;
      } => Boolean(item && item.description));

    const criticalSeverities = new Set(['critical', 'blocker', 'must-fix']);
    const criticalIssues = normalizedDiscrepancies.filter((item) =>
      criticalSeverities.has((item.severity || '').toLowerCase())
    );

    const discrepancies: string[] = [];
    if (criticalIssues.length > VERIFICATION_DISCREPANCY_THRESHOLD) {
      const summaries = criticalIssues.map(
        (item) => `[${(item.severity || 'critical').toUpperCase()}] ${item.description}`
      );
      console.warn('Accuracy issues: ', summaries);
      discrepancies.push(...summaries);
    }

    if (themeCoverageIssue) {
      console.warn('Theme coverage issue detected:', themeCoverageIssue);
      discrepancies.push(formatThemeCoverageIssue(themeCoverageIssue));
    }

    if (discrepancies.length > 0) {
      return { isAccurate: false, discrepancies, themeCoverageIssue };
    }

    return { isAccurate: true, discrepancies: [], themeCoverageIssue: null };
  } catch (err) {
    console.warn('[api/generate] verification failed', err);
    if (themeCoverageIssue) {
      console.warn('Theme coverage issue detected:', themeCoverageIssue);
      return {
        isAccurate: false,
        discrepancies: [formatThemeCoverageIssue(themeCoverageIssue)],
        themeCoverageIssue,
      };
    }
    return { isAccurate: true, discrepancies: [], themeCoverageIssue: null };
  }
}

function applyVerificationIssuesToPrompt(basePrompt: string, issues?: string[]): string {
  if (!issues || issues.length === 0) {
    return basePrompt;
  }

  const normalizedIssues: string[] = [];
  const themeIssuesByLabel = new Map<string, ThemeCoverageIssue>();

  for (const raw of issues) {
    if (typeof raw !== 'string') {
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    const themeIssue = parseThemeCoverageIssue(trimmed);
    if (themeIssue) {
      if (!themeIssuesByLabel.has(themeIssue.themeLabel)) {
        themeIssuesByLabel.set(themeIssue.themeLabel, themeIssue);
        normalizedIssues.push(themeIssue.message);
      }
      continue;
    }
    normalizedIssues.push(trimmed.replace(/\s+/g, ' ').trim());
  }

  if (normalizedIssues.length === 0) {
    return basePrompt;
  }

  const formattedIssues = normalizedIssues
    .map((issue, index) => `${index + 1}. ${issue}`)
    .join('\n');

  let revisedPrompt = `${basePrompt}\n\nThe previous draft was flagged for critical issues:\n${formattedIssues}\nRevise the article to resolve every issue without introducing new errors. Only output the corrected HTML article.`;

  if (themeIssuesByLabel.size > 0) {
    const reinforcement = Array.from(themeIssuesByLabel.values())
      .map((issue) => {
        const targetPercent = Math.round(issue.threshold * 100);
        return `- Elevate the coverage for "${issue.themeLabel}" with concrete, cited details until roughly ${targetPercent}% of the sentences or word count focus on that theme. Avoid generic references; weave specific attractions, activities, or facts tied to it.`;
      })
      .join('\n');
    revisedPrompt = `${revisedPrompt}\nEmphasize the thematic requirement(s):\n${reinforcement}`;
  }

  return revisedPrompt;
}


async function generateWithVerification(
  generator: (issues?: string[]) => Promise<string>,
  sources: VerificationSource[],
  fallbackSources: string[] = [],
  verificationOptions: VerifyOutputOptions = {}
): Promise<string> {
  const combinedSources = sources.length
    ? sources
    : fallbackSources.map((url) => ({ url }));
  const hasThemeCheck = Boolean(verificationOptions.themeLabel?.trim());
  const shouldVerify =
    (Boolean(process.env.OPENAI_API_KEY) && combinedSources.length > 0) ||
    hasThemeCheck;

  const initialContent = await generator();
  if (!shouldVerify) {
    return initialContent;
  }

  const verification = await verifyOutput(
    initialContent,
    combinedSources,
    verificationOptions
  );
  if (verification.isAccurate) {
    return initialContent;
  }

  const issues = Array.isArray(verification.discrepancies)
    ? verification.discrepancies.filter((item) => typeof item === 'string' && item.trim())
    : [];

  if (!issues.length) {
    return initialContent;
  }

  console.warn('Revising article once to resolve accuracy issues', issues);

  try {
    return await generator(issues);
  } catch (err) {
    console.warn('Revision attempt failed, returning initial article', err);
    return initialContent;
  }
}

export async function POST(request: Request) {
  try {
    const {
      articleType,
      title,
      listNumberingFormat,
      listItemWordCount = 100,
      toneOfVoice,
      customTone,
      pointOfView,
      customInstructions,
      lengthOption,
      customSections,
      modelVersion = 'gpt-4o-mini',
      useSerpApi = true,
      includeLinks = true,
    }: {
      articleType: string;
      title: string;
      listNumberingFormat?: string;
      listItemWordCount?: number;
      toneOfVoice?: string;
      customTone?: string;
      pointOfView?: string;
      customInstructions?: string;
      lengthOption?: string;
      customSections?: number;
      modelVersion?: string;
      useSerpApi?: boolean;
      includeLinks?: boolean;
    } = await request.json();

    if (!title?.trim()) {
      return NextResponse.json({ error: 'Missing title' }, { status: 400 });
    }

    const serpEnabled = includeLinks && useSerpApi && !!process.env.SERPAPI_KEY;
    const baseMaxTokens = calcMaxTokens(lengthOption, customSections, modelVersion);
    const nowIso = new Date().toISOString();
    const systemPrompt = `The current date and time is ${nowIso}. Treat the reporting summaries and source links supplied in prompts as authoritative context. Avoid introducing unsourced details or time-sensitive claims that are not confirmed by those references. If sources conflict, highlight both sides (e.g., "Source A reports X, while Source B claims Y"). When mentioning Donald Trump, understand that he is the current president of the United States.`;
    const toneChoice =
      toneOfVoice === 'Custom' && customTone ? customTone : toneOfVoice;
    const toneInstruction = toneChoice
      ? `- Write in a ${toneChoice} tone of voice.\n`
      : '';
    const povInstruction = pointOfView
      ? `- Use a ${pointOfView} perspective.\n`
      : '';

    if (articleType === 'News article') {
      const articles = await fetchNewsArticles(title, serpEnabled);
      if (!articles.length) {
        return NextResponse.json(
          {
            error:
              'No recent news on this topic. Adjust your topic, keywords, or timeframe to broaden the search for relevant reporting.',
            suggestion:
              'No recent news on this topic. Adjust your topic, keywords, or timeframe to broaden the search for relevant reporting.',
            code: 'NO_RECENT_SOURCES',
          },
          { status: 422 }
        );
      }

      const newsSources = Array.from(
        new Set(articles.map((item) => item.url).filter(Boolean))
      );
      const linkSources = includeLinks ? newsSources : [];
      const requiredLinks = includeLinks
        ? linkSources.slice(
            0,
            Math.min(Math.max(MIN_LINKS, linkSources.length), 5)
          )
        : [];
      const minLinks = includeLinks ? requiredLinks.length : 0;
      const optionalLinks = linkSources.slice(requiredLinks.length);
      const optionalInstruction = optionalLinks.length
        ? `\n  - You may also cite these optional sources if they add value:\n${optionalLinks
            .map((u) => `    - ${u}`)
            .join('\n')}`
        : '';
      const linkInstruction =
        includeLinks && requiredLinks.length
          ? `- Integrate clickable HTML links for at least the following required sources within relevant keywords or phrases.\n${requiredLinks
              .map((u) => `  - ${u}`)
              .join('\n')}\n  - Embed each required link as <a href="URL" target="_blank">text</a> exactly once and do not list them at the end.${optionalInstruction}\n  - Spread the links naturally across the article.`
          : '';

      const reportingBlock = buildRecentReportingBlock(articles);
      const referenceBlock =
        linkSources.length > 0
          ? `• Use these references:\n${linkSources
              .map((u) => `- ${u}`)
              .join('\n')}`
          : '';
      const groundingInstruction = articles.length
        ? '- Base every factual statement on the reporting summaries provided and cite the matching URL when referencing them.\n'
        : '';

      let sectionInstruction: string;
      if (lengthOption === 'default') {
        sectionInstruction = 'Include around 5 <h2> headings.';
      } else if (lengthOption === 'custom' && customSections) {
        sectionInstruction = `Use exactly ${customSections} <h2> headings.`;
      } else if (lengthOption && sectionRanges[lengthOption]) {
        const [minS, maxS] = sectionRanges[lengthOption];
        sectionInstruction = `Include ${minS}–${maxS} <h2> headings.`;
      } else {
        sectionInstruction = 'Include at least three <h2> headings.';
      }

      const reportingContext = reportingBlock ? `${reportingBlock}\n\n` : '';
      const baseOutline = buildOutlinePrompt({
        title,
        reportingContext,
        sectionInstruction,
        referenceBlock,
        extraBullets: [
          'Arrange the remaining sections chronologically or by major stakeholder impact so the story flows like a news report.',
          'Emphasize the time-sensitive angles and signal what has changed compared with previous updates.',
        ],
      });

      const outline = await generateOutlineWithFallback(
        baseOutline,
        modelVersion,
        0.6
      );

      const customInstruction = customInstructions?.trim();
      const customInstructionBlock = customInstruction
        ? `- ${customInstruction}\n`
        : '';

      const [minWords, maxWords] = getWordBounds(lengthOption, customSections);
      let lengthInstruction = '';
      if (lengthOption === 'default') {
        const approxPerSection = Math.round(DEFAULT_WORDS / 5);
        lengthInstruction =
          `- Use around 5 sections, and the article must contain at least ${minWords.toLocaleString()} words (target roughly ${DEFAULT_WORDS.toLocaleString()} words total, ~${approxPerSection.toLocaleString()} words per section, and keep it under ${maxWords.toLocaleString()} words).\n`;
      } else if (lengthOption === 'custom' && customSections) {
        const approx = customSections * 220;
        lengthInstruction = `- Use exactly ${customSections} sections, and the article must contain at least ${minWords.toLocaleString()} words (~${approx.toLocaleString()} words total; keep it under ${maxWords.toLocaleString()} words).\n`;
      } else if (lengthOption && WORD_RANGES[lengthOption]) {
        const [minS, maxS] = sectionRanges[lengthOption] || [3, 6];
        const minW = minWords.toLocaleString();
        const maxW = maxWords.toLocaleString();
        lengthInstruction = `- Include ${minS}–${maxS} sections and write between ${minW} and ${maxW} words.\n`;
      } else {
        lengthInstruction = `- Include at least three <h2> headings, and the article must contain at least ${minWords.toLocaleString()} words while staying under ${maxWords.toLocaleString()} words.\n`;
      }

      const reportingSection = reportingBlock ? `${reportingBlock}\n\n` : '';

      const articlePrompt = buildArticlePrompt({
        title,
        outline,
        reportingSection,
        toneInstruction,
        povInstruction,
        lengthInstruction,
        groundingInstruction,
        customInstructionBlock,
        linkInstruction,
        extraRequirements: [
          'Avoid starting paragraphs with dates and omit dates unless they add essential context; when a date is necessary, place it after the subject rather than leading with it.',
          'Keep the pacing focused on timely developments, clarifying what happened, when, and why it matters now.',
          'Attribute key facts to the appropriate source by linking the relevant URL directly in the text.',
          'Center each section on the main topic by synthesizing the reporting and mention publishers only within citations, not as standalone subjects.',
        ],
      });

      const applyArticleIssues = (issues?: string[]) =>
        applyVerificationIssuesToPrompt(articlePrompt, issues);

      const maxTokens = Math.min(baseMaxTokens, 4000);

      const content = await generateWithVerification(
        (issues) =>
          generateWithLinks(
            applyArticleIssues(issues),
            modelVersion,
            linkSources,
            systemPrompt,
            minLinks,
            maxTokens,
            minWords,
            articles
          ),
        articles,
        newsSources
      );

      return NextResponse.json({
        content,
        sources: newsSources,
      });
    }

    const reportingContextPromise: Promise<ReportingContext> = (async () => {
      if (!serpEnabled) {
        return {
          reportingSources: [],
          reportingBlock: '',
          groundingInstruction: '',
          linkSources: [],
          referenceBlock: '',
        };
      }

      const needsRelevanceSourcing =
        articleType === 'Listicle/Gallery' || articleType === 'Blog post';
      const reportingSources = await fetchSources(
        title,
        needsRelevanceSourcing
          ? {
              maxAgeMs: null,
              serpParams: { sort_by: 'relevance' },
            }
          : undefined
      );

      const reportingBlock = buildRecentReportingBlock(reportingSources);
      const groundingInstruction = reportingSources.length
        ? '- Use these reporting summaries to enrich your article, weaving their specifics naturally into the story and citing the matching URL for each sourced detail.\n'
        : '';
      const linkSources = reportingSources
        .map((item) => item.url)
        .filter(Boolean);
      const referenceBlock =
        linkSources.length > 0
          ? `• While drafting the article, plan to cite these supporting sources:\n${linkSources
              .map((u) => `- ${u}`)
              .join('\n')}`
          : '';

      return {
        reportingSources,
        reportingBlock,
        groundingInstruction,
        linkSources,
        referenceBlock,
      };
    })();

    // ─── Listicle/Gallery ────────────────────────────────────────────────────────
    if (articleType === 'Listicle/Gallery') {
      const {
        reportingSources,
        reportingBlock,
        groundingInstruction,
        linkSources,
        referenceBlock,
      } = await reportingContextPromise;
      const match = title.match(/\d+/);
      const count = match ? parseInt(match[0], 10) : 5;

      const reportingContext = reportingBlock ? `${reportingBlock}\n\n` : '';
      const outlinePrompt = `
You are a professional writer tasked with planning a factual, source-grounded listicle outline.

Title: "${title}"

${reportingContext}Requirements:
• Use exactly ${count} items.
• Number each heading formatted like ${listNumberingFormat}.
• Provide a short clause after each numbered heading describing the key sourced insight it should cover.
• Keep the outline tightly focused on the authoritative reporting summaries provided so every item reflects accurate, highly relevant sourcing.
• Preserve every concrete fact from the reporting block—names, dates, figures, locations, direct quotes—and restate them verbatim inside the relevant numbered heading or bullet instead of paraphrasing generically.
• For every bullet that uses a reporting summary, append " (Source: URL)" with the matching link.
• Do not merge distinct facts into one bullet: break out each specific person, organization, date, or metric so it can be cited individually.
${referenceBlock ? `${referenceBlock}\n` : ''}• Do not invent new facts beyond the provided sources.
`.trim();

      const outline = await generateOutlineWithFallback(
        outlinePrompt,
        modelVersion,
        0.6
      );

      let [minWords, maxWords] = getWordBounds(lengthOption, customSections);
      const wordsPerItem = listItemWordCount || 100;
      const derivedMinWords = Math.floor(count * wordsPerItem * 0.8);
      if (derivedMinWords > minWords) {
        minWords = derivedMinWords;
      }
      const minWordsPerItem = Math.ceil(minWords / count);
      const capText =
        maxWords > minWords
          ? ` while staying under ${maxWords.toLocaleString()} words`
          : '';

      const lengthInstruction = `- Use exactly ${count} items, and the article must contain at least ${minWords.toLocaleString()} words${capText}.\n`;
      const numberingInstruction = listNumberingFormat
        ? `- Use numbering formatted like ${listNumberingFormat}.\n`
        : '';
      const wordCountInstruction = listItemWordCount
        ? `- Keep each list item around ${listItemWordCount} words while ensuring at least ${minWordsPerItem} words per item so the article clears ${minWords.toLocaleString()} words overall.\n`
        : `- Make sure each list item adds enough detail to reach the ${minWords.toLocaleString()}-word minimum (roughly ${minWordsPerItem} words per item on average).\n`;
      const customInstruction = customInstructions?.trim();
      const customInstructionBlock = customInstruction
        ? `- ${customInstruction}\n`
        : '';
      const requiredLinks = linkSources.slice(
        0,
        Math.min(Math.max(MIN_LINKS, linkSources.length), 5)
      );
      const minLinks = requiredLinks.length; // how many links to require
      const optionalLinks = linkSources.slice(requiredLinks.length);
      const optionalInstruction = optionalLinks.length
        ? `\n  - You may also cite these optional sources if they add value:\n${optionalLinks
            .map((u) => `    - ${u}`)
            .join('\n')}`
        : '';
      const linkInstruction = requiredLinks.length
        ? `- Integrate clickable HTML links for at least the following required sources within relevant keywords or phrases.\n${requiredLinks
            .map((u) => `  - ${u}`)
            .join('\n')}\n  - Embed each required link as <a href="URL" target="_blank">text</a> exactly once and do not list them at the end.${optionalInstruction}\n  - Spread the links naturally across the article.`
        : '';
      const toneChoice =
        toneOfVoice === 'Custom' && customTone ? customTone : toneOfVoice;
      const toneInstruction = toneChoice
        ? `- Write in a ${toneChoice} tone of voice.\n`
        : '';
      const povInstruction = pointOfView
        ? `- Use a ${pointOfView} perspective.\n`
        : '';

      const reportingSection = reportingBlock ? `${reportingBlock}\n\n` : '';

      const articlePrompt = `
You are a professional journalist writing a listicle-style web article.

Title: "${title}"
Do NOT include the title or any <h1> tag in the HTML output.

Outline:
${outline}

${reportingSection}${toneInstruction}${povInstruction}Requirements:
  ${lengthInstruction}${numberingInstruction}${wordCountInstruction}${customInstructionBlock}  - Use the outline's introduction bullet to write a 2–3 sentence introduction (no <h2> tags) without including the words "INTRO:" or "Introduction".
  - For each <h2> in the outline, write 2–3 paragraphs under it.
  - Keep every section anchored to the authoritative reporting summaries provided so each paragraph reflects accurate, highly relevant sourcing.
  - Center each list item on the main topic by synthesizing the reporting and mention publishers only within citations, not as standalone subjects.
  - Use standard HTML tags such as <h2>, <h3>, <p>, <a>, <ul>, and <li> as needed.
  - Avoid cheesy or overly rigid language (e.g., "gem", "embodiment", "endeavor", "Vigilant", "Daunting", etc.).
  - Avoid referring to the article itself (e.g., “This article explores…” or “In this article…”) anywhere in the introduction.
  - Do NOT wrap your output in markdown code fences or extra <p> tags.
  ${DETAIL_INSTRUCTION}${customInstructionBlock}${groundingInstruction}${linkInstruction}  - Do NOT label the intro under "Introduction" or with prefixes like "INTRO:", and do not end with a "Conclusion" heading or closing phrases like "In conclusion".
  - Do NOT invent sources or links.

Write the full article in valid HTML below:
`.trim();

      const desired = count * wordsPerItem + 50;
      let maxTokens = Math.ceil((desired * 1.2) / 0.75); // add 20% buffer
      const limit = MODEL_CONTEXT_LIMITS[modelVersion] || 8000;
      maxTokens = Math.min(maxTokens, limit);

      const content = await generateWithVerification(
        (issues) =>
          generateWithLinks(
            applyVerificationIssuesToPrompt(articlePrompt, issues),
            modelVersion,
            linkSources,
            systemPrompt,
            minLinks,
            maxTokens,
            minWords,
            reportingSources
          ),
        reportingSources,
        linkSources
      );
      return NextResponse.json({
        content,
        sources: linkSources,
      });
    }

    
    // ─── Blog post (default) ───────────────────────────────────────────────────
    const {
      reportingSources,
      reportingBlock,
      groundingInstruction,
      linkSources,
      referenceBlock,
    } = await reportingContextPromise;

    let sectionInstruction: string;
    if (lengthOption === 'default') {
      sectionInstruction = 'Include around 9 <h2> headings.';
    } else if (lengthOption === 'custom' && customSections) {
      sectionInstruction = `Use exactly ${customSections} <h2> headings.`;
    } else if (sectionRanges[lengthOption || 'medium']) {
      const [minS, maxS] = sectionRanges[lengthOption || 'medium'];
      sectionInstruction =
        `Include ${minS}–${maxS} <h2> headings.`;
    } else {
      sectionInstruction = 'Include at least three <h2> headings.';
    }

    const reportingContext = reportingBlock ? `${reportingBlock}\n\n` : '';
    const baseOutline = buildOutlinePrompt({
      title,
      reportingContext,
      sectionInstruction,
      referenceBlock,
    });

    const outline = await generateOutlineWithFallback(
      baseOutline,
      modelVersion
    );

    const customInstruction = customInstructions?.trim();
    const customInstructionBlock = customInstruction
      ? `- ${customInstruction}\n`
      : '';
    const [minWords, maxWords] = getWordBounds(lengthOption, customSections);
    let lengthInstruction: string;
    if (lengthOption === 'default') {
      lengthInstruction =
        `- Use around 9 sections, and the article must contain at least ${minWords.toLocaleString()} words (target roughly ${DEFAULT_WORDS.toLocaleString()} words total, ~220 words per section, and keep it under ${maxWords.toLocaleString()} words).\n`;
    } else if (lengthOption === 'custom' && customSections) {
      const approx = customSections * 220;
      lengthInstruction = `- Use exactly ${customSections} sections, and the article must contain at least ${minWords.toLocaleString()} words (~${approx.toLocaleString()} words total; keep it under ${maxWords.toLocaleString()} words).\n`;
    } else if (WORD_RANGES[lengthOption || 'medium']) {
      const [minS, maxS] = sectionRanges[lengthOption || 'medium'];
      const minW = minWords.toLocaleString();
      const maxW = maxWords.toLocaleString();
      lengthInstruction =
        `- Include ${minS}–${maxS} sections and write between ${minW} and ${maxW} words.\n`;
    } else {
      lengthInstruction =
        `- Include at least three <h2> headings, and the article must contain at least ${minWords.toLocaleString()} words while staying under ${maxWords.toLocaleString()} words.\n`;
    }

    const requiredLinks = linkSources.slice(
      0,
      Math.min(Math.max(MIN_LINKS, linkSources.length), 5)
    );
    const minLinks = requiredLinks.length; // how many links to require
    const optionalLinks = linkSources.slice(requiredLinks.length);
    const optionalInstruction = optionalLinks.length
      ? `\n  - You may also cite these optional sources if they add value:\n${optionalLinks
          .map((u) => `    - ${u}`)
          .join('\n')}`
      : '';
    const linkInstruction = requiredLinks.length
      ? `- Integrate clickable HTML links for at least the following required sources within relevant keywords or phrases.\n${requiredLinks
          .map((u) => `  - ${u}`)
          .join('\n')}\n  - Embed each required link as <a href="URL" target="_blank">text</a> exactly once and do not list them at the end.${optionalInstruction}\n  - Spread the links naturally across the article.`
      : '';

    const reportingSection = reportingBlock ? `${reportingBlock}\n\n` : '';
    const extraRequirements = [
      'Avoid starting paragraphs with dates and omit dates unless they add essential context; when a date is necessary, place it after the subject rather than leading with it.',
      'Center each section on the main topic by synthesizing the reporting and mention publishers only within citations, not as standalone subjects.',
    ];

    const articlePrompt = buildArticlePrompt({
      title,
      outline,
      reportingSection,
      toneInstruction,
      povInstruction,
      lengthInstruction,
      groundingInstruction,
      customInstructionBlock,
      linkInstruction,
      extraRequirements,
    });

    const runArticleGeneration = (prompt: string) =>
      generateWithVerification(
        (issues) =>
          generateWithLinks(
            applyVerificationIssuesToPrompt(prompt, issues),
            modelVersion,
            linkSources,
            systemPrompt,
            minLinks,
            baseMaxTokens,
            minWords,
            reportingSources
          ),
        reportingSources,
        linkSources
      );

    const content = await runArticleGeneration(articlePrompt);

    return NextResponse.json({
      content,
      sources: linkSources,
    });
  } catch (err: any) {
    console.error('[api/generate] error:', err);
    return NextResponse.json(
      { error: err.message || 'Internal error' },
      { status: 500 }
    );
  }
}
