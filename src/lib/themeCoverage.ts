import { TRAVEL_THEME_AUDIENCE_TERMS } from './travelThemeAudience';

const DEFAULT_THEME_THRESHOLD = 0.18;
const THEME_STOPWORDS = new Set([
  'and',
  'or',
  'the',
  'a',
  'an',
  'of',
  'for',
  'to',
  'in',
  'on',
  'with',
  'by',
  'from',
  'at',
  'into',
  'across',
  'around',
  'about',
  'over',
  'under',
  'near',
  'between',
  'within',
  'without',
  'through',
  'via',
]);

const WORD_BOUNDARY_CHARS = "[^a-z0-9']";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clampThreshold(value: number | undefined | null): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return DEFAULT_THEME_THRESHOLD;
  }
  if (value > 1) {
    return Math.min(1, value / 100);
  }
  if (value <= 0) {
    return DEFAULT_THEME_THRESHOLD;
  }
  return value;
}

function htmlToPlainText(html: string): string {
  if (!html) {
    return '';
  }
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(nbsp|#160);/gi, ' ')
    .replace(/&#[0-9]+;/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitIntoSentences(text: string): string[] {
  if (!text) {
    return [];
  }
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return [];
  }
  return normalized
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function countWords(text: string): number {
  if (!text) {
    return 0;
  }
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) {
    return 0;
  }
  return trimmed.split(' ').length;
}

function containsToken(sentence: string, token: string): boolean {
  if (!token) {
    return false;
  }
  const escaped = escapeRegExp(token);
  const regex = new RegExp(`(?:^|${WORD_BOUNDARY_CHARS})${escaped}(?:['’]s|s)?(?=$|${WORD_BOUNDARY_CHARS})`);
  if (regex.test(sentence)) {
    return true;
  }
  return sentence.includes(`${token}-`);
}

function buildAudienceTermSet(extraTerms?: Iterable<string>): ReadonlySet<string> {
  const terms = new Set<string>(Array.from(TRAVEL_THEME_AUDIENCE_TERMS));
  if (extraTerms) {
    for (const term of extraTerms) {
      if (typeof term === 'string' && term.trim()) {
        terms.add(term.trim().toLowerCase());
      }
    }
  }
  return terms;
}

function normalizeTheme(themeLabel: string): string {
  return themeLabel.toLowerCase().replace(/\s+/g, ' ').trim();
}

export interface ThemeCoverageAnalysis {
  totalSentences: number;
  totalWords: number;
  themedSentenceCount: number;
  themedWordCount: number;
  coverageRatio: number;
  wordCoverageRatio: number;
  audienceOnlySentenceCount: number;
  descriptorTokens: string[];
  audienceTokens: string[];
  hasThemeMentions: boolean;
  hasAudienceMentions: boolean;
  genericOnly: boolean;
}

export interface ThemeCoverageOptions {
  threshold?: number;
  audienceTerms?: Iterable<string>;
}

export type ThemeCoverageIssueReason =
  | 'missing'
  | 'generic-only'
  | 'insufficient-coverage';

export interface ThemeCoverageIssue {
  tag: 'THEME_COVERAGE';
  message: string;
  themeLabel: string;
  threshold: number;
  coverageRatio: number;
  wordCoverageRatio: number;
  themedSentenceCount: number;
  totalSentences: number;
  reason: ThemeCoverageIssueReason;
}

export function analyzeThemeCoverage(
  html: string,
  themeLabel: string,
  options: ThemeCoverageOptions = {}
): ThemeCoverageAnalysis {
  const plainText = htmlToPlainText(html);
  const sentences = splitIntoSentences(plainText);
  const totalSentences = sentences.length;
  const totalWords = countWords(plainText);
  const normalizedTheme = normalizeTheme(themeLabel);
  const audienceTerms = buildAudienceTermSet(options.audienceTerms);
  const tokens = normalizedTheme ? normalizedTheme.split(' ') : [];
  const descriptorTokens = tokens
    .filter((token) => !audienceTerms.has(token) && !THEME_STOPWORDS.has(token))
    .filter((token) => token.length > 1);
  const fallbackDescriptors = tokens.filter((token) => !audienceTerms.has(token));
  const descriptorSet = descriptorTokens.length ? descriptorTokens : fallbackDescriptors;
  const audienceTokens = tokens.filter((token) => audienceTerms.has(token));

  let themedSentenceCount = 0;
  let themedWordCount = 0;
  let audienceOnlySentenceCount = 0;
  let hasAudienceMentions = false;

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    const words = countWords(sentence);
    const directMention = normalizedTheme && lower.includes(normalizedTheme);
    const descriptorMention = descriptorSet.some((token) => containsToken(lower, token));
    const audienceMention = audienceTokens.some((token) => containsToken(lower, token));

    if (descriptorMention || directMention) {
      themedSentenceCount += 1;
      themedWordCount += words;
    } else if (audienceMention) {
      audienceOnlySentenceCount += 1;
    }

    if (audienceMention) {
      hasAudienceMentions = true;
    }
  }

  const coverageRatio = totalSentences > 0 ? themedSentenceCount / totalSentences : 0;
  const wordCoverageRatio = totalWords > 0 ? themedWordCount / totalWords : 0;

  return {
    totalSentences,
    totalWords,
    themedSentenceCount,
    themedWordCount,
    coverageRatio,
    wordCoverageRatio,
    audienceOnlySentenceCount,
    descriptorTokens: descriptorSet,
    audienceTokens,
    hasThemeMentions: themedSentenceCount > 0,
    hasAudienceMentions,
    genericOnly: themedSentenceCount === 0 && audienceOnlySentenceCount > 0,
  };
}

export function validateThemeCoverage(
  html: string,
  themeLabel: string,
  options: ThemeCoverageOptions = {}
): ThemeCoverageIssue | null {
  const normalizedLabel = themeLabel.trim();
  if (!normalizedLabel) {
    return null;
  }

  const threshold = clampThreshold(options.threshold);
  const analysis = analyzeThemeCoverage(html, normalizedLabel, options);
  const meetsSentence = analysis.coverageRatio >= threshold;
  const meetsWord = analysis.wordCoverageRatio >= threshold;

  if (analysis.hasThemeMentions && (meetsSentence || meetsWord) && !analysis.genericOnly) {
    return null;
  }

  const descriptorSummary = analysis.descriptorTokens.length
    ? analysis.descriptorTokens.join(' ')
    : normalizeTheme(normalizedLabel);
  const audienceSummary = analysis.audienceTokens.length
    ? analysis.audienceTokens.join(' ')
    : '';

  let reason: ThemeCoverageIssueReason;
  let message: string;

  if (!analysis.hasThemeMentions) {
    if (analysis.genericOnly && audienceSummary) {
      reason = 'generic-only';
      message = `The draft only references ${audienceSummary} generically and never ties the reporting back to ${descriptorSummary}. Add specific, cited coverage about ${normalizedLabel}.`;
    } else {
      reason = 'missing';
      message = `The draft never weaves in concrete coverage about ${normalizedLabel}. Add cited sections that focus on this theme.`;
    }
  } else if (analysis.genericOnly) {
    reason = 'generic-only';
    message = `Mentions of ${audienceSummary || 'the audience'} stay generic and omit the specific theme details about ${descriptorSummary}. Expand multiple sections with concrete, cited coverage about ${normalizedLabel}.`;
  } else {
    reason = 'insufficient-coverage';
    const requiredPercent = Math.round(threshold * 100);
    const observedPercent = (analysis.coverageRatio * 100).toFixed(1).replace(/\.0$/, '');
    message = `Only ${observedPercent}% of sentences mention ${normalizedLabel}. Raise this above ${requiredPercent}% with specific, cited coverage tailored to the theme.`;
  }

  return {
    tag: 'THEME_COVERAGE',
    message,
    themeLabel: normalizedLabel,
    threshold,
    coverageRatio: analysis.coverageRatio,
    wordCoverageRatio: analysis.wordCoverageRatio,
    themedSentenceCount: analysis.themedSentenceCount,
    totalSentences: analysis.totalSentences,
    reason,
  };
}

export function formatThemeCoverageIssue(issue: ThemeCoverageIssue): string {
  return `[THEME_COVERAGE]${JSON.stringify(issue)}`;
}

export function parseThemeCoverageIssue(value: string): ThemeCoverageIssue | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith('[THEME_COVERAGE]')) {
    return null;
  }
  const payload = trimmed.slice('[THEME_COVERAGE]'.length);
  try {
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed === 'object' && parsed.tag === 'THEME_COVERAGE') {
      return parsed as ThemeCoverageIssue;
    }
  } catch {
    return null;
  }
  return null;
}

export function resolveThemeThreshold(input?: number | null): number {
  return clampThreshold(input ?? undefined);
}
