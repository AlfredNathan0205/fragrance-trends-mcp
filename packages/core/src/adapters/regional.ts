/**
 * Tool 3: regional trends.
 *
 * Collapses seven near-duplicate services from the parent app
 * (north-america-trends, europe-trends, middle-east-trends, india-trends,
 * china-trends, africa-trends, south-america-trends) into one tool with a
 * region parameter. Seven endpoints became one enum — the single largest
 * surface-area reduction in the conversion.
 *
 * Regional output is qualitative by contract. Live web search can characterise
 * a market ("oud-forward, gifting-driven, Ramadan-peaked") but cannot measure
 * it. Any number here would be invented, so the tool returns none.
 */

import type { ToolContext, ToolResult, ToolSpec } from '../tool.js';
import { obj, optInt, reqEnum } from '../validate.js';

export const REGIONS = [
  'north_america',
  'europe',
  'middle_east',
  'india',
  'china',
  'africa',
  'south_america',
] as const;
export type Region = (typeof REGIONS)[number];

const REGION_LABEL: Record<Region, string> = {
  north_america: 'North America',
  europe: 'Europe',
  middle_east: 'Middle East',
  india: 'India',
  china: 'China',
  africa: 'Africa',
  south_america: 'South America',
};

export interface RegionalTrend {
  region: string;
  theme: string;
  description: string;
  /** Categorical, not numeric — a model may assign these. */
  reach: 'global' | 'widespread' | 'regional' | 'niche';
  keyDrivers: string[];
  exampleBrands: string[];
}

interface RegionalInput {
  region: Region;
  limit: number;
}

/**
 * Strip non-ASCII before parsing.
 *
 * The Far East prompts in the parent app leaked CJK characters into the model's
 * JSON response and broke JSON.parse outright. Non-negotiable for any prompt
 * touching China, Japan, or Korea.
 */
function safeParse<T>(text: string): T | null {
  try {
    const cleaned = text.replace(/[^\x20-\x7E\s]/g, '');
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start === -1 || end === -1) return null;
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

export const getRegionalTrends: ToolSpec<RegionalInput, RegionalTrend[]> = {
  name: 'get_regional_trends',
  description:
    'Qualitative fragrance market characterisation for one region: dominant themes, demand drivers, and ' +
    'representative brands. Returns NO numeric market-size, share, or growth figures — those cannot be ' +
    'measured from open sources and will not be estimated. Use get_trending_fragrances for measured numbers.',
  costClass: 'live',
  ttlSeconds: 12 * 3600,
  inputSchema: {
    type: 'object',
    required: ['region'],
    properties: {
      region: {
        type: 'string',
        enum: [...REGIONS],
        description: 'Target market region.',
      },
      limit: { type: 'integer', default: 8, minimum: 1, maximum: 20 },
    },
  },
  parseInput(raw) {
    const o = obj(raw);
    return {
      region: reqEnum(o, 'region', REGIONS),
      limit: optInt(o, 'limit', 8, 1, 20),
    };
  },
  async run(input, ctx): Promise<ToolResult<RegionalTrend[]>> {
    const label = REGION_LABEL[input.region];

    if (!ctx.allowVendorCalls) {
      return {
        data: [],
        sources: [
          {
            id: 'fixture:web-intel',
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
          `Regional intelligence for ${label} requires a live web-search call, which is disabled in this deployment mode. No cached regional snapshot exists, so an empty result is returned rather than a stale or synthesised one.`,
        ],
        observedAt: null,
        cacheHit: false,
      };
    }

    const prompt = [
      `Characterise the current fragrance market in ${label}.`,
      `Return a JSON array of at most ${input.limit} objects with keys:`,
      `theme, description, reach (one of: global, widespread, regional, niche), keyDrivers (array of strings), exampleBrands (array of strings).`,
      '',
      'Hard constraints:',
      '- Do NOT invent numeric statistics, market size figures, percentages, or growth rates.',
      '- Return qualitative descriptors only.',
      '- Respond in English using ASCII characters only.',
      '- If you are not confident about a theme, omit it rather than filling the array.',
    ].join('\n');

    const { value, source } = await ctx.sources.web.queryQualitative<string>({
      prompt,
      // Cloud Run terminates connections past ~30s; per-provider budget stays under it.
      timeoutMs: 8000,
      region: input.region,
    });

    const parsed = typeof value === 'string' ? safeParse<RegionalTrend[]>(value) : null;
    const rows = (parsed ?? [])
      .slice(0, input.limit)
      .map((r) => ({ ...r, region: label }));

    return {
      data: rows,
      sources: [source],
      // The model wrote prose and picked enum labels. It authored no numbers.
      modelRole: rows.length > 0 ? 'qualitative_only' : 'none',
      numericOrigin: 'none',
      requested: input.limit,
      returned: rows.length,
      omissions:
        rows.length === 0
          ? [`No parseable qualitative result returned for ${label}.`]
          : undefined,
      observedAt: source.observedAt,
      cacheHit: source.kind === 'cache',
    };
  },
};
