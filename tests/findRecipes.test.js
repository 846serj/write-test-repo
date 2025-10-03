import assert from 'assert';
import fs from 'fs';
import * as ts from 'typescript';
import { test } from 'node:test';

// Load the TypeScript source for the findRecipes helper
const modulePath = new URL('../src/lib/findRecipes.ts', import.meta.url);
const tsCode = fs.readFileSync(modulePath, 'utf8');

// Extract the findRecipes helper function
const funcMatch = tsCode.match(/async function findRecipes[\s\S]*?\n\}/);
if (!funcMatch) {
  throw new Error('findRecipes function not found in findRecipes.ts');
}

// Build a testable module that mocks openai and embedding cache
const snippet = `
let queryEmbedding = [];
const openai = { embeddings: { create: async () => ({ data: [{ embedding: queryEmbedding }] }) } };
function getOpenAI() { return openai; }
let embeddings = [];
async function getCachedRecipeEmbeddings() { return embeddings; }
${funcMatch[0]}
export { findRecipes, embeddings, queryEmbedding };
`;

const jsCode = ts.transpileModule(snippet, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(jsCode).toString('base64');
const { findRecipes, embeddings, queryEmbedding } = await import(moduleUrl);

// Test that the most similar recipes are returned first
// Uses simple 2D vectors to make cosine similarity checks trivial

test('findRecipes returns recipes sorted by similarity', async () => {
  embeddings.length = 0;
  embeddings.push(
    { id: '1', title: 'Chocolate Cake', url: 'a', embedding: [1, 0] },
    { id: '2', title: 'Vanilla Ice Cream', url: 'b', embedding: [0, 1] }
  );
  queryEmbedding.length = 0;
  queryEmbedding.push(1, 0);
  const res = await findRecipes('Best chocolate cake');
  assert.equal(res[0].id, '1');
});

// Edge case: when no embeddings are close to the query, expect an empty array

test('findRecipes returns empty array when no close match exists', async () => {
  embeddings.length = 0;
  embeddings.push(
    { id: '1', title: 'Chocolate Cake', url: 'a', embedding: [1, 0] },
    { id: '2', title: 'Vanilla Ice Cream', url: 'b', embedding: [0, 1] }
  );
  queryEmbedding.length = 0;
  queryEmbedding.push(-1, 0);
  const res = await findRecipes('Savory steak', 5, 0.9);
  assert.deepStrictEqual(res, []);
});
