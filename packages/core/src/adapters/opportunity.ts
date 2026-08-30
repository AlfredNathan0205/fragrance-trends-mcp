/**
 * Tools 7-8: market gaps and fragrance launches.
 *
 * From enhanced-market-gap-service.ts and fragrance-launch-refresh.ts /
 * launch-intelligence-live.ts.
 *
 * Launch intelligence carries a placeholder-filter inheritance: the parent app
 * shipped records with $150 default prices, impossible future years, and one
 * hallucinated influencer attribution. Those filters are ported here as
 * explicit, testable rejection rules rather than ad-hoc string checks buried in
 * a refresh loop.
 */

import type { SourceRef } from '../provenance/types.js';
import type { ToolContext, ToolResult, ToolSpec } from '../tool.js';
import { obj, optEnum, optInt, optString } from '../validate.js';

// ---------------------------------------------------------------------------
// Tool 7: find_market_gaps
// ---------------------------------------------------------------------------

export interface MarketGap {
  segment: string;
  /** 0-100. Derived from measured demand signal against catalogue coverage. */
  gapScore: number;
  demandSignal: string;
  supplyObservation: string;
  recommendedIngredients: string[];
  /** Which measured inputs produced the score. */
  basis: string;
}

interface GapInput {
  limit: number;
  minScore: number;
  category: string | null;
}

export const findMarketGaps: ToolSpec<GapInput, MarketGap[]> = {
  name: 'find_market_gaps',
  description:
    'Whitespace analysis: ingredient and segment combinations with measured consumer demand but thin ' +
    'catalogue coverage. Gap scores are derived arithmetic over measured engagement and catalogue counts, ' +
    'with the basis stated per row. Not a market-size estimate and not a revenue projection.',
  costClass: 'heavy',
  ttlSeconds: 24 * 3600,
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', default: 10, minimum: 1, maximum: 30 },
      min_score: { type: 'integer', default: 0, minimum: 0, maximum: 100 },
      category: { type: 'string', description: 'Optional ingredient category filter.' },
    },
  },
  parseInput(raw) {
    const o = obj(raw);
    return {
      limit: optInt(o, 'limit', 10, 1, 30),
      minScore: optInt(o, 'min_score', 0, 0, 100),
      category: optString(o, 'category'),
    };
  },
  async run(input, ctx): Promise<ToolResult<MarketGap[]>> {
    const tax = await ctx.sources.reference.hashtagTaxonomy();
    const { value: ingredientMetrics, source } = await ctx.sources.social.getHashtagMetrics(
      'tiktok',
      tax.ingredient,
    );
    const catalogue = await ctx.sources.reference.fragrances();
    const ingredients = await ctx.sources.reference.ingredients();

    const catByName = new Map(ingredients.map((i) => [i.name.toLowerCase(), i.category]));

    // Supply proxy: how many catalogued fragrances list this ingredient.
    const supply = new Map<string, number>();
    for (const f of catalogue) {
      for (const n of f.notes ?? []) {
        const k = n.toLowerCase();
        supply.set(k, (supply.get(k) ?? 0) + 1);
      }
    }

    const maxViews = Math.max(1, ...ingredientMetrics.map((m) => m.totalViews));

    let rows: MarketGap[] = ingredientMetrics
      .map((m) => {
        const name = m.hashtag.replace(/^#/, '');
        const demand = m.totalViews / maxViews; // 0-1, measured
        const supplyCount = supply.get(name.toLowerCase()) ?? 0;
        const coverage = Math.min(1, supplyCount / Math.max(1, catalogue.length * 0.2));
        const gapScore = Math.round(demand * (1 - coverage) * 100);
        return {
          segment: name,
          gapScore,
          demandSignal: `${m.totalViews.toLocaleString('en-GB')} observed views across ${m.postCount} posts.`,
          supplyObservation:
            supplyCount === 0
              ? 'No catalogued fragrance in the reference set lists this note.'
              : `${supplyCount} catalogued fragrance(s) list this note.`,
          recommendedIngredients: [name],
          basis: `demand=${demand.toFixed(3)} (views normalised to peak), coverage=${coverage.toFixed(3)} (catalogue share), gapScore=round(demand*(1-coverage)*100).`,
          _category: catByName.get(name.toLowerCase()) ?? null,
        };
      })
      .filter((r) => r.gapScore >= input.minScore)
      .sort((a, b) => b.gapScore - a.gapScore) as Array<MarketGap & { _category: string | null }>;

    const omissions: string[] = [];
    if (input.category) {
      const want = input.category.toLowerCase();
      const before = rows.length;
      rows = (rows as Array<MarketGap & { _category: string | null }>).filter(
        (r) => r._category?.toLowerCase() === want,
      );
      if (rows.length < before) omissions.push(`${before - rows.length} rows outside category "${input.category}".`);
    }

    const clean: MarketGap[] = rows.slice(0, input.limit).map(({ ...r }) => {
      delete (r as Record<string, unknown>)['_category'];
      return r as MarketGap;
    });

    if (catalogue.length < 50) {
      omissions.push(
        `Supply coverage is computed against a reference catalogue of only ${catalogue.length} fragrances. Gap scores are directional, not absolute, until a full catalogue is connected.`,
      );
    }

    return {
      data: clean,
      sources: [source],
      modelRole: 'none',
      numericOrigin: 'derived',
      requested: input.limit,
      returned: clean.length,
      omissions,
      observedAt: source.observedAt,
      cacheHit: source.kind === 'cache',
    };
  },
};

// ---------------------------------------------------------------------------
// Tool 8: get_fragrance_launches
// ---------------------------------------------------------------------------

export interface Launch {
  name: string;
  brand: string;
  announcedDate: string | null;
  priceGbp: number | null;
  notes: string[];
  sourceUrl: string | null;
}

interface LaunchInput {
  sinceDays: number;
  brand: string | null;
  limit: number;
  segment: 'all' | 'designer' | 'niche';
}

const SEGMENTS = ['all', 'designer', 'niche'] as const;

/** Placeholder patterns that reached production in the parent app. */
const PLACEHOLDER_NAME = /^(tbd|tba|unknown|coming soon|new launch|untitled|n\/a)$/i;
/** A suspiciously universal default price — real launches are not all identical. */
const SUSPECT_DEFAULT_PRICE = 150;

export function rejectPlaceholder(l: Launch, maxYear: number): string | null {
  if (!l.name || PLACEHOLDER_NAME.test(l.name.trim())) return `placeholder name "${l.name}"`;
  if (!l.brand || PLACEHOLDER_NAME.test(l.brand.trim())) return `placeholder brand "${l.brand}"`;
  if (l.announcedDate) {
    const y = new Date(l.announcedDate).getFullYear();
    if (!Number.isFinite(y) || y > maxYear) return `announced year ${y} exceeds cap ${maxYear}`;
    if (y < 1900) return `implausible announced year ${y}`;
  }
  if (l.priceGbp === SUSPECT_DEFAULT_PRICE) return 'price equals the known placeholder default';
  return null;
}

export const getFragranceLaunches: ToolSpec<LaunchInput, Launch[]> = {
  name: 'get_fragrance_launches',
  description:
    'Recently announced fragrance launches with brand, date, price and note pyramid where verifiable. ' +
    'Records failing placeholder, future-year, or default-price checks are rejected and counted in the ' +
    'coverage report rather than returned. Fields that cannot be verified are null, never filled with a default.',
  costClass: 'live',
  ttlSeconds: 12 * 3600,
  inputSchema: {
    type: 'object',
    properties: {
      since_days: { type: 'integer', default: 90, minimum: 1, maximum: 730 },
      brand: { type: 'string', description: 'Optional brand filter.' },
      segment: { type: 'string', enum: [...SEGMENTS], default: 'all' },
      limit: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
    },
  },
  parseInput(raw) {
    const o = obj(raw);
    return {
      sinceDays: optInt(o, 'since_days', 90, 1, 730),
      brand: optString(o, 'brand', null, 80),
      segment: optEnum(o, 'segment', SEGMENTS, 'all'),
      limit: optInt(o, 'limit', 20, 1, 100),
    };
  },
  async run(input, ctx): Promise<ToolResult<Launch[]>> {
    const omissions: string[] = [];
    const sources: SourceRef[] = [];

    if (!ctx.allowVendorCalls) {
      return {
        data: [],
        sources: [
          {
            id: 'fixture:launch-intel',
            kind: 'cache',
            observedAt: new Date().toISOString(),
            recordCount: 0,
            ref: 'vendor calls disabled',
          },
        ],
        modelRole: 'none',
        numericOrigin: 'none',
        requested: input.limit,
        returned: 0,
        omissions: [
          'Launch intelligence requires live web search, disabled in this deployment mode. Returning empty rather than a stale launch list, which would be worse than none for a buyer making a competitive call.',
        ],
        observedAt: null,
        cacheHit: false,
      };
    }

    const prompt = [
      `List fragrance launches announced in the last ${input.sinceDays} days.`,
      input.brand ? `Restrict to brand: ${input.brand}.` : '',
      input.segment !== 'all' ? `Restrict to ${input.segment} houses.` : '',
      'Return a JSON array with keys: name, brand, announcedDate (ISO date), priceGbp (number or null), notes (array), sourceUrl.',
      'Set any field you cannot verify to null. Do NOT guess a price. Do NOT invent a source URL.',
      'Omit any launch you are not confident actually exists.',
    ]
      .filter(Boolean)
      .join('\n');

    const { value, source } = await ctx.sources.web.queryQualitative<Launch[]>({
      prompt,
      timeoutMs: 8000,
    });
    sources.push(source);

    const raw = Array.isArray(value) ? value : [];
    const maxYear = new Date().getFullYear() + 1;
    const kept: Launch[] = [];
    let rejected = 0;

    for (const l of raw) {
      const reason = rejectPlaceholder(l, maxYear);
      if (reason) {
        rejected++;
        if (omissions.length < 5) omissions.push(`Rejected "${l?.name ?? 'unnamed'}": ${reason}.`);
        continue;
      }
      // A number is admissible only if it is attributable. An unsourced price
      // is a model guess wearing a currency symbol, so it is nulled rather than
      // shown — the field stays present so consumers can see it was unverifiable.
      if (l.priceGbp !== null && !l.sourceUrl) {
        l.priceGbp = null;
        if (omissions.length < 8) {
          omissions.push(`Dropped unsourced price for "${l.name}": no citable URL accompanied the figure.`);
        }
      }
      kept.push(l);
    }
    if (rejected > 5) omissions.push(`...and ${rejected - 5} further rejected records.`);

    const rows = kept.slice(0, input.limit);
    const pricedRows = rows.filter((r) => r.priceGbp !== null);

    return {
      data: rows,
      sources,
      modelRole: rows.length > 0 ? 'qualitative_only' : 'none',
      // Prices that survived are attributable to a source URL; everything else
      // in this payload is a string or null.
      numericOrigin: pricedRows.length > 0 ? 'measured' : 'none',
      requested: input.limit,
      returned: rows.length,
      omissions,
      observedAt: source.observedAt,
      cacheHit: source.kind === 'cache',
    };
  },
};
