/**
 * Ports — the seam between trend logic and paid data vendors.
 *
 * The parent app called Apify, Bright Data, Firecrawl, EnsembleData, Octoparse
 * and OpenRouter directly from inside its service files. That is fine for one
 * deployment and fatal for a licensed product: you cannot swap a vendor whose
 * terms forbid resale, you cannot run a demo without live keys, and you cannot
 * test determinism.
 *
 * Everything below is an interface. `fixtures/` implements them from real
 * captured snapshots so the proof-of-concept runs with zero API keys and zero
 * vendor spend.
 */

import type { SourceRef } from '../provenance/types.js';

/** A value plus the source that produced it. Ports never return bare data. */
export interface Sourced<T> {
  value: T;
  source: SourceRef;
}

// ---------------------------------------------------------------------------
// Social metrics — measured engagement. The ONLY legitimate origin of numbers.
// ---------------------------------------------------------------------------

export interface HashtagMetric {
  hashtag: string;
  postCount: number;
  totalViews: number;
  totalLikes: number;
  totalShares: number;
  totalComments: number;
  avgViews: number;
  recentPostCount: number;
  /** Velocity-based, computed upstream once so every surface agrees. */
  growth: number;
  observedAt: string;
}

export type Platform = 'tiktok' | 'instagram' | 'youtube' | 'reddit';

export interface SocialMetricsPort {
  /** Measured engagement for a hashtag set. Missing tags are omitted, never zero-filled. */
  getHashtagMetrics(
    platform: Platform,
    hashtags: string[],
  ): Promise<Sourced<HashtagMetric[]>>;

  /** Snapshot timestamp of the underlying cache, for freshness reporting. */
  lastObservedAt(platform: Platform): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Web intelligence — live search. Qualitative only.
// ---------------------------------------------------------------------------

export interface WebIntelQuery {
  prompt: string;
  /** Hard ceiling. The parent app learned Cloud Run kills connections past ~30s. */
  timeoutMs?: number;
  region?: string;
}

export interface WebIntelPort {
  /**
   * Returns prose or categorical labels. Implementations MUST inject the
   * qualitative-only instruction and MUST strip non-ASCII before JSON.parse
   * (the Far East regional prompts leaked CJK characters and broke parsing).
   */
  queryQualitative<T = unknown>(q: WebIntelQuery): Promise<Sourced<T>>;
}

// ---------------------------------------------------------------------------
// Trend store — historical snapshots. Required for any longitudinal claim.
// ---------------------------------------------------------------------------

export interface TrendSnapshot {
  entity: string;
  entityType: 'fragrance' | 'ingredient' | 'note' | 'hashtag';
  metric: string;
  value: number;
  observedAt: string;
}

export interface TrendStorePort {
  /**
   * Historical series. Returns [] when there is genuinely no history —
   * callers must degrade to an honest empty result rather than synthesise a
   * trajectory from array indices.
   */
  getSeries(entity: string, metric: string, sinceDays: number): Promise<Sourced<TrendSnapshot[]>>;
  listEntities(entityType: TrendSnapshot['entityType']): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Reference data — taxonomies. Static, cheap, no vendor.
// ---------------------------------------------------------------------------

export interface FragranceRef {
  name: string;
  brand: string;
  hashtag?: string;
  gender?: string;
  priceRange?: string;
  notes?: string[];
}

export interface IngredientRef {
  name: string;
  category: string;
  description?: string;
  origin?: string;
}

export interface ReferencePort {
  fragrances(): Promise<FragranceRef[]>;
  ingredients(): Promise<IngredientRef[]>;
  /** Generic community tags vs specific brand tags — they must not be mixed. */
  hashtagTaxonomy(): Promise<{ generic: string[]; brand: string[]; ingredient: string[] }>;
}

// ---------------------------------------------------------------------------

export interface SourceRegistry {
  social: SocialMetricsPort;
  web: WebIntelPort;
  store: TrendStorePort;
  reference: ReferencePort;
}
