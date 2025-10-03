import assert from 'assert';
import fs from 'fs';
import * as ts from 'typescript';
import { test } from 'node:test';

const audiencePath = new URL('../src/lib/travelThemeAudience.ts', import.meta.url);
const themeCoveragePath = new URL('../src/lib/themeCoverage.ts', import.meta.url);
const routePath = new URL('../src/app/api/generate/route.ts', import.meta.url);

const audienceTs = fs.readFileSync(audiencePath, 'utf8');
const themeCoverageRaw = fs.readFileSync(themeCoveragePath, 'utf8');
const routeTs = fs.readFileSync(routePath, 'utf8');

const themeCoverageTs = themeCoverageRaw.replace(
  /import\s+\{\s*TRAVEL_THEME_AUDIENCE_TERMS\s*\}\s+from\s+'\.\/travelThemeAudience';?\s*/,
  ''
);
const applyMatch = routeTs.match(
  /function applyVerificationIssuesToPrompt[\s\S]*?\n\}/
);
if (!applyMatch) {
  throw new Error('Failed to locate applyVerificationIssuesToPrompt in route.ts');
}

const snippet = `
${audienceTs}
${themeCoverageTs}
${applyMatch[0]}
export {
  validateThemeCoverage,
  formatThemeCoverageIssue,
  parseThemeCoverageIssue,
  applyVerificationIssuesToPrompt,
};
`;

const jsCode = ts.transpileModule(snippet, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2018 },
}).outputText;
const moduleUrl =
  'data:text/javascript;base64,' + Buffer.from(jsCode).toString('base64');
const {
  validateThemeCoverage,
  formatThemeCoverageIssue,
  applyVerificationIssuesToPrompt,
} = await import(moduleUrl);

test('validateThemeCoverage flags insufficient theme mentions when density is low', () => {
  const html = [
    '<p>The mountain town greets visitors with year-round hiking trails.</p>',
    '<p>Guides share folklore at the ranger station.</p>',
    '<p>Cozy cabins line the valley with panoramic views.</p>',
    '<p>Local museums chronicle decades of sightings.</p>',
    '<p>Bigfoot lovers swap stories at a weekend campfire.</p>',
  ].join('');
  const issue = validateThemeCoverage(html, 'Bigfoot lovers', { threshold: 0.3 });
  assert(issue, 'Expected theme coverage issue when sentences fall below threshold.');
  assert.strictEqual(issue.reason, 'insufficient-coverage');
  assert(issue.message.includes('Bigfoot lovers'));
  assert(issue.message.includes('30%'));
});

test('validateThemeCoverage allows adequately themed drafts to pass', () => {
  const html = [
    '<p>Bigfoot lovers trace fresh prints along the riverbank and cite the ranger log.</p>',
    '<p>Bigfoot lovers gather for a twilight tour that references the national forest bulletin.</p>',
    '<p>Travelers also sample regional cuisine between hikes.</p>',
    '<p>Guides highlight scenic overlooks for sunrise photo stops.</p>',
  ].join('');
  const issue = validateThemeCoverage(html, 'Bigfoot lovers', { threshold: 0.25 });
  assert.strictEqual(issue, null, 'Adequately themed drafts should not raise issues.');
});

test('validateThemeCoverage detects generic-only references without descriptors', () => {
  const html = [
    '<p>Enthusiasts will enjoy peaceful lakeside hikes throughout the season.</p>',
    '<p>The town hosts artisan markets with local storytellers.</p>',
    '<p>Cabins include cozy fireplaces for evening relaxation.</p>',
  ].join('');
  const issue = validateThemeCoverage(html, 'Bigfoot enthusiasts', { threshold: 0.2 });
  assert(issue, 'Expected issue when only generic audience references are present.');
  assert.strictEqual(issue.reason, 'generic-only');
  assert(issue.message.includes('Bigfoot enthusiasts'));
});

test('applyVerificationIssuesToPrompt reinforces theme coverage instructions', () => {
  const html = [
    '<p>Enthusiasts can unwind in the rustic lodge before setting out on hikes.</p>',
    '<p>The village bakery prepares special pastries every morning.</p>',
    '<p>Local guides arrange photo walks through the forest.</p>',
  ].join('');
  const issue = validateThemeCoverage(html, 'Bigfoot enthusiasts', { threshold: 0.2 });
  assert(issue);
  const formatted = formatThemeCoverageIssue(issue);
  const basePrompt = 'Draft prompt for travel article';
  const revised = applyVerificationIssuesToPrompt(basePrompt, [formatted]);
  assert(revised.includes(basePrompt));
  assert(revised.includes('critical issues'));
  assert(revised.includes(issue.message));
  assert(revised.includes('Emphasize the thematic requirement'));
  assert(revised.includes('Bigfoot enthusiasts'));
});
