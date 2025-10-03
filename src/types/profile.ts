export type TargetCategoryQuota = Record<string, number>;

export interface NormalizedSiteProfile {
  language: string;
  taxonomy: string[];
  must_include_keywords: string[];
  nice_to_have_keywords: string[];
  must_exclude_keywords: string[];
  entities_focus: string[];
  audience: string;
  tone: string;
  target_categories_quota: TargetCategoryQuota;
}
