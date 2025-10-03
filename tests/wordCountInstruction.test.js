import assert from 'assert';
import fs from 'fs';
import { test } from 'node:test';

const routePath = new URL('../src/app/api/generate/route.ts', import.meta.url);
const tsCode = fs.readFileSync(routePath, 'utf8');

const varRegex = /Keep each list item around \$\{listItemWordCount\} words/g;
const promptRegex = /\$\{lengthInstruction\}\$\{numberingInstruction\}\$\{wordCountInstruction\}\$\{customInstructionBlock\}/g;

test('wordCountInstruction is included in listicle prompts', () => {
  const varMatches = tsCode.match(varRegex) || [];
  const promptMatches = tsCode.match(promptRegex) || [];
  assert(varMatches.length >= 1);
  assert(promptMatches.length >= 1);
});
