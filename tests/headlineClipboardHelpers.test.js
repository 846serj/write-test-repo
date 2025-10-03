import assert from 'assert';
import fs from 'fs';
import * as ts from 'typescript';
import { test } from 'node:test';

const helperPath = new URL('../src/app/generate/headlineClipboardHelpers.ts', import.meta.url);
const typesPath = new URL('../src/app/generate/types.ts', import.meta.url);

const helperSource = fs.readFileSync(helperPath, 'utf8');
const typesSource = fs.readFileSync(typesPath, 'utf8');

const sanitizedHelperSource = helperSource.replace(
  "import type { HeadlineItem } from './types';\n",
  ''
);

const snippet = `
${typesSource}
${sanitizedHelperSource}
export { formatHeadlinesForClipboard, HEADLINE_CLIPBOARD_HEADERS };
`;

const jsCode = ts
  .transpileModule(snippet, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  })
  .outputText;

const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(jsCode).toString('base64');

const { formatHeadlinesForClipboard, HEADLINE_CLIPBOARD_HEADERS } = await import(moduleUrl);

test('formatHeadlinesForClipboard formats all columns as CSV with escaping', () => {
  const csv = formatHeadlinesForClipboard(
    [
      {
        title: 'AI, "Robotics"\nTrends',
        source: 'Tech Daily',
        publishedAt: '2024-05-01T10:00:00Z',
        url: 'https://example.com/ai-robotics',
      },
    ],
    { column: 'all', format: 'csv' }
  );

  const [headerLine, dataLine] = csv.split('\n');
  assert.strictEqual(
    headerLine,
    ['Headline', 'Source & Published', 'Original Link'].join(',')
  );
  assert.strictEqual(
    dataLine,
    '"AI, ""Robotics"" Trends",Tech Daily | 2024-05-01T10:00:00Z,https://example.com/ai-robotics'
  );
});

test('formatHeadlinesForClipboard supports single column TSV output', () => {
  const tsv = formatHeadlinesForClipboard(
    [
      {
        title: 'Mars mission updates',
      },
      {
        title: 'Lunar base milestones',
      },
    ],
    { column: 'title', format: 'tsv' }
  );

  const expected = ['Headline', 'Mars mission updates', 'Lunar base milestones'].join('\n');

  assert.strictEqual(tsv, expected);
});

test('formatHeadlinesForClipboard omits missing values but keeps headers', () => {
  const csv = formatHeadlinesForClipboard(
    [
      {
        title: 'Supply chain analysis',
        source: undefined,
        publishedAt: undefined,
        url: '',
      },
    ],
    { column: 'sourcePublished', format: 'csv' }
  );

  const expectedHeader = HEADLINE_CLIPBOARD_HEADERS.sourcePublished;
  const expected = [expectedHeader, ''].join('\n');

  assert.strictEqual(csv, expected);
});
