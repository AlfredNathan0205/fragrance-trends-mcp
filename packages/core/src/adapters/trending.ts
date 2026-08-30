/**
 * Tools 1-2: trending fragrances and trending ingredients.
 *
 * Lifted from the parent app's perplexity-trending-service.ts and
 * apify-page-data.ts (buildTrendingFragrancesFromApify / buildTrendingIngredientsFromApify).
 *
 * One canonical growth number. The parent app computed "growth" three different
 * ways on three different pages and a user cross-checking one fragrance saw
 * 103%, 6%, and "Stable" — three answers to one real-world question. Momentum
 * here is a pure function of the single measured growth field, so every
 * consumer agrees by construction.
 */

import type { HashtagMetric } from '../ports/index.js';
import type { ToolContext, ToolResult, ToolSpec } from '../tool.js';
import { obj, optEnum, optInt } from '../validate.js';

export type Momentum = 'surging' | 'growing' | 'stable' | 'declining';

/** Single source of truth for momentum. Do not re-derive this anywhere else. */
export function momentumFrom(growth: number): Momentum {
  if (growth >= 100) return 'surging';
  if (growth >= 25) return 'growing';
  if (growth > -15) return 'stable';
  return 'declining';
}

export interface TrendingRow {
  rank: number;
  entity: string;
  hashtag: string;
  postCount: number;
  totalViews: number;
  totalLikes: number;
  avgViews: number;
  recentPostCount: number;
  growth: number;
  momentum: Momentum;
  observedAt: string;
}

function rank(metrics: HashtagMetric[], limit: number): TrendingRow[] {
  return [...metrics]
    .sort((a, b) => b.totalViews - a.totalViews)
    .slice(0, limit)
    .map((m, i) => ({
      rank: i + 1,
      entity: m.hashtag.replace(/^#/, ''),
      hashtag: m.hashtag,
      postCount: m.postCount,
      totalViews: m.totalViews,
      totalLikes: m.totalLikes,
      avgViews: m.avgViews,
      recentPostCount: m.recentPostCount,
      growth: m.growth,
      momentum: momentumFrom(m.growth),
      observedAt: m.observedAt,
    }));
}

const SEGMENTS = ['all', 'brand', 'generic'] as const;
type Segment = (typeof SEGMENTS)[number];

interface TrendingInput {
  limit: number;
  segment: Segment;
}

export const getTrendingFragrances: ToolSpec<TrendingInput, TrendingRow[]> = {
  name: 'get_trending_fragrances',
  description:
    'Ranked fragrance hashtags by measured TikTok engagement, with a canonical growth figure and momentum label. ' +
    'Every number is observed, never model-generated. Returns fewer rows than requested rather than padding, ' +
    'and does not forecast — use predict_trend_lifecycle for forward-looking output.',
  costClass: 'cached',
  ttlSeconds: 6 * 3600,
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        description: 'Maximum rows to return (1-50).',
        default: 15,
        minimum: 1,
        maximum: 50,
      },
      segment: {
        type: 'string',
        enum: [...SEGMENTS],
        default: 'all',
        description:
          'brand = specific product hashtags (#baccaratrouge540). generic = category tags (#perfumetok). ' +
          'These measure different things and should not be compared directly.',
      },
    },
  },
  parseInput(raw) {
    const o = obj(raw);
    return {
      limit: optInt(o, 'limit', 15, 1, 50),
      segment: optEnum(o, 'segment', SEGMENTS, 'all'),
    };
  },
  async run(input, ctx): Promise<ToolResult<TrendingRow[]>> {
    const tax = await ctx.sources.reference.hashtagTaxonomy();
    const tags =
      input.segment === 'brand'
        ? tax.brand
        : input.segment === 'generic'
          ? tax.generic
          : [...tax.brand, ...tax.generic];

    const { value, source } = await ctx.sources.social.getHashtagMetrics('tiktok', tags);
    const rows = rank(value, input.limit);

    const omissions: string[] = [];
    if (value.length < tags.length) {
      omissions.push(
        `${tags.length - value.length} of ${tags.length} tracked hashtags had no measured data in this snapshot and were omitted rather than zero-filled.`,
      );
    }

    return {
      data: rows,
      sources: [source],
      modelRole: 'none',
      numericOrigin: 'measured',
      requested: input.limit,
      returned: rows.length,
      omissions,
      observedAt: source.observedAt,
      cacheHit: source.kind === 'cache',
    };
  },
};

export interface IngredientRow extends TrendingRow {
  category: string | null;
}

interface IngredientInput {
  limit: number;
  category: string | null;
}

export const getTrendingIngredients: ToolSpec<IngredientInput, IngredientRow[]> = {
  name: 'get_trending_ingredients',
  description:
    'Ranked fragrance ingredients and notes (oud, pistachio, ambroxan) by measured social engagement, ' +
    'joined to an ingredient taxonomy. Numbers are observed. Category labels are static reference data, not inferred.',
  costClass: 'cached',
  ttlSeconds: 24 * 3600,
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', default: 15, minimum: 1, maximum: 50 },
      category: {
        type: 'string',
        description: 'Optional filter, e.g. "Gourmand", "Woody", "Floral". Case-insensitive.',
      },
    },
  },
  parseInput(raw) {
    const o = obj(raw);
    const cat = o['category'];
    return {
      limit: optInt(o, 'limit', 15, 1, 50),
      category: typeof cat === 'string' && cat.trim() ? cat.trim().toLowerCase() : null,
    };
  },
  async run(input, ctx): Promise<ToolResult<IngredientRow[]>> {
    const tax = await ctx.sources.reference.hashtagTaxonomy();
    const { value, source } = await ctx.sources.social.getHashtagMetrics(
      'tiktok',
      tax.ingredient,
    );

    const refs = await ctx.sources.reference.ingredients();
    const catByName = new Map(refs.map((r) => [r.name.toLowerCase(), r.category]));

    let rows: IngredientRow[] = rank(value, 50).map((r) => ({
      ...r,
      category: catByName.get(r.entity.toLowerCase()) ?? null,
    }));

    const omissions: string[] = [];
    if (input.category) {
      const before = rows.length;
      rows = rows.filter((r) => r.category?.toLowerCase() === input.category);
      if (rows.length < before) {
        omissions.push(
          `Filtered to category "${input.category}": ${before - rows.length} rows excluded.`,
        );
      }
    }

    const uncategorised = rows.filter((r) => r.category === null).length;
    if (uncategorised > 0) {
      omissions.push(
        `${uncategorised} ingredients have measured engagement but no taxonomy entry; category is null rather than guessed.`,
      );
    }

    rows = rows.slice(0, input.limit).map((r, i) => ({ ...r, rank: i + 1 }));

    return {
      data: rows,
      sources: [source],
      modelRole: 'none',
      numericOrigin: 'measured',
      requested: input.limit,
      returned: rows.length,
      omissions,
      observedAt: source.observedAt,
      cacheHit: source.kind === 'cache',
    };
  },
};
