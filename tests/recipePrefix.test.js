import assert from 'assert';
import fs from 'fs';
import * as ts from 'typescript';
import { test } from 'node:test';

const utilPath = new URL('../src/utils/formatNumberingPrefix.ts', import.meta.url);
const tsCode = fs.readFileSync(utilPath, 'utf8');
const jsCode = ts.transpileModule(tsCode, {
  compilerOptions: { module: ts.ModuleKind.ESNext },
}).outputText;
const moduleUrl =
  'data:text/javascript;base64,' + Buffer.from(jsCode).toString('base64');
const { formatNumberingPrefix } = await import(moduleUrl);

test('parenthesis format', () => {
  assert.equal(formatNumberingPrefix(1, '1), 2), 3)'), '1) ');
});

test('period format', () => {
  assert.equal(formatNumberingPrefix(2, '1., 2., 3.'), '2. ');
});

test('colon format', () => {
  assert.equal(formatNumberingPrefix(3, '1:, 2:, 3:'), '3: ');
});

test('none format', () => {
  assert.equal(formatNumberingPrefix(4, 'None'), '');
});

