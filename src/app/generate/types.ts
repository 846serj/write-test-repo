export type RelatedArticle = {
  title?: string;
  description?: string;
  url?: string;
  source?: string;
  publishedAt?: string;
};

export type HeadlineItem = {
  title: string;
  source?: string;
  url?: string;
  publishedAt?: string;
  description?: string;
  matchedQuery?: string;
  relatedArticles?: RelatedArticle[];
  keyword?: string;
  queryUsed?: string;
  searchQuery?: string;
  ranking?: {
    score?: number;
    components?: {
      clusterSupport?: number;
    };
    details?: {
      clusterSize?: number;
      clusterUniqueSources?: number;
    };
  };
};

export type KeywordHeadlineGroup = {
  keyword: string;
  query?: string;
  totalResults?: number;
  headlines: HeadlineItem[];
};
