import assert from 'assert';
import fs from 'fs';
import * as ts from 'typescript';
import { test } from 'node:test';

const routePath = new URL('../src/app/api/generate/route.ts', import.meta.url);
const configPath = new URL('../src/constants/lengthOptions.ts', import.meta.url);
const tsCode = fs.readFileSync(routePath, 'utf8');
const configTs = fs.readFileSync(configPath, 'utf8');

const configSnippet = configTs.replace(/export /g, '');
const modelLimitsMatch = tsCode.match(/const MODEL_CONTEXT_LIMITS[\s\S]*?};/);
const funcMatch = tsCode.match(/function calcMaxTokens[\s\S]*?\n\}/);
const snippet = [configSnippet, modelLimitsMatch[0], funcMatch[0], 'export { calcMaxTokens, DEFAULT_WORDS };'].join('\n');
const jsCode = ts.transpileModule(snippet, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(jsCode).toString('base64');
const { calcMaxTokens, DEFAULT_WORDS } = await import(moduleUrl);

test('calcMaxTokens default uses approx DEFAULT_WORDS words', () => {
  const tokens = calcMaxTokens('default', undefined, 'gpt-4o');
  const approxWords = tokens * 0.75;
  assert(
    approxWords > DEFAULT_WORDS - 50 && approxWords < DEFAULT_WORDS + 50
  );
});

test('listicle formulas include a 20% buffer', () => {
  const match = tsCode.match(/Math\.ceil\(\(desired \* 1\.2\) \/ 0\.75\)/g) || [];
  assert(match.length >= 1);
});

test('calcMaxTokens handles custom length option', () => {
  const tokens = calcMaxTokens('custom', 5, 'gpt-4o');
  assert.equal(tokens, Math.ceil((5 * 220) / 0.75));
});

test('calcMaxTokens falls back for unknown option', () => {
  const tokens = calcMaxTokens('unknown', undefined, 'gpt-4o');
  const approxWords = tokens * 0.75;
  assert(approxWords > 1850 && approxWords < 1950);
});

test('calcMaxTokens caps output at the model context limit', () => {
  const tokens = calcMaxTokens('custom', 500, 'gpt-4o');
  assert.equal(tokens, 16384);
});
