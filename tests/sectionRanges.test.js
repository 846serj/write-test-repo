import assert from 'assert';
import fs from 'fs';
import { test } from 'node:test';

const routePath = new URL('../src/app/api/generate/route.ts', import.meta.url);
const tsCode = fs.readFileSync(routePath, 'utf8');

test('sectionRanges matches UI copy', () => {
  const expectedEntries = {
    shorter: '[2, 3]',
    short: '[3, 5]',
    medium: '[5, 7]',
    longForm: '[7, 10]',
    longer: '[10, 12]',
  };

  for (const [key, value] of Object.entries(expectedEntries)) {
    assert(
      tsCode.includes(`${key}: ${value}`),
      `Expected sectionRanges to contain ${key}: ${value}`
    );
  }
});

test('news prompt references dynamic section range', () => {
  const regex = /Include \$\{minS\}–\$\{maxS\} <h2> headings\./g;
  const matches = tsCode.match(regex) || [];
  assert(
    matches.length >= 2,
    'Expected sectionInstruction string with dynamic range to appear at least twice'
  );
});

test('lengthInstruction uses section range and word range together', () => {
  const regex = /Include \$\{minS\}–\$\{maxS\} sections and write between \$\{minW\} and \$\{maxW\} words\./g;
  const matches = tsCode.match(regex) || [];
  assert(
    matches.length >= 2,
    'Expected lengthInstruction string with dynamic ranges to appear at least twice'
  );
});
