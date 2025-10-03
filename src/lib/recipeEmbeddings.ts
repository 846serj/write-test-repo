import recipeEmbeddingsData from '../../data/recipeEmbeddings.json';

export interface RecipeEmbedding {
  id: string;
  title: string;
  url?: string;
  embedding: number[];
}

let cache: RecipeEmbedding[] | null = null;

/**
 * Returns recipe embeddings generated ahead of time and cached in memory.
 */
export function getRecipeEmbeddings(): RecipeEmbedding[] {
  if (!cache) {
    cache = recipeEmbeddingsData as RecipeEmbedding[];
  }
  return cache;
}

// TODO: remove this alias once all imports are updated.
export const getCachedRecipeEmbeddings = async (): Promise<RecipeEmbedding[]> =>
  getRecipeEmbeddings();
