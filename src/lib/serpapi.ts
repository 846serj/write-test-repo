export interface SerpApiNewsResult {
  title?: string;
  link?: string;
  snippet?: string;
  summary?: string;
  date?: string;
  published_at?: string;
  date_published?: string;
  source?: string | { name?: string } | null;
}

export interface SerpApiOrganicResult {
  title?: string;
  link?: string;
  snippet?: string;
  summary?: string;
  date?: string;
  published_at?: string;
  date_published?: string;
  source?: string;
}

export interface SerpApiScholarResult {
  title?: string;
  link?: string;
  snippet?: string;
  publication_info?: {
    summary?: string;
  };
}

export interface SerpApiResponse {
  organic_results?: SerpApiOrganicResult[];
  news_results?: SerpApiNewsResult[];
  scholar_results?: SerpApiScholarResult[];
  error?: string;
}

export type SerpApiResult = {
  title?: string;
  link?: string;
  snippet?: string;
  summary?: string;
  date?: string;
  published_at?: string;
  date_published?: string;
  source?: string;
};

export type SerpApiSearchParams = {
  query: string;
  engine: string;
  extraParams?: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  limit?: number;
};

function normalizeSource(source: SerpApiNewsResult['source']): string {
  if (!source) {
    return '';
  }

  if (typeof source === 'string') {
    return source;
  }

  if (typeof source.name === 'string') {
    return source.name;
  }

  return '';
}

function mapResponseToResults(data: SerpApiResponse): SerpApiResult[] {
  if (Array.isArray(data.news_results) && data.news_results.length > 0) {
    return data.news_results.map((item) => ({
      title: item?.title,
      link: item?.link,
      snippet: item?.snippet,
      summary: item?.summary ?? item?.snippet,
      date: item?.date,
      published_at: item?.published_at,
      date_published: item?.date_published,
      source: normalizeSource(item?.source),
    }));
  }

  if (Array.isArray(data.organic_results) && data.organic_results.length > 0) {
    return data.organic_results.map((item) => ({
      title: item?.title,
      link: item?.link,
      snippet: item?.snippet,
      summary: item?.summary ?? item?.snippet,
      date: item?.date,
      published_at: item?.published_at,
      date_published: item?.date_published,
      source: item?.source,
    }));
  }

  if (Array.isArray(data.scholar_results) && data.scholar_results.length > 0) {
    return data.scholar_results.map((item) => ({
      title: item?.title,
      link: item?.link,
      snippet: item?.snippet ?? item?.publication_info?.summary,
      summary: item?.snippet ?? item?.publication_info?.summary,
    }));
  }

  return [];
}

export async function serpapiSearch({
  query,
  engine,
  extraParams = {},
  fetchImpl,
  timeoutMs = 10000,
  limit,
}: SerpApiSearchParams): Promise<SerpApiResult[]> {
  if (!process.env.SERPAPI_KEY) {
    return [];
  }

  try {
    const params = new URLSearchParams({
      q: query,
      engine,
      api_key: process.env.SERPAPI_KEY || '',
    });

    for (const [key, value] of Object.entries(extraParams)) {
      if (value) {
        params.append(key, value);
      }
    }

    const url = `https://serpapi.com/search.json?${params.toString()}`;
    const requester = fetchImpl ?? fetch;

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => {
          try {
            controller.abort();
          } catch {
            // ignore abort errors
          }
        }, timeoutMs)
      : null;

    const response = await requester(url, {
      signal: controller?.signal,
    });

    if (timer) {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as SerpApiResponse;

    if (data?.error) {
      return [];
    }

    const results = mapResponseToResults(data);
    if (typeof limit === 'number' && limit > 0) {
      return results.slice(0, limit);
    }

    return results;
  } catch {
    return [];
  }
}
