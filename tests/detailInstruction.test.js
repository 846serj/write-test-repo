import assert from 'assert';
import fs from 'fs';
import { test } from 'node:test';

const routePath = new URL('../src/app/api/generate/route.ts', import.meta.url);
const tsCode = fs.readFileSync(routePath, 'utf8');

test('detail instruction constant and usage exist', () => {
  assert(/const DETAIL_INSTRUCTION/.test(tsCode));
  const usage = tsCode.match(/\$\{DETAIL_INSTRUCTION\}\$\{customInstructionBlock\}/g) || [];
  assert(usage.length >= 1);
});
