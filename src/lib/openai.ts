import OpenAI from 'openai';

let cachedClient: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (cachedClient) {
    return cachedClient;
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY environment variable');
  }

  cachedClient = new OpenAI({
    apiKey,
  });

  return cachedClient;
}

