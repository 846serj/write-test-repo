import assert from 'assert';
import fs from 'fs';
import * as ts from 'typescript';
import { test } from 'node:test';

const routePath = new URL('../src/app/api/generate/route.ts', import.meta.url);
const tsCode = fs.readFileSync(routePath, 'utf8');

function extract(regex, description) {
  const match = tsCode.match(regex);
  if (!match) {
    throw new Error(`Failed to extract ${description}`);
  }
  return match[0];
}

const snippet = `
${extract(/const MILLIS_IN_MINUTE[\s\S]*?const MAX_FUTURE_DRIFT_MS[^;]*;/, 'time constants')}
const serpCalls = [];
let serpResults = [];
function setSerpResults(results) { serpResults = results; }
async function serpapiSearch(params) { serpCalls.push(params); return serpResults; }
${extract(/function normalizeTitleValue[\s\S]*?\n\}/, 'normalizeTitleValue')}
${extract(/function parseRelativeTimestamp[\s\S]*?\n\}/, 'parseRelativeTimestamp')}
${extract(/function parsePublishedTimestamp[\s\S]*?\n\}/, 'parsePublishedTimestamp')}
${extract(/function isTimestampWithinWindow[\s\S]*?\n\}/, 'isTimestampWithinWindow')}
${extract(/function normalizePublishedAt[\s\S]*?\n\}/, 'normalizePublishedAt')}
${extract(/const SOURCE_TOKEN_MIN_LENGTH[\s\S]*?return \(2 \* precision \* recall\)[\s\S]*?\n\}/, 'source token helpers')}
${extract(/type ScoredReportingSource[\s\S]*?;/, 'ScoredReportingSource type')}
${extract(/async function fetchSources[\s\S]*?\n\}/, 'fetchSources')}
${extract(/function normalizeHrefValue[\s\S]*?\n\}/, 'normalizeHrefValue')}
${extract(/function buildUrlVariants[\s\S]*?\n\}/, 'buildUrlVariants')}
${extract(/function normalizePublisher[\s\S]*?\n\}/, 'normalizePublisher')}
${extract(/async function fetchNewsArticles[\s\S]*?\n\}/, 'fetchNewsArticles')}
${extract(/const TIMELINE_REGEX[\s\S]*?function extractStructuredFacts[\s\S]*?\n\}/, 'structured fact helpers')}
${extract(/function formatKeyDetails[\s\S]*?\n\}/, 'formatKeyDetails')}
${extract(/function normalizeSummary[\s\S]*?\n\}/, 'normalizeSummary')}
${extract(/function formatPublishedTimestamp[\s\S]*?\n\}/, 'formatPublishedTimestamp')}
${extract(/function buildRecentReportingBlock[\s\S]*?\n\}/, 'buildRecentReportingBlock')}
export {
  fetchSources,
  serpCalls,
  setSerpResults,
  fetchNewsArticles,
  buildRecentReportingBlock,
};
`;

const jsCode = ts.transpileModule(snippet, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(jsCode).toString('base64');
const {
  fetchSources,
  serpCalls,
  setSerpResults,
  fetchNewsArticles,
  buildRecentReportingBlock,
} = await import(moduleUrl);

const FIXED_NOW_ISO = '2024-03-10T12:00:00Z';
const FIXED_NOW_MS = Date.parse(FIXED_NOW_ISO);
const DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysAgo(days, referenceMs = FIXED_NOW_MS) {
  return new Date(referenceMs - days * DAY_MS).toISOString();
}

async function withMockedNow(callback, referenceMs = FIXED_NOW_MS) {
  const originalNow = Date.now;
  Date.now = () => referenceMs;
  try {
    return await callback();
  } finally {
    Date.now = originalNow;
  }
}

test('fetchSources requests google_news with relevance sort and ranks by score', async () => {
  await withMockedNow(async () => {
    serpCalls.length = 0;
    setSerpResults([
      {
        link: 'https://example.com/success',
        source: 'Example News',
        title: 'SpaceX rocket launch succeeds in reaching orbit',
        snippet: '  SpaceX rocket launch succeeds with crew mission  ',
        date: isoDaysAgo(1),
      },
      {
        link: 'https://example.com/sports',
        source: 'Local Sports',
        title: 'High school football finals',
        snippet: 'Local sports update',
        date: isoDaysAgo(1),
      },
      {
        link: 'https://example.com/delays',
        source: 'Space Daily',
        title: 'SpaceX delays new rocket launch',
        snippet: 'Weather postpones SpaceX rocket launch schedule',
        date: isoDaysAgo(2),
      },
      {
        link: 'https://example.com/analysis',
        source: 'Orbital Times',
        title: 'Rocket launch schedule update',
        snippet: 'SpaceX outlines launch timeline after success',
        date: isoDaysAgo(3),
      },
      {
        link: 'https://example.com/overview',
        source: 'Industry Watch',
        title: 'Space industry overview',
        snippet: 'Space industry overview',
        date: isoDaysAgo(1),
      },
      {
        link: 'https://example.com/markets',
        source: 'Economy Daily',
        title: 'Global markets rebound',
        snippet: 'Markets update',
        date: isoDaysAgo(2),
      },
    ]);
    const sources = await fetchSources('SpaceX rocket launch succeeds', {
      maxAgeMs: null,
      serpParams: { sort_by: 'relevance' },
    });
    assert.strictEqual(serpCalls.length, 1);
    assert.strictEqual(serpCalls[0].engine, 'google_news');
    assert.strictEqual(serpCalls[0].query, 'SpaceX rocket launch succeeds');
    assert.deepStrictEqual(serpCalls[0].extraParams, { sort_by: 'relevance' });
    assert.strictEqual(serpCalls[0].limit, 12);
    assert.deepStrictEqual(
      sources.map(({ url, summary, publishedAt }) => ({ url, summary, publishedAt })),
      [
        {
          url: 'https://example.com/success',
          summary: 'SpaceX rocket launch succeeds with crew mission',
          publishedAt: isoDaysAgo(1),
        },
        {
          url: 'https://example.com/delays',
          summary: 'Weather postpones SpaceX rocket launch schedule',
          publishedAt: isoDaysAgo(2),
        },
        {
          url: 'https://example.com/analysis',
          summary: 'SpaceX outlines launch timeline after success',
          publishedAt: isoDaysAgo(3),
        },
      ]
    );
    assert.deepStrictEqual(
      sources.map(({ title }) => title),
      [
        'SpaceX rocket launch succeeds in reaching orbit',
        'SpaceX delays new rocket launch',
        'Rocket launch schedule update',
      ]
    );
  });
});

test('fetchSources filters out irrelevant stories and keeps the highest scoring ones', async () => {
  await withMockedNow(async () => {
    serpCalls.length = 0;
    setSerpResults([
      {
        link: 'https://news.com/leaders',
        source: 'World News',
        title: 'Global climate policy leaders meet',
        snippet: 'Global climate policy meeting draws leaders to summit',
        date: isoDaysAgo(1),
      },
      {
        link: 'https://news.com/emissions',
        source: 'Climate Desk',
        title: 'Climate meeting focuses on global emissions',
        snippet: 'Policy experts discuss global climate goals at meeting',
        date: isoDaysAgo(2),
      },
      {
        link: 'https://news.com/debate',
        source: 'Policy Times',
        title: 'Policy debate on climate goals',
        snippet: 'Global climate policy debate highlights meeting agenda',
        date: isoDaysAgo(3),
      },
      {
        link: 'https://news.com/finance',
        source: 'Finance Daily',
        title: 'Climate finance talks continue',
        snippet: 'Global climate policy finance meeting continues talks',
        date: isoDaysAgo(4),
      },
      {
        link: 'https://news.com/agenda',
        source: 'Agenda Watch',
        title: 'Global meeting agenda set',
        snippet: 'Policy meeting agenda set for global climate leaders',
        date: isoDaysAgo(5),
      },
      {
        link: 'https://news.com/plan',
        source: 'Planning Desk',
        title: 'Meeting plan finalized',
        snippet: 'Plan finalized ahead of meeting',
        date: isoDaysAgo(6),
      },
      {
        link: 'https://news.com/sports',
        source: 'Local Sports',
        title: 'Local sports update',
        snippet: 'High school team wins championship',
        date: isoDaysAgo(1),
      },
      {
        link: 'https://news.com/tech',
        source: 'Tech Wire',
        title: 'Tech company releases new phone',
        snippet: 'Latest smartphone launch details',
        date: isoDaysAgo(2),
      },
    ]);

    const sources = await fetchSources('Global climate policy meeting');

    assert.strictEqual(sources.length, 5);
    assert.deepStrictEqual(
      sources.map(({ url }) => url),
      [
        'https://news.com/leaders',
        'https://news.com/debate',
        'https://news.com/finance',
        'https://news.com/agenda',
        'https://news.com/emissions',
      ]
    );
    assert.ok(
      sources.every((item) =>
        item.summary.toLowerCase().includes('climate') ||
        item.summary.toLowerCase().includes('policy') ||
        item.summary.toLowerCase().includes('meeting')
      )
    );
  });
});

test('fetchSources skips results that share the same publisher source', async () => {
  await withMockedNow(async () => {
    serpCalls.length = 0;
    setSerpResults([
      { link: 'https://example.com/article-a', source: 'Example News', date: isoDaysAgo(1) },
      { link: 'https://example.com/article-b', source: 'Example News', date: isoDaysAgo(2) },
      { link: 'https://different.com/story', source: 'Different Daily', date: isoDaysAgo(3) },
    ]);

    const sources = await fetchSources('duplicate publishers');
    assert.deepStrictEqual(sources.map((item) => item.url), [
      'https://example.com/article-a',
      'https://different.com/story',
    ]);
  });
});

test('fetchSources deduplicates by hostname when source metadata is missing', async () => {
  await withMockedNow(async () => {
    serpCalls.length = 0;
    setSerpResults([
      { link: 'https://www.host.com/article-1', date: isoDaysAgo(1) },
      { link: 'https://host.com/article-2', date: isoDaysAgo(2) },
      { link: 'https://another.com/story', date: isoDaysAgo(3) },
    ]);

    const sources = await fetchSources('missing sources');
    assert.deepStrictEqual(sources.map((item) => item.url), [
      'https://www.host.com/article-1',
      'https://another.com/story',
    ]);
  });
});

test('fetchSources limits to five unique publishers while preserving order', async () => {
  await withMockedNow(async () => {
    serpCalls.length = 0;
    setSerpResults([
      { link: 'https://a.com/1', source: 'A', date: isoDaysAgo(1) },
      { link: 'https://b.com/1', source: 'B', date: isoDaysAgo(2) },
      { link: 'https://c.com/1', source: 'C', date: isoDaysAgo(3) },
      { link: 'https://d.com/1', source: 'D', date: isoDaysAgo(4) },
      { link: 'https://e.com/1', source: 'E', date: isoDaysAgo(5) },
      { link: 'https://f.com/1', source: 'F', date: isoDaysAgo(6) },
    ]);

    const sources = await fetchSources('many sources');
    assert.deepStrictEqual(sources.map((item) => item.url), [
      'https://a.com/1',
      'https://b.com/1',
      'https://c.com/1',
      'https://d.com/1',
      'https://e.com/1',
    ]);
  });
});

test('fetchSources skips duplicate headlines even from different publishers', async () => {
  await withMockedNow(async () => {
    serpCalls.length = 0;
    setSerpResults([
      {
        link: 'https://unique.com/story',
        source: 'Publisher One',
        title: 'Breaking News Flash',
        snippet: 'Breaking news flash update details',
        date: isoDaysAgo(1),
      },
      {
        link: 'https://duplicate.com/another',
        source: 'Publisher Two',
        title: '  breaking   news   flash  ',
        snippet: 'Breaking news flash update coverage',
        date: isoDaysAgo(2),
      },
      {
        link: 'https://another.com/story',
        source: 'Publisher Three',
        title: 'Different Headline',
        snippet: 'Different headline covering breaking news update',
        date: isoDaysAgo(3),
      },
    ]);

    const sources = await fetchSources('breaking news flash update');
    assert.deepStrictEqual(sources.map((item) => item.url), [
      'https://unique.com/story',
      'https://another.com/story',
    ]);
  });
});

test('fetchSources dedupes titles that only differ by trailing publisher separators', async () => {
  await withMockedNow(async () => {
    serpCalls.length = 0;
    setSerpResults([
      {
        link: 'https://site-a.com/story',
        source: 'Publisher One',
        title: 'AI Breakthrough - The Verge',
        snippet: 'AI breakthrough report details from Verge',
        date: isoDaysAgo(1),
      },
      {
        link: 'https://site-b.com/story',
        source: 'Publisher Two',
        title: 'AI Breakthrough | Wired',
        snippet: 'AI breakthrough report from Wired magazine',
        date: isoDaysAgo(2),
      },
      {
        link: 'https://site-c.com/story',
        source: 'Publisher Three',
        title: 'AI Breakthrough — CNN',
        snippet: 'AI breakthrough report covered by CNN',
        date: isoDaysAgo(3),
      },
      {
        link: 'https://site-d.com/unique',
        source: 'Publisher Four',
        title: 'Different Story - NPR',
        snippet: 'Different AI breakthrough report with unique details',
        date: isoDaysAgo(4),
      },
    ]);

    const sources = await fetchSources('ai breakthrough report');
    assert.deepStrictEqual(sources.map((item) => item.url), [
      'https://site-a.com/story',
      'https://site-d.com/unique',
    ]);
  });
});

test('fetchSources keeps older sources when recency is disabled', async () => {
  await withMockedNow(async () => {
    serpCalls.length = 0;
    setSerpResults([
      {
        link: 'https://recent.com/story',
        source: 'Recent News',
        title: 'Recent Story',
        snippet: 'Recent story update on policy',
        date: isoDaysAgo(5),
      },
      {
        link: 'https://old.com/story',
        source: 'Old Archive',
        title: 'Old Story',
        snippet: 'Old story update on policy history',
        date: isoDaysAgo(45),
      },
    ]);

    const sources = await fetchSources('policy story update', {
      maxAgeMs: null,
      serpParams: { sort_by: 'relevance' },
    });
    assert.deepStrictEqual(sources.map((item) => item.url), [
      'https://recent.com/story',
      'https://old.com/story',
    ]);
  });
});

test('fetchSources merges NewsAPI and SERP results while deduplicating', async () => {
  await withMockedNow(async () => {
    const originalNewsKey = process.env.NEWS_API_KEY;
    const originalFetch = globalThis.fetch;

    try {
      process.env.NEWS_API_KEY = 'news-key';
      globalThis.fetch = async () => ({
        ok: true,
        async json() {
          return {
            status: 'ok',
            articles: [
              {
                title: 'AI Launch Announced',
                description: 'Launch space update summary',
                url: 'https://example.com/news-ai',
                publishedAt: isoDaysAgo(2),
              },
              {
                title: 'Space Station Update',
                description: 'Space update summary',
                url: 'https://space.com/update',
                publishedAt: isoDaysAgo(3),
              },
            ],
          };
        },
        async text() {
          return JSON.stringify({ status: 'ok', articles: [] });
        },
      });

      serpCalls.length = 0;
      setSerpResults([
        {
          link: 'https://example.com/duplicate',
          source: 'Example News',
          title: 'AI Launch Announced - Example News',
          snippet: 'AI launch duplicate summary',
          date: isoDaysAgo(2),
        },
        {
          link: 'https://different.com/story',
          source: 'Different Daily',
          title: 'Different Angle',
          snippet: 'Different space update angle',
          date: isoDaysAgo(1),
        },
      ]);

      const sources = await fetchSources('ai launch space update');
      assert.strictEqual(serpCalls.length, 1);
      assert.strictEqual(sources.length, 3);
      assert.strictEqual(sources[0].url, 'https://example.com/news-ai');
      assert.strictEqual(sources[0].summary, 'Launch space update summary');
      assert.ok(sources.some((item) => item.url === 'https://different.com/story'));
    } finally {
      process.env.NEWS_API_KEY = originalNewsKey;
      globalThis.fetch = originalFetch;
    }
  });
});

