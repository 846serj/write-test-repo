import assert from 'assert';
import fs from 'fs';
import * as ts from 'typescript';
import { test } from 'node:test';

const routePath = new URL('../src/app/api/generate/route.ts', import.meta.url);
const tsCode = fs.readFileSync(routePath, 'utf8');

const detailInstructionMatch = tsCode.match(/const DETAIL_INSTRUCTION[\s\S]*?';/);
const detailExtractionMatch = tsCode.match(
  /const TIMELINE_REGEX[\s\S]*?function formatKeyDetails[\s\S]*?\n\}/
);
const formatPublishedMatch = tsCode.match(/function formatPublishedTimestamp[\s\S]*?\n\}/);
const normalizeSummaryMatch = tsCode.match(/function normalizeSummary[\s\S]*?\n\}/);
const buildBlockMatch = tsCode.match(/function buildRecentReportingBlock[\s\S]*?\n\}/);
const buildArticlePromptMatch = tsCode.match(
  /function buildArticlePrompt[\s\S]*?`\.trim\(\);\n\}/
);

if (
  !detailInstructionMatch ||
  !detailExtractionMatch ||
  !formatPublishedMatch ||
  !normalizeSummaryMatch ||
  !buildBlockMatch ||
  !buildArticlePromptMatch
) {
  throw new Error('Failed to extract helper definitions from route.ts');
}

async function transpile(snippet) {
  const jsCode = ts.transpileModule(snippet, {
    compilerOptions: { module: ts.ModuleKind.ESNext },
  }).outputText;
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(jsCode).toString('base64');
  try {
    return await import(moduleUrl);
  } catch (err) {
    if (err && typeof err.message === 'string') {
      err.message += `\nGenerated code:\n${jsCode}`;
    }
    throw err;
  }
}

function extractPromptSnippet(startMarker) {
  const start = tsCode.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`Unable to locate marker: ${startMarker}`);
  }
  const reportingStart = tsCode.indexOf('const reportingSection', start);
  if (reportingStart === -1) {
    throw new Error(`Unable to locate reporting section for marker: ${startMarker}`);
  }
  const articlePromptStart = tsCode.indexOf('const articlePrompt', reportingStart);
  if (articlePromptStart === -1) {
    throw new Error(`Unable to locate article prompt for marker: ${startMarker}`);
  }
  let nextConstIndex = tsCode.indexOf('\n\n      const', articlePromptStart);
  if (nextConstIndex === -1) {
    nextConstIndex = tsCode.indexOf('\n\n    const', articlePromptStart);
  }
  if (nextConstIndex === -1) {
    throw new Error(`Unable to locate prompt terminator for marker: ${startMarker}`);
  }
  return tsCode.slice(reportingStart, nextConstIndex);
}

function extractNewsBlock() {
  const startMarker = "if (articleType === 'News article')";
  const start = tsCode.indexOf(startMarker);
  if (start === -1) {
    throw new Error('Unable to locate News article branch.');
  }
  const endMarker = 'return NextResponse.json({';
  const end = tsCode.indexOf(endMarker, start);
  if (end === -1) {
    throw new Error('Unable to locate News article branch terminator.');
  }
  return tsCode.slice(start, end);
}

function extractDefaultPromptSnippet() {
  const extraIndex = tsCode.indexOf('const extraRequirements =');
  if (extraIndex === -1) {
    throw new Error('Unable to locate extra requirements block.');
  }
  const reportingStart = tsCode.lastIndexOf('const reportingSection', extraIndex);
  if (reportingStart === -1) {
    throw new Error('Unable to locate reporting section before extra requirements.');
  }
  const articlePromptStart = tsCode.indexOf('const articlePrompt', extraIndex);
  if (articlePromptStart === -1) {
    throw new Error('Unable to locate article prompt declaration for default branch.');
  }
  let nextConstIndex = tsCode.indexOf('\n\n    const', articlePromptStart);
  if (nextConstIndex === -1) {
    nextConstIndex = tsCode.indexOf('\n\n      const', articlePromptStart);
  }
  if (nextConstIndex === -1) {
    nextConstIndex = tsCode.indexOf('\n\n    return', articlePromptStart);
  }
  if (nextConstIndex === -1) {
    throw new Error('Unable to determine end of default prompt snippet.');
  }
  return tsCode.slice(reportingStart, nextConstIndex);
}

function extractTravelGenerationBlock() {
  const marker = 'const runArticleGeneration =';
  const start = tsCode.indexOf(marker);
  if (start === -1) {
    throw new Error('Unable to locate runArticleGeneration block.');
  }
  const endMarker = 'return NextResponse.json({';
  const end = tsCode.indexOf(endMarker, start);
  if (end === -1) {
    throw new Error('Unable to locate generation return statement.');
  }
  return tsCode.slice(start, end);
}

const reportingHelpers = `
${detailInstructionMatch[0]}
${detailExtractionMatch[0]}
${formatPublishedMatch[0]}
${normalizeSummaryMatch[0]}
${buildBlockMatch[0]}
`;

test('buildRecentReportingBlock formats entries with timestamps and fallbacks', async () => {
  const snippet = `
${reportingHelpers}
const items = [
  { title: 'Alpha', summary: ' First summary ', url: 'https://alpha.test', publishedAt: '2024-05-01T12:00:00Z' },
  { title: '', summary: '', url: 'https://beta.test', publishedAt: 'invalid-date' },
];
const block = buildRecentReportingBlock(items);
export { block };
`;
  const { block } = await transpile(snippet);
  assert(block.includes('Key facts from recent reporting'));
  assert(block.includes('"Alpha" (2024-05-01T12:00:00.000Z)'));
  assert(block.includes('Summary: First summary'));
  assert(block.includes('URL: https://alpha.test'));
  assert(block.includes('"Untitled" (Unknown publication time)'));
  assert(block.includes('Summary: No summary provided.'));
  assert.strictEqual(block.includes('Key details:'), false);
});

test('formatKeyDetails surfaces metrics, timelines, methods, and entities', async () => {
  const snippet = `
${reportingHelpers}
const summary = 'Pfizer reported 72% efficacy in a 1,500-person randomized controlled trial completed on March 3, 2024.';
const details = formatKeyDetails(summary);
export { details };
`;
  const { details } = await transpile(snippet);
  assert(details.includes('Cite these metrics verbatim: 72%, 1,500-person'));
  assert(details.includes('State these reported timelines exactly: March 3, 2024'));
  assert(details.includes('Reference the research methods noted: randomized controlled trial'));
  assert(details.includes('Name these entities precisely: Pfizer'));
});

test('listicle prompt injects reporting block and grounding instruction', async () => {
  const promptSnippet = extractPromptSnippet("if (articleType === 'Listicle/Gallery')");
  const snippet = `
${reportingHelpers}
const reportingSources = [
  {
    title: 'Sample Investigation',
    summary: 'Key developments about the topic.',
    url: 'https://news.test/sample',
    publishedAt: '2024-07-04T10:00:00Z',
  },
];
const reportingBlock = buildRecentReportingBlock(reportingSources);
const groundingInstruction = reportingSources.length
  ? '- Base every factual statement on the reporting summaries provided and cite the matching URL when referencing them.\\n'
  : '';
const linkInstruction = '';
const title = 'Test Listicle';
const outline = 'INTRO:\\n- Opening\\n\\n1. Heading';
const lengthInstruction = '- Use exactly 3 items.\\n';
const numberingInstruction = '';
const wordCountInstruction = '';
const customInstructionBlock = '';
const toneInstruction = '';
const povInstruction = '';
${promptSnippet}
export { articlePrompt, reportingBlock, groundingInstruction };
`;
  const { articlePrompt, reportingBlock, groundingInstruction } = await transpile(snippet);
  assert(articlePrompt.includes('Key facts from recent reporting'));
  assert(articlePrompt.includes('Key developments about the topic.'));
  assert(articlePrompt.includes('https://news.test/sample'));
  assert(articlePrompt.includes('Base every factual statement on the reporting summaries provided and cite the matching URL'));
  assert(articlePrompt.includes('authoritative reporting summaries provided'));
  assert(
    articlePrompt.includes('accurate, highly relevant sourcing'),
    'Listicle prompt should emphasize accurate, highly relevant sourcing.'
  );
  assert.strictEqual(
    reportingBlock.trim().startsWith('Key facts from recent reporting'),
    true
  );
  assert.strictEqual(groundingInstruction.includes('cite the matching URL'), true);
});

test('blog prompt injects reporting block and grounding instruction', async () => {
  const snippet = [
    reportingHelpers,
    buildArticlePromptMatch[0],
    "const reportingSources = [",
    "  {",
    "    title: 'Blog Source',",
    "    summary: 'Background research summary.',",
    "    url: 'https://news.test/blog',",
    "    publishedAt: '2024-07-07T11:20:00Z',",
    "  },",
    "];",
    "const reportingBlock = buildRecentReportingBlock(reportingSources);",
    "const groundingInstruction = reportingSources.length",
    "  ? '- Base every factual statement on the reporting summaries provided and cite the matching URL when referencing them.\\\\n'",
    "  : '';",
    "const linkInstruction = '';",
    "const toneInstruction = '';",
    "const povInstruction = '';",
    "const title = 'Default Blog';",
    "const outline = 'INTRO:\\\\n- Opening\\\\n\\\\n<h2>Section</h2>';",
    "const lengthInstruction = '- Aim for around 9 sections.\\\\n';",
    "const customInstructionBlock = '';",
    "const lengthOption = 'default';",
    "const customSections = 0;",
    "const WORD_RANGES = {};",
    "const sectionRanges = {};",
    "const DEFAULT_WORDS = 900;",
    "const reportingSection = reportingBlock ? `${reportingBlock}\\\\n\\\\n` : '';",
    "const articlePrompt = buildArticlePrompt({",
    "  title,",
    "  outline,",
    "  reportingSection,",
    "  toneInstruction,",
    "  povInstruction,",
    "  lengthInstruction,",
    "  groundingInstruction,",
    "  customInstructionBlock,",
    "  linkInstruction,",
    "});",
    "export { articlePrompt };",
  ].join('\n');
  const { articlePrompt } = await transpile(snippet);
  assert(articlePrompt.includes('Key facts from recent reporting'));
  assert(
    articlePrompt.includes('authoritative reporting summaries provided'),
    'Blog prompt should reinforce authoritative reporting context.'
  );
  assert(
    articlePrompt.includes('accurate, highly relevant sourcing'),
    'Blog prompt should emphasize accurate, highly relevant sourcing.'
  );
  assert(articlePrompt.includes('https://news.test/blog'));
  assert(articlePrompt.includes('cite the matching URL'));
});

test('news prompt default references DEFAULT_WORDS and keeps full min bound', () => {
  const newsBlock = extractNewsBlock();
  assert(
    /target roughly \$\{DEFAULT_WORDS\.toLocaleString\(\)\} words total/.test(
      newsBlock
    ),
    'News default length instruction should reference DEFAULT_WORDS.'
  );
  const minWordsMatch = newsBlock.match(
    /const \[minWords, maxWords\] = getWordBounds\(lengthOption, customSections\);/
  );
  assert(
    minWordsMatch,
    'News branch should read minWords directly from getWordBounds.'
  );
});
