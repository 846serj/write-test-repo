import assert from 'assert';
import fs from 'fs';
import * as ts from 'typescript';
import { test } from 'node:test';

const helpersPath = new URL('../src/app/generate/headlineFormHelpers.ts', import.meta.url);
const tsSource = fs.readFileSync(helpersPath, 'utf8');

const snippet = `${tsSource}
export { normalizeKeywordInput, buildHeadlineRequest };
`;

const jsCode = ts
  .transpileModule(snippet, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  })
  .outputText;

const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(jsCode).toString('base64');

const { normalizeKeywordInput, buildHeadlineRequest } = await import(moduleUrl);

const FIXED_NOW = Date.UTC(2024, 6, 31, 12, 0, 0);

function withMockedNow(fn) {
  const realNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    return fn();
  } finally {
    Date.now = realNow;
  }
}

function computeDefaultRange() {
  const today = new Date(FIXED_NOW);
  const defaultTo = today.toISOString().slice(0, 10);
  const fromDate = new Date(today);
  fromDate.setUTCDate(fromDate.getUTCDate() - 30);
  const defaultFrom = fromDate.toISOString().slice(0, 10);
  return { defaultFrom, defaultTo };
}

test('normalizeKeywordInput deduplicates mixed separators while preserving order', () => {
  const result = normalizeKeywordInput('AI, robotics\nAI, space exploration\nSpace Exploration');
  assert.deepStrictEqual(result, ['AI', 'robotics', 'space exploration']);
});

test('buildHeadlineRequest requires keywords, description, or query', () => {
  const result = buildHeadlineRequest({
    keywords: [],
    profileQuery: '',
    profileLanguage: null,
    limit: 5,
    sortBy: 'publishedAt',
    language: 'en',
    fromDate: '',
    toDate: '',
    searchIn: [],
    description: '',
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(
    result.error,
    'Select a site preset or supply custom instructions to fetch headlines.'
  );
});

test('buildHeadlineRequest accepts description-only payloads', () => {
  const instructions = 'Curate upbeat travel pieces about coastal California towns.';

  withMockedNow(() => {
    const result = buildHeadlineRequest({
      keywords: [],
      profileQuery: '',
      profileLanguage: null,
      limit: 25,
      sortBy: 'publishedAt',
      language: 'en',
      fromDate: '',
      toDate: '',
      searchIn: [],
      description: instructions,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.payload.description, instructions);
    assert.strictEqual(result.payload.limit, 25);
    const { defaultFrom, defaultTo } = computeDefaultRange();
    assert.strictEqual(result.payload.from, defaultFrom);
    assert.strictEqual(result.payload.to, defaultTo);
  });
});

test('buildHeadlineRequest creates keyword-only payloads', () => {
  const keywords = normalizeKeywordInput('climate change, Climate Change, renewables');

  withMockedNow(() => {
    const result = buildHeadlineRequest({
      keywords,
      profileQuery: '',
      profileLanguage: null,
      limit: 7,
      sortBy: 'relevancy',
      language: 'all',
      fromDate: '',
      toDate: '',
      searchIn: ['description', 'content'],
      description: '',
      rssFeeds: ['https://example.com/feed'],
      dedupeMode: 'strict',
    });

    assert.strictEqual(result.ok, true);
    const { defaultFrom, defaultTo } = computeDefaultRange();
    assert.deepStrictEqual(result.payload, {
      limit: 7,
      sortBy: 'relevancy',
      keywords,
      searchIn: ['description', 'content'],
      rssFeeds: ['https://example.com/feed'],
      from: defaultFrom,
      to: defaultTo,
      dedupeMode: 'strict',
    });
    assert.deepStrictEqual(result.sanitizedRssFeeds, ['https://example.com/feed']);
  });
});

test('buildHeadlineRequest normalizes language for profile queries', () => {
  withMockedNow(() => {
    const result = buildHeadlineRequest({
      keywords: [],
      profileQuery: '  Tech policy updates  ',
      profileLanguage: 'ES',
      limit: 4,
      sortBy: 'publishedAt',
      language: 'all',
      fromDate: '',
      toDate: '',
      searchIn: [],
      description: '',
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.payload.query, 'Tech policy updates');
    assert.strictEqual(result.payload.language, 'es');
    const { defaultFrom, defaultTo } = computeDefaultRange();
    assert.strictEqual(result.payload.from, defaultFrom);
    assert.strictEqual(result.payload.to, defaultTo);
  });
});

test('buildHeadlineRequest sanitizes rss feeds', () => {
  withMockedNow(() => {
    const result = buildHeadlineRequest({
      keywords: ['space'],
      profileQuery: '',
      profileLanguage: null,
      limit: 5,
      sortBy: 'publishedAt',
      language: 'en',
      fromDate: '',
      toDate: '',
      searchIn: [],
      description: '',
      rssFeeds: [
        ' https://example.com/feed ',
        'HTTP://example.com/feed',
        'not-a-url',
        'ftp://example.com/feed',
      ],
    });

    assert.strictEqual(result.ok, true);
    const { defaultFrom, defaultTo } = computeDefaultRange();
    assert.strictEqual(result.payload.from, defaultFrom);
    assert.strictEqual(result.payload.to, defaultTo);
    assert.deepStrictEqual(result.payload.rssFeeds, [
      'https://example.com/feed',
      'http://example.com/feed',
    ]);
    assert.deepStrictEqual(result.sanitizedRssFeeds, [
      'https://example.com/feed',
      'http://example.com/feed',
    ]);
  });
});

test('buildHeadlineRequest accepts profile queries without keywords', () => {
  withMockedNow(() => {
    const result = buildHeadlineRequest({
      keywords: [],
      profileQuery: 'Space station maintenance',
      profileLanguage: null,
      limit: 6,
      sortBy: 'publishedAt',
      language: 'en',
      fromDate: '',
      toDate: '',
      searchIn: [],
      description: '',
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.payload.query, 'Space station maintenance');
    const { defaultFrom, defaultTo } = computeDefaultRange();
    assert.strictEqual(result.payload.from, defaultFrom);
    assert.strictEqual(result.payload.to, defaultTo);
    assert.ok(!('description' in result.payload));
  });
});
