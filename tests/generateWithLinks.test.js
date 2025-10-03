import assert from 'assert';
import fs from 'fs';
import * as ts from 'typescript';
import { test } from 'node:test';

const routePath = new URL('../src/app/api/generate/route.ts', import.meta.url);
const tsCode = fs.readFileSync(routePath, 'utf8');

const minLinksMatch = tsCode.match(/const MIN_LINKS = \d+;/);
const strictRetryMatch = tsCode.match(
  /const STRICT_LINK_RETRY_THRESHOLD = \d+;/
);
const lengthExpansionMatch = tsCode.match(
  /const LENGTH_EXPANSION_ATTEMPTS = \d+;/
);
const factualTempMatch = tsCode.match(/const FACTUAL_TEMPERATURE\s*=\s*[^;]+;/);
const modelLimitsMatch = tsCode.match(/const MODEL_CONTEXT_LIMITS[\s\S]*?};/);
const safetyMarginMatch = tsCode.match(/const COMPLETION_SAFETY_MARGIN_TOKENS\s*=\s*\d+;/);
if (!safetyMarginMatch) {
  throw new Error('Failed to locate completion safety margin constant');
}
const normalizeTitleMatch = tsCode.match(/function normalizeTitleValue[\s\S]*?\n\}/);
const normalizeHrefMatch = tsCode.match(/function normalizeHrefValue[\s\S]*?\n\}/);
const buildVariantsMatch = tsCode.match(
  /function buildUrlVariants[\s\S]*?return Array\.from\(variants\);\n\}/
);
const cleanOutputMatch = tsCode.match(/function cleanModelOutput[\s\S]*?\n\}/);
const findMissingMatch = tsCode.match(/function findMissingSources[\s\S]*?\n\}/);
const helpersStart = tsCode.indexOf('function escapeHtml');
const generateWithLinksIndex = tsCode.indexOf('async function generateWithLinks');
if (helpersStart === -1 || generateWithLinksIndex === -1) {
  throw new Error('Failed to locate helper functions for generateWithLinks tests');
}
const helperBlock = tsCode.slice(helpersStart, generateWithLinksIndex);
const funcMatch = tsCode.match(/async function generateWithLinks[\s\S]*?\n\}/);

const snippet = `
${minLinksMatch[0]}
${strictRetryMatch[0]}
${lengthExpansionMatch[0]}
${factualTempMatch[0]}
${modelLimitsMatch[0]}
${safetyMarginMatch[0]}
${normalizeTitleMatch[0]}
${normalizeHrefMatch[0]}
${buildVariantsMatch[0]}
${cleanOutputMatch[0]}
${findMissingMatch[0]}
${helperBlock}
let responses = [];
let calls = [];
const openai = { chat: { completions: { create: async (opts) => { calls.push(opts); return responses.shift(); } } } };
function getOpenAI() { return openai; }
${funcMatch[0]}
export { generateWithLinks, MIN_LINKS, responses, calls, findMissingSources };
`;

const jsCode = ts.transpileModule(snippet, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2018 },
}).outputText;
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(jsCode).toString('base64');
const { generateWithLinks, MIN_LINKS, responses, calls, findMissingSources } = await import(moduleUrl);

test('generateWithLinks embeds required sources inside matching phrases', async () => {
  calls.length = 0;
  responses.length = 0;
  responses.push({
    choices: [
      {
        message: {
          content:
            '<p>Alpha Corp partnered with Beta Initiative on Tuesday, according to recent TechCrunch coverage.</p>' +
            '<ul><li>Reuters reported that the Securities and Exchange Commission opened a review.</li>' +
            '<li>Bloomberg highlighted Federal Trade Commission concerns and investor unease.</li></ul>',
        },
      },
    ],
  });
  const sources = [
    'https://techcrunch.com/story',
    'https://www.reuters.com/markets/idUS123',
    'https://www.bloomberg.com/news/articles/xyz',
  ];
  const metadata = [
    {
      url: 'https://techcrunch.com/story',
      title: 'Alpha Corp partners with Beta Initiative - TechCrunch',
    },
    {
      url: 'https://www.reuters.com/markets/idUS123',
      title: 'Securities and Exchange Commission review - Reuters',
    },
    {
      url: 'https://www.bloomberg.com/news/articles/xyz',
      title: 'Federal Trade Commission raises concerns - Bloomberg',
    },
  ];
  const systemPrompt = 'system context';
  const content = await generateWithLinks(
    'prompt',
    'model',
    sources,
    systemPrompt,
    MIN_LINKS,
    100,
    0,
    metadata
  );
  const linkCount = (content.match(/<a\s+href=/g) ?? []).length;
  assert.strictEqual(linkCount, 3);
  assert.strictEqual(responses.length, 0);
  assert.strictEqual(calls.length, 1);
  const techcrunchAnchor = content.match(
    /<a href="https:\/\/techcrunch.com\/story"[^>]*>(.*?)<\/a>/
  );
  assert(techcrunchAnchor);
  assert(
    ['Alpha Corp', 'Beta Initiative', 'TechCrunch'].some((phrase) =>
      techcrunchAnchor[1].includes(phrase)
    )
  );
  assert(/<p>[^<]*<a href="https:\/\/techcrunch.com\/story"/i.test(content));
  const reutersAnchor = content.match(
    /<a href="https:\/\/www\.reuters.com\/markets\/idUS123"[^>]*>(.*?)<\/a>/
  );
  assert(reutersAnchor);
  assert(reutersAnchor[1] && reutersAnchor[1].trim().length > 0);
  assert(/<li>[^<]*<a href="https:\/\/www\.reuters.com\/markets\/idUS123"/i.test(content));
  const bloombergAnchor = content.match(
    /<a href="https:\/\/www\.bloomberg.com\/news\/articles\/xyz"[^>]*>(.*?)<\/a>/
  );
  assert(bloombergAnchor);
  assert(
    ['Bloomberg', 'Federal Trade Commission'].some((phrase) =>
      bloombergAnchor[1].includes(phrase)
    )
  );
  assert(/<li>[^<]*<a href="https:\/\/www\.bloomberg.com\/news\/articles\/xyz"/i.test(content));
  const initialMessages = calls[0].messages;
  assert.strictEqual(initialMessages.length, 2);
  assert.deepStrictEqual(initialMessages[0], { role: 'system', content: systemPrompt });
  assert.strictEqual(initialMessages[1].role, 'user');
  const userPrompt = initialMessages[1].content;
  assert(userPrompt.includes('Cite every required source inside natural sentences exactly once'));
  for (const [index, url] of sources.entries()) {
    assert(userPrompt.includes(`${index + 1}. ${url}`));
  }
});

test('generateWithLinks leaves content unchanged when all required cited', async () => {
  calls.length = 0;
  responses.length = 0;
  const baseContent =
    '<p>Intro.</p><p><a href="a">One</a><a href="b">Two</a><a href="c">Three</a><a href="d">Four</a><a href="e">Five</a><a href="f">Six</a><a href="g">Seven</a></p>';
  responses.push({ choices: [{ message: { content: baseContent } }] });
  const content = await generateWithLinks(
    'prompt',
    'model',
    ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    undefined,
    MIN_LINKS,
    100
  );
  assert.strictEqual(content, baseContent);
  assert.strictEqual(responses.length, 0);
  assert.strictEqual(calls.length, 1);
});

test('generateWithLinks links inline even when paragraph containers are missing', async () => {
  calls.length = 0;
  responses.length = 0;
  responses.push({ choices: [{ message: { content: '<div>Intro only.</div>' } }] });
  const content = await generateWithLinks(
    'prompt',
    'model',
    ['https://example.com/story'],
    undefined,
    MIN_LINKS,
    100
  );
  assert(
    /<div><a href="https:\/\/example.com\/story"[^>]*>Intro<\/a> only\.<\/div>/.test(content)
  );
  assert(!content.includes('<p><a href="https://example.com/story"'));
});

test('generateWithLinks wraps available text when keywords are absent', async () => {
  calls.length = 0;
  responses.length = 0;
  responses.push({ choices: [{ message: { content: '<p>And then.</p>' } }] });
  const content = await generateWithLinks(
    'prompt',
    'model',
    ['https://demo.example.com/path'],
    undefined,
    MIN_LINKS,
    100
  );
  assert(
    /<p><a href="https:\/\/demo.example.com\/path"[^>]*>And then\.<\/a><\/p>/.test(content)
  );
});

test('generateWithLinks requests targeted paragraphs when many sources remain missing', async () => {
  calls.length = 0;
  responses.length = 0;
  responses.push(
    { choices: [{ message: { content: '<p></p>' }, finish_reason: 'stop' }] },
    {
      choices: [
        {
          message: {
            content:
              '<p><a href="https://one.example.com">Source one</a> summary.</p>' +
              '<p><a href="https://two.example.com">Source two</a> summary.</p>' +
              '<p><a href="https://three.example.com">Source three</a> summary.</p>',
          },
        },
      ],
    }
  );

  const sources = [
    'https://one.example.com',
    'https://two.example.com',
    'https://three.example.com',
  ];
  const metadata = sources.map((url, index) => ({
    url,
    title: `Title ${index + 1}`,
    summary: `Summary ${index + 1}`,
  }));

  const content = await generateWithLinks(
    'outline prompt',
    'model',
    sources,
    undefined,
    MIN_LINKS,
    120,
    0,
    metadata
  );

  assert.strictEqual(calls.length, 2);
  const repairPrompt = calls[1].messages[0].content;
  assert(repairPrompt.startsWith('Write 3 concise HTML paragraphs'));
  assert(repairPrompt.includes('1. https://one.example.com'));
  assert(repairPrompt.includes('Title 2'));
  assert(repairPrompt.includes('Summary 3'));

  for (const url of sources) {
    assert(content.includes(`<a href="${url}"`));
  }
});

test('generateWithLinks retries when response is truncated', async () => {
  calls.length = 0;
  responses.length = 0;
  responses.push(
    { choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] },
    { choices: [{ message: { content: 'complete' }, finish_reason: 'stop' }] }
  );
  const content = await generateWithLinks('prompt', 'gpt-4o', [], undefined, 0, 100);
  assert.strictEqual(content, 'complete');
  assert.strictEqual(calls.length, 2);
  assert(calls[0].max_tokens >= 800);
  assert.strictEqual(calls[1].max_tokens, 16126);
  assert.strictEqual(responses.length, 0);
  for (const call of calls) {
    assert.strictEqual(call.messages.length, 1);
    assert.strictEqual(call.messages[0].role, 'user');
  }
});

test('generateWithLinks caps max_tokens so prompt stays within context window', async () => {
  calls.length = 0;
  responses.length = 0;
  responses.push({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] });

  const modelLimitsSource = modelLimitsMatch[0]
    .replace(/const MODEL_CONTEXT_LIMITS[^=]*=\s*/, '')
    .replace(/;\s*$/, '');
  const modelLimits = Function('return ' + modelLimitsSource)();
  const limit = modelLimits['gpt-4o'];

  const longPrompt = 'x'.repeat((limit - 50) * 4);
  const content = await generateWithLinks(longPrompt, 'gpt-4o', [], undefined, 0, 100);
  assert.strictEqual(content, 'done');
  assert.strictEqual(responses.length, 0);
  assert.strictEqual(calls.length, 1);
  const maxTokens = calls[0].max_tokens;
  const promptTokens = Math.ceil(calls[0].messages.at(-1).content.length / 4);
  assert(promptTokens + maxTokens <= limit);
});

test('generateWithLinks issues a follow-up when content is below minWords', async () => {
  calls.length = 0;
  responses.length = 0;
  responses.push(
    { choices: [{ message: { content: '<p>Too short.</p>' }, finish_reason: 'stop' }] },
    {
      choices: [
        {
          message: {
            content:
              '<p>This revised article now includes sufficient detail, analysis, and corroborated facts to satisfy the minimum word requirement.</p>',
          },
        },
      ],
    }
  );

  const content = await generateWithLinks('base prompt', 'model', [], undefined, 0, 200, 100);
  assert.strictEqual(responses.length, 0);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(content.includes('revised article now includes'), true);
  const followUpPrompt = calls[1].messages[0].content;
  assert(followUpPrompt.includes('Minimum words: 100.'));
  assert(/Current words:\s*\d+/.test(followUpPrompt));
  assert(followUpPrompt.includes('Current article HTML'));
});

test('findMissingSources detects uncited URLs even with encoded hrefs', () => {
  const html =
    '<a href="https://example.com/story">One</a> <a href="https://demo.com/article?a=1&amp;b=2">Two</a>';
  const missing = findMissingSources(html, [
    'https://example.com/story',
    'https://demo.com/article?a=1&b=2',
    'https://third.com/miss',
  ]);
  assert.deepStrictEqual(missing, ['https://third.com/miss']);
});

test('findMissingSources accepts host and protocol variants', () => {
  const html =
    '<a href="https://www.example.com/story">One</a> <a href="http://sample.com/path">Two</a>';
  const missing = findMissingSources(html, [
    'https://example.com/story',
    'https://www.sample.com/path',
    'https://third.com/miss',
  ]);
  assert.deepStrictEqual(missing, ['https://third.com/miss']);
});

test('findMissingSources treats URLs as equivalent without query strings', () => {
  const html = '<a href="https://example.com/story?utm_source=feed">One</a>';
  const missing = findMissingSources(html, ['https://example.com/story']);
  assert.deepStrictEqual(missing, []);
});

test('findMissingSources matches sources that include query strings', () => {
  const html = '<a href="https://example.com/story">One</a>';
  const missing = findMissingSources(html, ['https://example.com/story?utm_source=feed']);
  assert.deepStrictEqual(missing, []);
});

test('findMissingSources treats Google News redirect targets as cited', () => {
  const html = '<a href="https://www.example.com/story">Example</a>';
  const googleNewsUrl =
    'https://news.google.com/articles/CBMiXmh0dHBzOi8vd3d3LmV4YW1wbGUuY29tL3N0b3J5P3V0bV9zb3VyY2U9Z29vZ2xl?hl=en-US&gl=US&ceid=US:en';
  const missing = findMissingSources(html, [googleNewsUrl]);
  assert.deepStrictEqual(missing, []);
});

test('findMissingSources resolves Google tracking redirects', () => {
  const html = '<a href="https://www.example.com/story">Example</a>';
  const googleRedirectUrl =
    'https://www.google.com/url?url=https%3A%2F%2Fwww.example.com%2Fstory%3Futm_source%3Dgoogle&sa=t';
  const missing = findMissingSources(html, [googleRedirectUrl]);
  assert.deepStrictEqual(missing, []);
});
