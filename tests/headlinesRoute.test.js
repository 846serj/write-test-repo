import assert from 'assert';
import fs from 'fs';
import * as ts from 'typescript';
import { beforeEach, test } from 'node:test';

const routePath = new URL('../src/app/api/headlines/route.ts', import.meta.url);
const tsSource = fs.readFileSync(routePath, 'utf8');

const sanitizedSource = tsSource
  .replace("import { NextRequest, NextResponse } from 'next/server';", '')
  .replace("import { XMLParser } from 'fast-xml-parser';", '')
  .replace("import he from 'he';", '')
  .replace("import { getOpenAI } from '../../../lib/openai';", '')
  .replace(
    "import { serpapiSearch, type SerpApiResult } from '../../../lib/serpapi';",
    ''
  );

const snippet = `
const NextResponse = globalThis.__nextResponse;
const getOpenAI = () => globalThis.__openai;
const fetch = globalThis.__fetch;
const serpapiSearch = (...args) => globalThis.__serpapiSearch(...args);
const { XMLParser } = globalThis.__fastXmlParser;
const he = globalThis.__he;
type SerpApiResult = any;
type NextRequest = any;
${sanitizedSource}
export { createHeadlinesHandler };
`;

const jsCode = ts
  .transpileModule(snippet, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  })
  .outputText;

const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(jsCode).toString('base64');

const nextResponseStub = {
  json(body, init) {
    return {
      body,
      status: init?.status ?? 200,
      async json() {
        return body;
      },
    };
  },
};

globalThis.__nextResponse = nextResponseStub;

globalThis.__fetchImpl = async () => {
  throw new Error('fetch not stubbed');
};

globalThis.__fetch = (...args) => globalThis.__fetchImpl(...args);

globalThis.__serpapiSearch = async () => {
  throw new Error('serpapi not stubbed');
};

globalThis.__openaiCreate = async () => {
  throw new Error('openai not stubbed');
};

globalThis.__openai = {
  chat: {
    completions: {
      create: (...args) => globalThis.__openaiCreate(...args),
    },
  },
};

const fastXmlParserModule = await import('fast-xml-parser');
globalThis.__fastXmlParser = fastXmlParserModule;

const heModule = await import('he');
globalThis.__he = heModule.default ?? heModule;

const { createHeadlinesHandler } = await import(moduleUrl);

function createRequest(body) {
  return {
    async json() {
      return body;
    },
  };
}

beforeEach(() => {
  process.env.NEWSAPI_API_KEY = 'test-key';
  globalThis.__fetchImpl = async () => {
    throw new Error('fetch not stubbed');
  };
  globalThis.__openaiCreate = async () => {
    throw new Error('openai not stubbed');
  };
  globalThis.__serpapiSearch = async () => {
    throw new Error('serpapi not stubbed');
  };
});

test('rejects requests without query or keywords', async () => {
  globalThis.__openaiCreate = async () => {
    throw new Error('should not call openai');
  };
  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const response = await handler(createRequest({ limit: 5 }));
  assert.strictEqual(response.status, 400);
  const body = await response.json();
  assert.strictEqual(
    body.error,
    'Either query, keywords, or description must be provided'
  );
});

test('infers keywords when only a description is provided', async () => {
  const openaiCalls = [];
  globalThis.__openaiCreate = async (options) => {
    openaiCalls.push(options);
    return {
      choices: [
        {
          message: {
            content: '{}',
          },
        },
      ],
    };
  };

  const fetchCalls = [];
  const descriptionQuery =
    'Focus on technology-driven AI robotics transforming hospital care.';
  const articlePayloads = {
    Focus: [
      {
        title: 'Focus Daily highlights precision nursing assistants',
        description: 'Clinics trial bedside robotic attendants with Focus insights',
        url: 'https://example.com/focus-1',
        source: { name: 'Focus Daily' },
        publishedAt: '2024-03-02T00:00:00Z',
      },
    ],
    technology: [
      {
        title: 'Technology budgets favor robotics',
        description: 'Chip investments target surgical automation',
        url: 'https://example.com/technology-1',
        source: { name: 'Tech World' },
        publishedAt: '2024-03-03T00:00:00Z',
      },
    ],
    driven: [
      {
        title: 'Data-driven staffing insights',
        description: 'Analytics reshape intensive care operations',
        url: 'https://example.com/driven-1',
        source: { name: 'Driven Report' },
        publishedAt: '2024-03-04T00:00:00Z',
      },
    ],
    robotics: [
      {
        title: 'Robotics upgrades improve grip',
        description: 'Engineers debut adaptive surgical tools',
        url: 'https://example.com/robotics-1',
        source: { name: 'Robotics Journal' },
        publishedAt: '2024-03-05T00:00:00Z',
      },
    ],
    transforming: [
      {
        title: 'Transforming rehab with AI coaches',
        description: 'Virtual assistants guide patient exercises',
        url: 'https://example.com/transforming-1',
        source: { name: 'Transforming Times' },
        publishedAt: '2024-03-06T00:00:00Z',
      },
    ],
  };
  globalThis.__fetchImpl = async (input) => {
    const url = new URL(input.toString());
    const query = url.searchParams.get('q') || '';
    const pageSize = Number(url.searchParams.get('pageSize'));
    const page = Number(url.searchParams.get('page'));

    if (query === descriptionQuery) {
      throw new Error('should not query with description text');
    }
    fetchCalls.push({ query, pageSize, page });

    const payload = articlePayloads[query] ?? [];
    const articles = payload.slice(0, pageSize);

    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return name === 'content-type' ? 'application/json' : null;
        },
      },
      async json() {
        return { status: 'ok', articles };
      },
      async text() {
        return JSON.stringify({ status: 'ok', articles });
      },
    };
  };

  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const description =
    'Focus on technology-driven AI robotics transforming hospital care.';
  const response = await handler(createRequest({ description, limit: 3 }));

  assert.strictEqual(response.status, 200);
  const body = await response.json();

  assert.strictEqual(openaiCalls.length, 1);
  assert.ok(openaiCalls[0].messages?.[1]?.content.includes(description));
  assert.deepStrictEqual(body.inferredKeywords, [
    'Focus',
    'technology',
    'driven',
    'robotics',
    'transforming',
  ]);
  assert.deepStrictEqual(body.queriesAttempted, [
    'Focus',
    'technology',
    'driven',
  ]);
  assert.deepStrictEqual(fetchCalls, [
    { query: 'Focus', pageSize: 1, page: 1 },
    { query: 'technology', pageSize: 1, page: 1 },
    { query: 'driven', pageSize: 1, page: 1 },
  ]);
  assert.ok(!fetchCalls.some((call) => call.query === 'robotics'));
  assert.ok(!fetchCalls.some((call) => call.query === 'transforming'));
  assert.ok(!body.queriesAttempted.includes(descriptionQuery));
  assert.strictEqual(body.successfulQueries, 3);
  assert.strictEqual(body.totalResults, 3);
  assert.strictEqual(body.headlines.length, 3);
  for (const headline of body.headlines) {
    assert.ok(!('summary' in headline));
  }
});

test('times out stalled RSS feeds and records warnings', async () => {
  const newsApiPayload = {
    status: 'ok',
    articles: [
      {
        title: 'Breaking tech news',
        description: 'New breakthrough announced.',
        url: 'https://example.com/article-1',
        source: { name: 'Example Times' },
        publishedAt: '2024-03-07T00:00:00Z',
      },
    ],
  };

  globalThis.__fetchImpl = async (input, init = {}) => {
    const url = input.toString();
    if (url.startsWith('https://newsapi.org/')) {
      return {
        ok: true,
        status: 200,
        headers: {
          get(name) {
            return name.toLowerCase() === 'content-type'
              ? 'application/json'
              : null;
          },
        },
        async json() {
          return newsApiPayload;
        },
        async text() {
          return JSON.stringify(newsApiPayload);
        },
      };
    }

    if (url === 'https://timeout.test/rss') {
      const { signal } = init;
      return await new Promise((_, reject) => {
        const rejectWithAbort = () => {
          const abortError = new Error('aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        };

        const timeoutId = setTimeout(rejectWithAbort, 250);

        if (signal) {
          if (signal.aborted) {
            clearTimeout(timeoutId);
            rejectWithAbort();
            return;
          }

          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timeoutId);
              rejectWithAbort();
            },
            { once: true }
          );
        }
      });
    }

    throw new Error(`unexpected request to ${url}`);
  };

  const handler = createHeadlinesHandler({
    fetchImpl: (...args) => globalThis.__fetchImpl(...args),
    logger: { error() {} },
    rssRequestTimeoutMs: 25,
  });

  const requestBody = {
    query: 'technology',
    limit: 1,
    rssFeeds: ['https://timeout.test/rss'],
  };

  const request = createRequest(requestBody);

  const start = Date.now();
  const response = await handler(request);
  const duration = Date.now() - start;

  assert.strictEqual(response.status, 200);
  assert(duration < 1000, 'handler should resolve within timeout window');

  const body = await response.json();
  assert(Array.isArray(body.headlines));
  assert.strictEqual(body.headlines.length, 1);
  assert(Array.isArray(body.warnings));
  assert(
    body.warnings.includes('RSS feed request timed out for https://timeout.test/rss')
  );
});

test('combines rss feeds with NewsAPI results', async () => {
  globalThis.__openaiCreate = async () => {
    throw new Error('should not call openai');
  };

  const rssUrlOne = 'https://example.com/feed-one';
  const rssUrlTwo = 'https://example.com/feed-two';
  const rssXmlOne = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed One</title>
    <item>
      <title>RSS One</title>
      <link>https://example.com/story-one</link>
      <description>RSS description one</description>
      <pubDate>Fri, 05 Jul 2024 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;
  const rssXmlTwo = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed Two</title>
    <item>
      <title>RSS Two</title>
      <link>https://example.com/story-two</link>
      <description>RSS description two</description>
      <pubDate>Thu, 04 Jul 2024 15:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

  const newsArticles = [
    {
      title: 'NewsAPI Headline One',
      description: 'News description one',
      url: 'https://news.example.com/story-one',
      source: { name: 'NewsAPI Source' },
      publishedAt: '2024-06-30T08:00:00Z',
    },
    {
      title: 'NewsAPI Headline Two',
      description: 'News description two',
      url: 'https://news.example.com/story-two',
      source: { name: 'NewsAPI Source' },
      publishedAt: '2024-06-29T08:00:00Z',
    },
    {
      title: 'NewsAPI Headline Three',
      description: 'News description three',
      url: 'https://news.example.com/story-three',
      source: { name: 'NewsAPI Source' },
      publishedAt: '2024-06-28T08:00:00Z',
    },
  ];

  globalThis.__fetchImpl = async (input) => {
    const url = input.toString();
    if (url.startsWith('https://newsapi.org')) {
      return {
        ok: true,
        status: 200,
        headers: {
          get(name) {
            return name === 'content-type' ? 'application/json' : null;
          },
        },
        async json() {
          return { status: 'ok', articles: newsArticles };
        },
        async text() {
          return JSON.stringify({ status: 'ok', articles: newsArticles });
        },
      };
    }

    if (url === rssUrlOne) {
      return {
        ok: true,
        status: 200,
        async text() {
          return rssXmlOne;
        },
      };
    }

    if (url === rssUrlTwo) {
      return {
        ok: true,
        status: 200,
        async text() {
          return rssXmlTwo;
        },
      };
    }

    throw new Error(`Unexpected fetch request: ${url}`);
  };

  globalThis.__serpapiSearch = async () => [];

  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const response = await handler(
    createRequest({
      query: 'space exploration',
      limit: 3,
      rssFeeds: [rssUrlOne, rssUrlTwo],
      from: '2024-06-20T00:00:00.000Z',
      to: '2024-07-10T23:59:59.000Z',
    })
  );

  assert.strictEqual(response.status, 200);
  const body = await response.json();

  assert.strictEqual(body.headlines.length, 3);
  const titles = new Set(body.headlines.map((item) => item.title));
  assert.ok(titles.has('RSS One'));
  assert.ok(titles.has('RSS Two'));
  assert.ok(titles.has('NewsAPI Headline One'));

  const rssOne = body.headlines.find((item) => item.title === 'RSS One');
  assert.ok(rssOne);
  assert.strictEqual(rssOne.source, 'Example Feed One');

  const rssTwo = body.headlines.find((item) => item.title === 'RSS Two');
  assert.ok(rssTwo);
  assert.strictEqual(rssTwo.source, 'Example Feed Two');

  assert.ok(
    body.queriesAttempted.some(
      (entry) =>
        entry === 'space exploration' || entry === '"space exploration"'
    )
  );
  assert.ok(
    body.queriesAttempted.some((entry) => entry.includes('RSS: Example Feed One'))
  );
  assert.ok(
    body.queriesAttempted.some((entry) => entry.includes('RSS: Example Feed Two'))
  );

  assert.strictEqual(body.successfulQueries, 3);
});

test('fetches RSS feeds before NewsAPI queries', async () => {
  globalThis.__openaiCreate = async () => {
    throw new Error('should not call openai');
  };

  const rssUrl = 'https://ordering.test/rss';
  const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Ordering Feed</title>
    <item>
      <title>Ordering RSS Headline</title>
      <link>https://ordering.test/story</link>
      <description>Ordering description</description>
      <pubDate>Wed, 10 Jul 2024 09:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

  const newsArticles = [
    {
      title: 'Ordering News Headline',
      description: 'News description',
      url: 'https://news.example.com/ordering-story',
      source: { name: 'Ordering News Source' },
      publishedAt: '2024-07-10T09:00:00Z',
    },
  ];

  const fetchCalls = [];
  globalThis.__fetchImpl = async (input) => {
    const url = input.toString();
    fetchCalls.push(url);

    if (url === rssUrl) {
      return {
        ok: true,
        status: 200,
        async text() {
          return rssXml;
        },
      };
    }

    if (url.startsWith('https://newsapi.org')) {
      return {
        ok: true,
        status: 200,
        headers: {
          get(name) {
            return name === 'content-type' ? 'application/json' : null;
          },
        },
        async json() {
          return { status: 'ok', articles: newsArticles };
        },
        async text() {
          return JSON.stringify({ status: 'ok', articles: newsArticles });
        },
      };
    }

    throw new Error(`Unexpected fetch request: ${url}`);
  };

  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const response = await handler(
    createRequest({
      query: 'climate change',
      limit: 2,
      rssFeeds: [rssUrl],
    })
  );

  assert.strictEqual(response.status, 200);
  const body = await response.json();

  assert.ok(fetchCalls.length >= 2);
  assert.strictEqual(fetchCalls[0], rssUrl);
  const firstNewsIndex = fetchCalls.findIndex((url) =>
    url.startsWith('https://newsapi.org')
  );
  assert(firstNewsIndex > 0, 'NewsAPI should be requested after RSS feeds');

  assert.ok(body.queriesAttempted.length >= 2);
  assert.ok(body.queriesAttempted[0].startsWith('RSS:'));
  assert.ok(
    body.queriesAttempted.some(
      (entry) => entry === 'climate change' || entry === '"climate change"'
    )
  );
});

test('filters RSS headlines using from/to date range', async () => {
  globalThis.__openaiCreate = async () => {
    throw new Error('should not call openai');
  };

  const rssUrl = 'https://filter.test/rss';
  const rssItemsXml = Array.from({ length: 60 }, (_, index) => {
    const isBeforeRange = index < 55;
    const isInRange = index === 55;
    const title = isInRange
      ? `Inside Range ${index + 1}`
      : isBeforeRange
        ? `Before Range ${index + 1}`
        : `After Range ${index + 1}`;
    const pubDate = isInRange
      ? '2024-03-05T12:00:00Z'
      : isBeforeRange
        ? '2024-03-04T12:00:00Z'
        : '2024-03-07T00:00:00Z';
    return `    <item>\n      <title>${title}</title>\n      <link>https://filter.test/item-${index + 1}</link>\n      <pubDate>${pubDate}</pubDate>\n    </item>`;
  }).join('\n');
  const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Filter Feed</title>
${rssItemsXml}
  </channel>
</rss>`;

  const emptyNewsPayload = { status: 'ok', articles: [] };

  globalThis.__fetchImpl = async (input) => {
    const url = input.toString();

    if (url === rssUrl) {
      return {
        ok: true,
        status: 200,
        async text() {
          return rssXml;
        },
      };
    }

    if (url.startsWith('https://newsapi.org')) {
      return {
        ok: true,
        status: 200,
        headers: {
          get(name) {
            return name === 'content-type' ? 'application/json' : null;
          },
        },
        async json() {
          return emptyNewsPayload;
        },
        async text() {
          return JSON.stringify(emptyNewsPayload);
        },
      };
    }

    throw new Error(`Unexpected fetch request: ${url}`);
  };

  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const response = await handler(
    createRequest({
      query: 'filter example',
      limit: 3,
      rssFeeds: [rssUrl],
      from: '2024-03-05T00:00:00.000Z',
      to: '2024-03-06T23:59:59.000Z',
    })
  );

  assert.strictEqual(response.status, 200);
  const body = await response.json();

  const titles = body.headlines.map((item) => item.title);
  assert.deepStrictEqual(
    new Set(titles),
    new Set(['Inside Range 56'])
  );
  assert.strictEqual(body.headlines.length, 1);
  assert.ok(titles.every((title) => title.startsWith('Inside Range')));
  assert.ok(!titles.some((title) => title.startsWith('Before Range')));
  assert.ok(!titles.some((title) => title.startsWith('After Range')));
});

test('includes RSS articles on the to date when provided as date-only', async () => {
  globalThis.__openaiCreate = async () => {
    throw new Error('should not call openai');
  };

  const rssUrl = 'https://boundary.example/rss';
  const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Boundary Feed</title>
    <item>
      <title>From Range Bulletin</title>
      <link>https://boundary.example/from</link>
      <pubDate>2024-03-05T08:00:00Z</pubDate>
    </item>
    <item>
      <title>Boundary Day Dispatch</title>
      <link>https://boundary.example/to</link>
      <pubDate>2024-03-06T23:30:00Z</pubDate>
    </item>
    <item>
      <title>After Range Report</title>
      <link>https://boundary.example/after</link>
      <pubDate>2024-03-07T00:00:00Z</pubDate>
    </item>
  </channel>
</rss>`;

  const newsRequests = [];
  const emptyNewsPayload = { status: 'ok', articles: [] };

  globalThis.__fetchImpl = async (input) => {
    const url = input.toString();

    if (url === rssUrl) {
      return {
        ok: true,
        status: 200,
        async text() {
          return rssXml;
        },
      };
    }

    if (url.startsWith('https://newsapi.org')) {
      const requestUrl = new URL(url);
      newsRequests.push({
        from: requestUrl.searchParams.get('from'),
        to: requestUrl.searchParams.get('to'),
      });
      return {
        ok: true,
        status: 200,
        headers: {
          get(name) {
            return name === 'content-type' ? 'application/json' : null;
          },
        },
        async json() {
          return emptyNewsPayload;
        },
        async text() {
          return JSON.stringify(emptyNewsPayload);
        },
      };
    }

    throw new Error(`Unexpected fetch request: ${url}`);
  };

  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const response = await handler(
    createRequest({
      query: 'boundary coverage',
      rssFeeds: [rssUrl],
      limit: 5,
      from: '2024-03-05',
      to: '2024-03-06',
    })
  );

  assert.strictEqual(response.status, 200);
  const body = await response.json();

  const titles = body.headlines.map((item) => item.title);
  assert.deepStrictEqual(
    new Set(titles),
    new Set(['From Range Bulletin', 'Boundary Day Dispatch'])
  );
  assert.ok(!titles.includes('After Range Report'));

  assert.ok(
    newsRequests.some((request) => request.to === '2024-03-06T23:59:59.999Z')
  );
  assert.ok(
    newsRequests.some((request) => request.from === '2024-03-05T00:00:00.000Z')
  );
});

test('decodes HTML entities from NewsAPI, RSS, and SERP results', async () => {
  const originalSerpKey = process.env.SERPAPI_KEY;
  process.env.SERPAPI_KEY = 'serp-test-key';

  const rssUrl = 'https://example.com/encoded-feed';
  const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Neuro &#8216;Updates&#8217;</title>
    <item>
      <title>Machine learning enables &#8216;mind reading&#8217; insights</title>
      <link>https://example.com/rss-story</link>
      <description>Decoded &#8220;insights&#8221; emerge from trials</description>
      <pubDate>Fri, 05 Jul 2024 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

  const newsArticles = [
    {
      title: 'Breakthrough &#8216;neural&#8217; interface',
      description: 'Researchers call it &#8220;revolutionary&#8221;.',
      url: 'https://example.com/news-story',
      source: { name: 'Innovation &#038; Today' },
      publishedAt: '2024-06-30T00:00:00Z',
    },
  ];

  const serpResults = [
    {
      title: 'AI achieves &#8216;telepathy&#8217; milestone',
      link: 'https://example.com/serp-story',
      snippet: 'New model reads &#8220;thoughts&#8221; during trials',
      source: 'Tech &#038; Science Daily',
      date: '2024-07-02T00:00:00Z',
    },
  ];

  globalThis.__fetchImpl = async (input) => {
    const url = input.toString();
    if (url.startsWith('https://newsapi.org')) {
      return {
        ok: true,
        status: 200,
        headers: {
          get(name) {
            return name === 'content-type' ? 'application/json' : null;
          },
        },
        async json() {
          return { status: 'ok', articles: newsArticles };
        },
        async text() {
          return JSON.stringify({ status: 'ok', articles: newsArticles });
        },
      };
    }

    if (url === rssUrl) {
      return {
        ok: true,
        status: 200,
        async text() {
          return rssXml;
        },
      };
    }

    throw new Error(`Unexpected fetch request: ${url}`);
  };

  globalThis.__serpapiSearch = async () => serpResults;

  try {
    const handler = createHeadlinesHandler({ logger: { error() {} } });
    const response = await handler(
      createRequest({
        query: 'mind reading breakthroughs',
        limit: 5,
        rssFeeds: [rssUrl],
        from: '2024-06-20T00:00:00.000Z',
        to: '2024-07-10T23:59:59.000Z',
      })
    );

    assert.strictEqual(response.status, 200);
    const body = await response.json();

    const newsHeadline = body.headlines.find(
      (item) => item.url === 'https://example.com/news-story'
    );
    assert.ok(newsHeadline, 'expected news headline');
    assert.strictEqual(newsHeadline.title, "Breakthrough 'neural' interface");
    assert.strictEqual(newsHeadline.description, 'Researchers call it "revolutionary".');
    assert.strictEqual(newsHeadline.source, 'Innovation & Today');

    const rssHeadline = body.headlines.find(
      (item) => item.url === 'https://example.com/rss-story'
    );
    assert.ok(rssHeadline, 'expected rss headline');
    assert.strictEqual(
      rssHeadline.title,
      "Machine learning enables 'mind reading' insights"
    );
    assert.strictEqual(rssHeadline.description, 'Decoded "insights" emerge from trials');
    assert.strictEqual(rssHeadline.source, "Neuro 'Updates'");

    const serpHeadline = body.headlines.find(
      (item) => item.url === 'https://example.com/serp-story'
    );
    assert.ok(serpHeadline, 'expected serp headline');
    assert.strictEqual(serpHeadline.title, "AI achieves 'telepathy' milestone");
    assert.strictEqual(serpHeadline.description, 'New model reads "thoughts" during trials');
    assert.strictEqual(serpHeadline.source, 'Tech & Science Daily');
  } finally {
    if (originalSerpKey === undefined) {
      delete process.env.SERPAPI_KEY;
    } else {
      process.env.SERPAPI_KEY = originalSerpKey;
    }
  }
});

test('filters out keyword results that do not mention the keyword', async () => {
  globalThis.__openaiCreate = async () => {
    throw new Error('should not call openai');
  };

  const keyword = 'renewable energy';
  const fetchCalls = [];
  globalThis.__fetchImpl = async (input) => {
    const url = new URL(input.toString());
    const query = url.searchParams.get('q') || '';
    const pageSize = Number(url.searchParams.get('pageSize'));
    const page = Number(url.searchParams.get('page'));

    fetchCalls.push({ query, pageSize, page });

    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return name === 'content-type' ? 'application/json' : null;
        },
      },
      async json() {
        return {
          status: 'ok',
          totalResults: 1,
          articles: [
            {
              title: 'Global markets rally as tech stocks surge',
              description: 'Investors celebrate broad market gains led by software companies.',
              url: 'https://example.com/markets',
              source: { name: 'Finance Daily' },
              publishedAt: '2024-07-01T08:00:00Z',
            },
          ],
        };
      },
    };
  };

  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const response = await handler(
    createRequest({ keywords: [keyword], limit: 3 })
  );

  assert.strictEqual(response.status, 200);
  const body = await response.json();

  assert.deepStrictEqual(body.headlines, []);
  assert.strictEqual(body.totalResults, 0);
  assert.ok(
    !body.keywordHeadlines || body.keywordHeadlines.length === 0,
    'keyword groups should be empty when all candidates are filtered'
  );

  assert.deepStrictEqual(fetchCalls, [
    { query: '"renewable energy"', pageSize: 3, page: 1 },
  ]);
});

test('later keyword searches contribute unique headlines', async () => {
  globalThis.__openaiCreate = async () => {
    throw new Error('should not call openai');
  };

  const manualQuery = 'deep space';
  const combinedKeywords = 'Mars AND Jupiter';
  const responses = new Map([
    [
      `${manualQuery}|1`,
      [
        {
          title: 'Deep space telescope update',
          description: 'Old update from telescope',
          url: 'https://example.com/deep-space-1',
          source: { name: 'Legacy Source' },
          publishedAt: '2024-06-01T00:00:00Z',
        },
      ],
    ],
    [
      `${combinedKeywords}|1`,
      [
        {
          title: 'Mars and Jupiter alignment',
          description: 'Older planetary alignment news',
          url: 'https://example.com/alignment',
          source: { name: 'Planet News' },
          publishedAt: '2024-06-03T00:00:00Z',
        },
      ],
    ],
    [
      'Mars|1',
      [
        {
          title: 'Fresh Mars rover discovery',
          description: 'Brand new rover discovery',
          url: 'https://example.com/mars-rover',
          source: { name: 'Modern Science' },
          publishedAt: '2024-07-05T09:00:00Z',
        },
      ],
    ],
    [
      'Jupiter|1',
      [
        {
          title: 'New Jupiter storm observed',
          description: 'Recent observation from probe',
          url: 'https://example.com/jupiter-storm',
          source: { name: 'Modern Science' },
          publishedAt: '2024-07-04T10:00:00Z',
        },
      ],
    ],
  ]);

  const fetchCalls = [];
  globalThis.__fetchImpl = async (input) => {
    const url = new URL(input.toString());
    const query = url.searchParams.get('q') || '';
    const pageSize = Number(url.searchParams.get('pageSize'));
    const page = Number(url.searchParams.get('page'));
    fetchCalls.push({ query, pageSize, page });
    const articles = responses.get(`${query}|${page}`) ?? [];
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return name === 'content-type' ? 'application/json' : null;
        },
      },
      async json() {
        return { status: 'ok', articles };
      },
      async text() {
        return JSON.stringify({ status: 'ok', articles });
      },
    };
  };

  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const response = await handler(
    createRequest({
      query: manualQuery,
      keywords: ['Mars', 'Jupiter'],
      limit: 4,
    })
  );

  assert.strictEqual(response.status, 200);
  const body = await response.json();

  assert.ok(
    body.headlines.some((item) => item.url === 'https://example.com/mars-rover')
  );
  assert.ok(
    body.headlines.some(
      (item) => item.url === 'https://example.com/jupiter-storm'
    )
  );

  assert.ok(
    body.queriesAttempted.includes('Mars') &&
      body.queriesAttempted.includes('Jupiter')
  );

  const marsCalls = fetchCalls.filter((entry) => entry.query === 'Mars');
  const jupiterCalls = fetchCalls.filter((entry) => entry.query === 'Jupiter');
  assert.ok(marsCalls.length >= 1);
  assert.ok(jupiterCalls.length >= 1);

  assert.ok(body.successfulQueries >= 3);
});

test('aggregates deduplicated results for derived keyword queries', async () => {
  globalThis.__openaiCreate = async () => {
    throw new Error('should not call openai');
  };

  const responses = new Map([
    [
      'AI|1',
      [
        {
          title: 'AI-powered robotic surgeons',
          description: 'AI robotic surgeons assist in operations',
          url: 'https://example.com/1',
          source: { name: 'Source A' },
          publishedAt: '2024-01-01T00:00:00Z',
        },
      ],
    ],
    [
      'Robotics|1',
      [
        {
          title: 'Robotics duplicate entry',
          description: 'Robotics duplicate entry for deduplication test',
          url: 'https://example.com/1',
          source: { name: 'Source A' },
          publishedAt: '2024-01-01T00:00:00Z',
        },
      ],
    ],
    [
      'healthcare|1',
      [
        {
          title: 'AI in hospitals',
          description: 'Hospitals adopt AI for healthcare patient care',
          url: 'https://example.com/2',
          source: { name: 'Source B' },
          publishedAt: '2024-01-02T00:00:00Z',
        },
        {
          title: 'Care robots expand in healthcare',
          description: 'Care robots enter more healthcare clinics',
          url: 'https://example.com/3',
          source: { name: 'Source C' },
          publishedAt: '2024-01-03T00:00:00Z',
        },
      ],
    ],
  ]);

  const fetchCalls = [];
  globalThis.__fetchImpl = async (input) => {
    const url = new URL(input.toString());
    const query = url.searchParams.get('q') || '';
    const pageSize = Number(url.searchParams.get('pageSize'));
    const page = Number(url.searchParams.get('page'));
    fetchCalls.push({ query, pageSize, page });
    const articles = responses.get(`${query}|${page}`) ?? [];
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return name === 'content-type' ? 'application/json' : null;
        },
      },
      async json() {
        return { status: 'ok', articles };
      },
      async text() {
        return JSON.stringify({ status: 'ok', articles });
      },
    };
  };

  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const response = await handler(
    createRequest({ keywords: ['AI ', 'Robotics', 'healthcare'], limit: 3 })
  );

  assert.strictEqual(response.status, 200);
  const body = await response.json();

  assert.deepStrictEqual(body.queriesAttempted, ['AI', 'Robotics', 'healthcare']);
  assert.strictEqual(body.successfulQueries, 3);
  assert.strictEqual(body.totalResults, 3);
  assert.strictEqual(body.headlines.length, 3);
  for (const headline of body.headlines) {
    assert.ok(!('summary' in headline));
  }
  assert.deepStrictEqual(
    body.headlines
      .map((item) => item.url)
      .sort(),
    ['https://example.com/1', 'https://example.com/2', 'https://example.com/3']
      .sort()
  );
  assert.deepStrictEqual(fetchCalls, [
    { query: 'AI', pageSize: 1, page: 1 },
    { query: 'Robotics', pageSize: 1, page: 1 },
    { query: 'healthcare', pageSize: 2, page: 1 },
  ]);
});

test('uses query and keyword fallbacks to reach the limit', async () => {
  globalThis.__openaiCreate = async () => {
    throw new Error('should not call openai');
  };

  const responses = new Map([
    [
      'innovation|1',
      [
        {
          title: 'Innovation leaps ahead',
          description: 'Innovation leaps ahead globally',
          url: 'https://example.com/a',
          source: { name: 'Source A' },
          publishedAt: '2024-01-01T00:00:00Z',
        },
        {
          title: 'Next-gen materials emerge',
          description: 'New materials support breakthroughs',
          url: 'https://example.com/b',
          source: { name: 'Source B' },
          publishedAt: '2024-01-02T00:00:00Z',
        },
    ],
  ],
  ['innovation|2', []],
  [
      'biology|1',
      [
        {
          title: 'Genome editing milestones',
          description: 'Genome editing biology reaches new milestones',
          url: 'https://example.com/c',
          source: { name: 'Source C' },
          publishedAt: '2024-01-03T00:00:00Z',
        },
      ],
    ],
    [
      'space|1',
      [
        {
          title: 'Space agency Mars mission update',
          description: 'Space mission update released for Mars expedition',
          url: 'https://example.com/d',
          source: { name: 'Source D' },
          publishedAt: '2024-01-04T00:00:00Z',
        },
      ],
    ],
  ]);

  const fetchCalls = [];
  globalThis.__fetchImpl = async (input) => {
    const url = new URL(input.toString());
    const query = url.searchParams.get('q') || '';
    const pageSize = Number(url.searchParams.get('pageSize'));
    const page = Number(url.searchParams.get('page'));
    fetchCalls.push({ query, pageSize, page });
    const articles = responses.get(`${query}|${page}`) ?? [];
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return name === 'content-type' ? 'application/json' : null;
        },
      },
      async json() {
        return { status: 'ok', articles };
      },
      async text() {
        return JSON.stringify({ status: 'ok', articles });
      },
    };
  };

  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const response = await handler(
    createRequest({ query: 'innovation', keywords: ['biology', 'space'], limit: 4 })
  );

  assert.strictEqual(response.status, 200);
  const body = await response.json();

  assert.deepStrictEqual(body.queriesAttempted, [
    'innovation',
    'biology',
    'space',
  ]);
  assert.deepStrictEqual(fetchCalls, [
    { query: 'innovation', pageSize: 4, page: 1 },
    { query: 'biology', pageSize: 1, page: 1 },
    { query: 'space', pageSize: 1, page: 1 },
  ]);
  assert.strictEqual(body.successfulQueries, 3);
  assert.strictEqual(body.totalResults, 4);
  assert.deepStrictEqual(
    body.headlines
      .map((item) => item.title)
      .sort(),
    [
      'Innovation leaps ahead',
      'Next-gen materials emerge',
      'Genome editing milestones',
      'Space agency Mars mission update',
    ].sort()
  );
});

test('continues paging when earlier results include duplicates', async () => {
  globalThis.__openaiCreate = async () => {
    return {
      choices: [
        {
          message: {
            content: '["second focus"]',
          },
        },
      ],
    };
  };

  const responses = new Map([
      [
        'first spotlight|1',
        [
          {
            title: 'Alpha insight from first spotlight',
            description: 'Alpha insight analysis from the first spotlight report',
            url: 'https://example.com/a',
            source: { name: 'Source A' },
            publishedAt: '2024-02-01T00:00:00Z',
          },
          {
            title: 'Beta developments in first spotlight',
            description: 'Beta developments update from the first spotlight series',
            url: 'https://example.com/b',
            source: { name: 'Source B' },
            publishedAt: '2024-02-02T00:00:00Z',
          },
        ],
    ],
      [
        'first spotlight|2',
        [
          {
            title: 'Alpha insight from first spotlight',
            description: 'Alpha insight analysis from the first spotlight report',
            url: 'https://example.com/a',
            source: { name: 'Source A' },
            publishedAt: '2024-02-01T00:00:00Z',
          },
          {
            title: 'Beta developments in first spotlight',
            description: 'Beta developments update from the first spotlight series',
            url: 'https://example.com/b',
            source: { name: 'Source B' },
            publishedAt: '2024-02-02T00:00:00Z',
          },
        ],
      ],
      [
        '"second focus"|1',
        [
          {
            title: 'Alpha insight references second focus',
            description: 'Alpha insight analysis covering the second focus topic',
            url: 'https://example.com/a',
            source: { name: 'Source A' },
            publishedAt: '2024-02-01T00:00:00Z',
          },
          {
            title: 'Gamma outlook on second focus',
            description: 'Gamma outlook overview exploring the second focus theme',
            url: 'https://example.com/c',
            source: { name: 'Source C' },
            publishedAt: '2024-02-03T00:00:00Z',
          },
        ],
      ],
      [
        '"second focus"|2',
        [
          {
            title: 'Delta forecast for the second focus',
            description: 'Delta forecast briefing on the second focus topic',
            url: 'https://example.com/d',
            source: { name: 'Source D' },
            publishedAt: '2024-02-04T00:00:00Z',
          },
        ],
      ],
  ]);

  const fetchCalls = [];
  globalThis.__fetchImpl = async (input) => {
    const url = new URL(input.toString());
    const query = url.searchParams.get('q') || '';
    const pageSize = Number(url.searchParams.get('pageSize'));
    const page = Number(url.searchParams.get('page'));
    fetchCalls.push({ query, pageSize, page });
    const articles = responses.get(`${query}|${page}`) ?? [];
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return name === 'content-type' ? 'application/json' : null;
        },
      },
      async json() {
        return { status: 'ok', articles };
      },
      async text() {
        return JSON.stringify({ status: 'ok', articles });
      },
    };
  };

  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const response = await handler(
    createRequest({ query: 'first spotlight', keywords: ['second focus'], limit: 4 })
  );

  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.deepStrictEqual(body.queriesAttempted, ['first spotlight', '"second focus"']);
  assert.strictEqual(body.successfulQueries, 2);
  assert.strictEqual(body.totalResults, 4);
  assert.deepStrictEqual(
    body.headlines
      .map((item) => item.url)
      .sort(),
    [
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
      'https://example.com/d',
    ].sort()
  );
  assert.deepStrictEqual(fetchCalls, [
    { query: 'first spotlight', pageSize: 4, page: 1 },
    { query: '"second focus"', pageSize: 2, page: 1 },
    { query: '"second focus"', pageSize: 1, page: 2 },
  ]);
});

test('builds keyword query without OpenAI assistance', async () => {
  let openaiCalls = 0;
  globalThis.__openaiCreate = async () => {
    openaiCalls += 1;
    throw new Error('openai should not be called for direct keyword searches');
  };

  const allowedQueries = new Set(['"renewable energy"', 'investment']);
  globalThis.__fetchImpl = async (input) => {
    const url = new URL(input.toString());
    const query = url.searchParams.get('q') || '';
    assert.ok(allowedQueries.has(query));
    const articlesByQuery = {
      '"renewable energy"': [
        {
          title: 'Renewable energy investments climb',
          description: 'Investments in renewable energy climb globally.',
          url: 'https://example.com/renewable',
          source: { name: 'Energy Daily' },
          publishedAt: '2024-07-01T00:00:00Z',
        },
      ],
      investment: [
        {
          title: 'Solar funding surges',
          description: 'Solar funding investment surges across multiple markets.',
          url: 'https://example.com/solar',
          source: { name: 'Solar Journal' },
          publishedAt: '2024-07-02T00:00:00Z',
        },
      ],
    };
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return name === 'content-type' ? 'application/json' : null;
        },
      },
      async json() {
        return {
          status: 'ok',
          articles: articlesByQuery[query] ?? [],
        };
      },
      async text() {
        return JSON.stringify({ status: 'ok', articles: [] });
      },
    };
  };

  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const response = await handler(
    createRequest({ keywords: ['renewable energy', 'investment'], limit: 2 })
  );

  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.deepStrictEqual(body.queriesAttempted, ['"renewable energy"', 'investment']);
  assert.strictEqual(body.successfulQueries, 2);
  assert.strictEqual(body.totalResults, 2);
  assert.strictEqual(body.headlines.length, 2);
  for (const headline of body.headlines) {
    assert.ok(!('summary' in headline));
  }
  assert.strictEqual(openaiCalls, 0);
});

test('default dedupe keeps near-matching headlines separate', async () => {
  globalThis.__openaiCreate = async () => {
    throw new Error('should not call openai');
  };

  const articles = [
    {
      title: 'AI testing leaps ahead',
      description: 'A new AI testing framework leaps ahead in clinical trials.',
      url: 'https://example.com/ai-testing-leaps',
      source: { name: 'Tech Source' },
      publishedAt: '2024-07-01T10:00:00Z',
    },
    {
      title: 'AI tests leap ahead',
      description: 'Latest AI tests leap ahead amid new frameworks and trials.',
      url: 'https://example.com/ai-tests-leap',
      source: { name: 'Science Daily' },
      publishedAt: '2024-07-01T12:00:00Z',
    },
  ];

  const newsApiUrl = 'https://newsapi.org/v2/everything';

  globalThis.__fetchImpl = async (input) => {
    const url = input.toString();
    if (url.startsWith(newsApiUrl)) {
      return {
        ok: true,
        status: 200,
        headers: {
          get(name) {
            return name === 'content-type' ? 'application/json' : null;
          },
        },
        async json() {
          return { status: 'ok', articles };
        },
        async text() {
          return JSON.stringify({ status: 'ok', articles });
        },
      };
    }

    throw new Error(`Unexpected request: ${url}`);
  };

  globalThis.__serpapiSearch = async () => {
    throw new Error('serpapi should not be called');
  };

  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const response = await handler(
    createRequest({ query: 'ai testing breakthroughs', limit: 5 })
  );

  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.strictEqual(body.headlines.length, 2);
  const returnedUrls = body.headlines.map((item) => item.url).sort();
  assert.deepStrictEqual(returnedUrls, [
    'https://example.com/ai-testing-leaps',
    'https://example.com/ai-tests-leap',
  ]);
  for (const headline of body.headlines) {
    assert.ok(!headline.relatedArticles);
  }
});

test('strict dedupe collapses near-matching headlines', async () => {
  globalThis.__openaiCreate = async () => {
    throw new Error('should not call openai');
  };

  const articles = [
    {
      title: 'AI testing leaps ahead',
      description: 'A new AI testing framework leaps ahead in clinical trials.',
      url: 'https://example.com/ai-testing-leaps',
      source: { name: 'Tech Source' },
      publishedAt: '2024-07-01T10:00:00Z',
    },
    {
      title: 'AI tests leap ahead',
      description: 'Latest AI tests leap ahead amid new frameworks and trials.',
      url: 'https://example.com/ai-tests-leap',
      source: { name: 'Science Daily' },
      publishedAt: '2024-07-01T12:00:00Z',
    },
  ];

  const newsApiUrl = 'https://newsapi.org/v2/everything';

  globalThis.__fetchImpl = async (input) => {
    const url = input.toString();
    if (url.startsWith(newsApiUrl)) {
      return {
        ok: true,
        status: 200,
        headers: {
          get(name) {
            return name === 'content-type' ? 'application/json' : null;
          },
        },
        async json() {
          return { status: 'ok', articles };
        },
        async text() {
          return JSON.stringify({ status: 'ok', articles });
        },
      };
    }

    throw new Error(`Unexpected request: ${url}`);
  };

  globalThis.__serpapiSearch = async () => {
    throw new Error('serpapi should not be called');
  };

  const handler = createHeadlinesHandler({ logger: { error() {} } });
  const response = await handler(
    createRequest({
      query: 'ai testing breakthroughs',
      limit: 5,
      dedupeMode: 'strict',
    })
  );

  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.strictEqual(body.headlines.length, 1);
  const [headline] = body.headlines;
  assert.strictEqual(headline.url, 'https://example.com/ai-testing-leaps');
  assert.ok(Array.isArray(headline.relatedArticles));
  assert.strictEqual(headline.relatedArticles.length, 1);
  const related = headline.relatedArticles[0];
  assert.strictEqual(related.url, 'https://example.com/ai-tests-leap');
  assert.ok(related.title.includes('AI tests'));
});

test('falls back to SERP with a default time filter when NewsAPI has no results', async () => {
  const originalSerpKey = process.env.SERPAPI_KEY;
  process.env.SERPAPI_KEY = 'serp-test-key';

  const serpCalls = [];
  const fixedNow = Date.UTC(2024, 6, 31, 12, 0, 0);
  const realDateNow = Date.now;
  Date.now = () => fixedNow;
  const defaultTo = new Date(fixedNow).toISOString().slice(0, 10);
  const fromDate = new Date(fixedNow);
  fromDate.setUTCDate(fromDate.getUTCDate() - 30);
  const defaultFrom = fromDate.toISOString().slice(0, 10);

  globalThis.__fetchImpl = async (input) => {
    const url = new URL(input.toString());

    assert.strictEqual(url.searchParams.get('from'), defaultFrom);
    assert.strictEqual(url.searchParams.get('to'), defaultTo);

    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return name === 'content-type' ? 'application/json' : null;
        },
      },
      async json() {
        return { status: 'ok', articles: [] };
      },
      async text() {
        return JSON.stringify({ status: 'ok', articles: [] });
      },
    };
  };

  globalThis.__serpapiSearch = async (options) => {
    serpCalls.push(options);
    return [];
  };

  try {
    const handler = createHeadlinesHandler({ logger: { error() {} } });
    const response = await handler(
      createRequest({ query: 'breaking updates', limit: 3 })
    );

    assert.strictEqual(response.status, 200);
    await response.json();

    assert.strictEqual(serpCalls.length, 2);
    for (const call of serpCalls) {
      assert.strictEqual(call.extraParams?.tbs, 'qdr:m');
    }
  } finally {
    Date.now = realDateNow;
    if (originalSerpKey === undefined) {
      delete process.env.SERPAPI_KEY;
    } else {
      process.env.SERPAPI_KEY = originalSerpKey;
    }
  }
});
