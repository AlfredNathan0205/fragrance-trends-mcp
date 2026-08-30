/**
 * Fixture-backed SourceRegistry.
 *
 * Seeded from genuine snapshots captured by the parent app in production
 * (apify_cache.json, .data-cache/*.json — TikTok engagement observed
 * 2026-07-23, Perplexity trending list observed 2026-07-14).
 *
 * Purpose: the proof-of-concept runs, and demos to prospective licensees run,
 * with no vendor keys and no vendor spend. Swap in `live/registry.ts` to hit
 * real Apify/Perplexity once resale-tier contracts are signed.
 *
 * These are real observations, so provenance stays honest: sources are tagged
 * `cache` with their true observedAt, and any consumer can see the data is
 * months old rather than being told it is live.
 */

import { createRequire } from 'node:module';
import type {
  FragranceRef,
  HashtagMetric,
  IngredientRef,
  Platform,
  ReferencePort,
  SocialMetricsPort,
  Sourced,
  SourceRegistry,
  TrendSnapshot,
  TrendStorePort,
  WebIntelPort,
  WebIntelQuery,
} from '../ports/index.js';

const require = createRequire(import.meta.url);

interface ApifySnapshot {
  lastUpdated: string;
  tiktok: {
    fragranceHashtags: Record<string, RawHashtag>;
    ingredientHashtags: Record<string, RawHashtag>;
  };
  youtube?: unknown;
  instagram?: unknown;
  reddit?: unknown;
}

interface RawHashtag {
  hashtag: string;
  postCount: number;
  totalViews: number;
  totalLikes: number;
  totalShares: number;
  totalComments: number;
  avgViews: number;
  recentPostCount: number;
  /** Genuinely absent on some production records — must not be coerced to 0. */
  growth?: number;
  fetchedAt?: string;
}

const apify = require('./apify-snapshot.json') as ApifySnapshot;
const trendingFile = require('./trending-fragrances.json') as {
  fetchedAt: string;
  fragrances: Array<FragranceRef & { rank: number; growthPercent: number; momentum: string }>;
};
const ingredientFile = require('./ingredient-trends.json') as {
  data: Array<{ ingredient: IngredientRef & { id: number }; mentions: number; growth: number }>;
};

function toMetric(raw: RawHashtag, fallbackObservedAt: string): HashtagMetric | null {
  // One record in the production snapshot has no `growth` key at all. Defaulting
  // it to 0 would manufacture a "flat" data point and quietly rank it as stable.
  // Dropping it is the honest option.
  if (typeof raw.growth !== 'number' || !Number.isFinite(raw.growth)) return null;
  return {
    hashtag: raw.hashtag,
    postCount: raw.postCount,
    totalViews: raw.totalViews,
    totalLikes: raw.totalLikes,
    totalShares: raw.totalShares,
    totalComments: raw.totalComments,
    avgViews: raw.avgViews,
    recentPostCount: raw.recentPostCount,
    growth: raw.growth,
    observedAt: raw.fetchedAt ?? fallbackObservedAt,
  };
}

/**
 * Hashtag keys are stored WITH a leading '#'. The parent app shipped a silent
 * lookup-key mismatch here that made every real value miss and fall through to
 * a zero default — which then read as fabricated data. Normalise on both sides.
 */
function normaliseTag(tag: string): string {
  const t = tag.trim().toLowerCase();
  return t.startsWith('#') ? t : `#${t}`;
}

class FixtureSocial implements SocialMetricsPort {
  async getHashtagMetrics(
    platform: Platform,
    hashtags: string[],
  ): Promise<Sourced<HashtagMetric[]>> {
    if (platform !== 'tiktok') {
      // Honest emptiness beats a plausible-looking fabrication.
      return {
        value: [],
        source: {
          id: `fixture:${platform}`,
          kind: 'cache',
          observedAt: apify.lastUpdated,
          recordCount: 0,
        },
      };
    }

    const pool: Record<string, RawHashtag> = {
      ...apify.tiktok.fragranceHashtags,
      ...apify.tiktok.ingredientHashtags,
    };
    const index = new Map<string, RawHashtag>();
    for (const [k, v] of Object.entries(pool)) index.set(normaliseTag(k), v);

    const value: HashtagMetric[] = [];
    for (const tag of hashtags) {
      const hit = index.get(normaliseTag(tag));
      if (!hit) continue; // No hit => omit. Never push a zero row.
      const metric = toMetric(hit, apify.lastUpdated);
      if (metric) value.push(metric);
    }

    return {
      value,
      source: {
        id: 'apify:clockworks~tiktok-scraper',
        kind: 'cache',
        observedAt: apify.lastUpdated,
        recordCount: value.length,
        ref: 'fixture snapshot of production Apify daily cache',
      },
    };
  }

  async lastObservedAt(platform: Platform): Promise<string | null> {
    return platform === 'tiktok' ? apify.lastUpdated : null;
  }
}

/**
 * Deterministic stand-in for live web search.
 *
 * Returns nothing rather than inventing prose. A tool that depends on live web
 * intelligence should surface a partial-coverage envelope in fixture mode, not
 * a confident answer assembled offline.
 */
class FixtureWeb implements WebIntelPort {
  async queryQualitative<T>(_q: WebIntelQuery): Promise<Sourced<T>> {
    return {
      value: null as T,
      source: {
        id: 'fixture:web-intel',
        kind: 'cache',
        observedAt: trendingFile.fetchedAt,
        recordCount: 0,
        ref: 'live web intelligence disabled in fixture mode',
      },
    };
  }
}

/**
 * Historical series derived from the single snapshot we have.
 *
 * One snapshot is not a series. This returns [] for every request, which is the
 * correct and honest answer — the parent app's advanced-analytics pages once
 * faked trajectories with `(index % 4) + 2` formulas and that was the single
 * worst data-integrity bug in the codebase.
 */
class FixtureStore implements TrendStorePort {
  async getSeries(
    entity: string,
    metric: string,
    _sinceDays: number,
  ): Promise<Sourced<TrendSnapshot[]>> {
    return {
      value: [],
      source: {
        id: 'fixture:trend-store',
        kind: 'cache',
        observedAt: apify.lastUpdated,
        recordCount: 0,
        ref: `no persisted history for ${entity}/${metric} in fixture mode`,
      },
    };
  }

  async listEntities(entityType: TrendSnapshot['entityType']): Promise<string[]> {
    if (entityType === 'ingredient') {
      return ingredientFile.data.map((d) => d.ingredient.name);
    }
    if (entityType === 'hashtag') {
      return Object.keys(apify.tiktok.fragranceHashtags);
    }
    return trendingFile.fragrances.map((f) => f.name);
  }
}

class FixtureReference implements ReferencePort {
  async fragrances(): Promise<FragranceRef[]> {
    return trendingFile.fragrances.map((f) => ({
      name: f.name,
      brand: f.brand,
      hashtag: f.hashtag,
      gender: f.gender,
      priceRange: f.priceRange,
    }));
  }

  async ingredients(): Promise<IngredientRef[]> {
    return ingredientFile.data.map((d) => ({
      name: d.ingredient.name,
      category: d.ingredient.category,
      description: d.ingredient.description,
      origin: d.ingredient.origin,
    }));
  }

  async hashtagTaxonomy() {
    const all = Object.keys(apify.tiktok.fragranceHashtags).map(normaliseTag);
    // Generic community tags must never be presented as brand signal — mixing
    // them was a documented defect in the parent app.
    const generic = new Set([
      '#perfume',
      '#fragrance',
      '#cologne',
      '#perfumetok',
      '#fragrancetok',
      '#summerfragrance',
      '#winterfragrance',
      '#perfumecollection',
      '#nicheperfume',
      '#designerperfume',
    ]);
    return {
      generic: all.filter((t) => generic.has(t)),
      brand: all.filter((t) => !generic.has(t)),
      ingredient: Object.keys(apify.tiktok.ingredientHashtags).map(normaliseTag),
    };
  }
}

export function createFixtureRegistry(): SourceRegistry {
  return {
    social: new FixtureSocial(),
    web: new FixtureWeb(),
    store: new FixtureStore(),
    reference: new FixtureReference(),
  };
}

export const fixtureMeta = {
  apifyObservedAt: apify.lastUpdated,
  trendingObservedAt: trendingFile.fetchedAt,
};
