import { getOpenAI } from './openai';
import { getCachedRecipeEmbeddings } from './recipeEmbeddings';
import type { RecipeResult } from '../types/api';

export async function findRecipes(
  headline: string,
  count = 10,
  minSimilarity = 0.8
): Promise<RecipeResult[]> {
  function cosineSimilarity(a: number[], b: number[]): number {
    const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
    const normA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
    const normB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
    if (normA === 0 || normB === 0) return 0;
    return dot / (normA * normB);
  }

  const recipes = await getCachedRecipeEmbeddings();
  const openai = getOpenAI();

  const {
    data: [{ embedding: queryEmbedding }],
  } = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: headline,
  });

  return recipes
    .map((r) => ({
      id: r.id,
      title: r.title,
      url: r.url,
      similarity: cosineSimilarity(queryEmbedding, r.embedding),
    }))
    .filter((r) => r.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, count)
    .map(({ id, title, url }) => ({ id, title, url }));
}
