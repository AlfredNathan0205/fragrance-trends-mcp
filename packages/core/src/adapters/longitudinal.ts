/**
 * Tools 4-6: velocity, lifecycle, emerging detection.
 *
 * Lifted from trend-velocity-service.ts, trend-lifecycle-service.ts,
 * micro-trend-detector-service.ts and trend-detector.ts.
 *
 * All three make longitudinal claims, and longitudinal claims need history.
 * The parent app's versions fabricated trajectories from array-index formulas
 * ((index % 4) + 2) when the snapshot table was empty. The output looked
 * plausibly varied and was entirely invented. These versions return an empty
 * result with an explicit omission note instead — the single most important
 * behavioural change in the whole conversion.
 */

import type { TrendSnapshot } from '../ports/index.js';
import type { SourceRef } from '../provenance/types.js';
import type { ToolContext, ToolResult, ToolSpec } from '../tool.js';
import { obj, optEnum, optInt, reqString } from '../validate.js';

/** Minimum observations before any trajectory claim is permitted. */
const MIN_POINTS = 4;

function insufficient(
  entity: string,
  have: number,
): string {
  return `${entity}: ${have} historical observation(s) available, ${MIN_POINTS} required. No trajectory is reported. This is a data-coverage limit, not a finding of "no trend".`;
}

// ---------------------------------------------------------------------------
// Tool 4: analyze_trend_velocity
// ---------------------------------------------------------------------------

export interface VelocityRow {
  entity: string;
  /** Posts per day, measured. Count-based, not view-based — see note below. */
  postingVelocity: number;
  velocityChange: number;
  acceleration: number;
  windowDays: number;
  observations: number;
}

interface VelocityInput {
  entities: string[] | null;
  windowDays: number;
  limit: number;
}

/**
 * Velocity is computed from posting counts, not raw view counts.
 *
 * Comparing view totals of newer posts against older posts is structurally
 * biased toward "decline", because older posts simply had longer to accumulate
 * views. That is a time-since-posted artifact, not a trend signal.
 */
function velocityFrom(series: TrendSnapshot[], windowDays: number): Omit<VelocityRow, 'entity'> | null {
  if (series.length < MIN_POINTS) return null;
  const sorted = [...series].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const mid = Math.floor(sorted.length / 2);
  const older = sorted.slice(0, mid);
  const newer = sorted.slice(mid);

  const rate = (pts: TrendSnapshot[]) => {
    const span =
      (Date.parse(pts[pts.length - 1]!.observedAt) - Date.parse(pts[0]!.observedAt)) /
      86_400_000;
    const total = pts.reduce((s, p) => s + p.value, 0);
    return span > 0 ? total / span : total;
  };

  const rNew = rate(newer);
  const rOld = rate(older);
  const change = rOld > 0 ? ((rNew - rOld) / rOld) * 100 : 0;

  return {
    postingVelocity: Number(rNew.toFixed(2)),
    velocityChange: Number(change.toFixed(1)),
    acceleration: Number((rNew - rOld).toFixed(2)),
    windowDays,
    observations: sorted.length,
  };
}

export const analyzeTrendVelocity: ToolSpec<VelocityInput, VelocityRow[]> = {
  name: 'analyze_trend_velocity',
  description:
    'Rate of change in posting activity for fragrances or ingredients, computed from stored historical ' +
    'snapshots. Velocity is count-based, not view-based, to avoid the time-accumulation bias that makes ' +
    'older content look like decline. Entities with fewer than 4 observations are omitted with a stated ' +
    'reason rather than given an estimated trajectory.',
  costClass: 'derived',
  ttlSeconds: 3600,
  inputSchema: {
    type: 'object',
    properties: {
      entities: {
        type: 'array',
        items: { type: 'string' },
        description: 'Fragrance or ingredient names. Omit to analyse all tracked entities.',
      },
      window_days: { type: 'integer', default: 30, minimum: 7, maximum: 365 },
      limit: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
    },
  },
  parseInput(raw) {
    const o = obj(raw);
    const e = o['entities'];
    return {
      entities: Array.isArray(e) ? e.filter((x): x is string => typeof x === 'string') : null,
      windowDays: optInt(o, 'window_days', 30, 7, 365),
      limit: optInt(o, 'limit', 20, 1, 100),
    };
  },
  async run(input, ctx): Promise<ToolResult<VelocityRow[]>> {
    const entities =
      input.entities ?? (await ctx.sources.store.listEntities('fragrance')).slice(0, input.limit);

    const rows: VelocityRow[] = [];
    const omissions: string[] = [];
    const sources: SourceRef[] = [];

    for (const entity of entities.slice(0, input.limit)) {
      const { value, source } = await ctx.sources.store.getSeries(
        entity,
        'post_count',
        input.windowDays,
      );
      if (sources.length === 0) sources.push(source);
      const v = velocityFrom(value, input.windowDays);
      if (v) rows.push({ entity, ...v });
      else omissions.push(insufficient(entity, value.length));
    }

    return {
      data: rows,
      sources: sources.length ? sources : [emptySource('trend-store')],
      modelRole: 'none',
      numericOrigin: 'derived',
      requested: Math.min(entities.length, input.limit),
      returned: rows.length,
      omissions,
      observedAt: sources[0]?.observedAt ?? null,
      cacheHit: false,
      ignoreFields: ['windowDays'],
    };
  },
};

// ---------------------------------------------------------------------------
// Tool 5: predict_trend_lifecycle
// ---------------------------------------------------------------------------

export type LifecycleStage = 'emerging' | 'growth' | 'peak' | 'plateau' | 'decline';

export interface LifecycleRow {
  entity: string;
  stage: LifecycleStage;
  /** 0-100, derived from observation count and series consistency — not model output. */
  confidence: number;
  observations: number;
  spanDays: number;
  rationale: string;
}

interface LifecycleInput {
  entity: string;
  horizonDays: number;
}

function classify(series: TrendSnapshot[]): LifecycleRow | null {
  if (series.length < MIN_POINTS) return null;
  const sorted = [...series].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const spanDays = Math.max(
    1,
    Math.round((Date.parse(last.observedAt) - Date.parse(first.observedAt)) / 86_400_000),
  );

  const q = Math.max(1, Math.floor(sorted.length / 4));
  const head = sorted.slice(0, q).reduce((s, p) => s + p.value, 0) / q;
  const tail = sorted.slice(-q).reduce((s, p) => s + p.value, 0) / q;
  const peak = Math.max(...sorted.map((p) => p.value));
  const delta = head > 0 ? ((tail - head) / head) * 100 : 0;
  const nearPeak = peak > 0 && tail >= peak * 0.85;

  let stage: LifecycleStage;
  if (delta > 75) stage = nearPeak ? 'peak' : 'growth';
  else if (delta > 20) stage = 'growth';
  else if (delta > -10) stage = nearPeak ? 'peak' : 'plateau';
  else stage = 'decline';
  if (sorted.length <= MIN_POINTS + 1 && delta > 20) stage = 'emerging';

  // Confidence is a function of evidence volume and span. No model involved.
  const confidence = Math.min(
    95,
    Math.round(Math.min(sorted.length / 12, 1) * 60 + Math.min(spanDays / 90, 1) * 35),
  );

  return {
    entity: first.entity,
    stage,
    confidence,
    observations: sorted.length,
    spanDays,
    rationale: `Mean value moved ${delta.toFixed(1)}% from first to last quartile of ${sorted.length} observations across ${spanDays} days; latest is ${((tail / (peak || 1)) * 100).toFixed(0)}% of observed peak.`,
  };
}

export const predictTrendLifecycle: ToolSpec<LifecycleInput, LifecycleRow[]> = {
  name: 'predict_trend_lifecycle',
  description:
    'Classifies where one fragrance or ingredient sits in its trend lifecycle (emerging, growth, peak, ' +
    'plateau, decline) from stored observations, with a confidence score derived from evidence volume and ' +
    'time span. Returns an empty result when history is too thin to support a claim. Not a sales forecast.',
  costClass: 'derived',
  ttlSeconds: 6 * 3600,
  inputSchema: {
    type: 'object',
    required: ['entity'],
    properties: {
      entity: { type: 'string', description: 'Fragrance or ingredient name.' },
      horizon_days: { type: 'integer', default: 90, minimum: 30, maximum: 365 },
    },
  },
  parseInput(raw) {
    const o = obj(raw);
    return {
      entity: reqString(o, 'entity', 120),
      horizonDays: optInt(o, 'horizon_days', 90, 30, 365),
    };
  },
  async run(input, ctx): Promise<ToolResult<LifecycleRow[]>> {
    const { value, source } = await ctx.sources.store.getSeries(
      input.entity,
      'post_count',
      input.horizonDays,
    );
    const row = classify(value);

    return {
      data: row ? [row] : [],
      sources: [source],
      modelRole: 'none',
      numericOrigin: 'derived',
      requested: 1,
      returned: row ? 1 : 0,
      omissions: row ? undefined : [insufficient(input.entity, value.length)],
      observedAt: source.observedAt,
      cacheHit: false,
    };
  },
};

// ---------------------------------------------------------------------------
// Tool 6: detect_emerging_trends
// ---------------------------------------------------------------------------

export interface EmergingSignal {
  name: string;
  category: 'notes' | 'fragrances' | 'brands' | 'behaviour';
  momentum: 'explosive' | 'strong' | 'building';
  evidence: string;
  firstObservedAt: string;
  supportingEntities: string[];
}

interface EmergingInput {
  category: 'all' | EmergingSignal['category'];
  limit: number;
}

const CATEGORIES = ['all', 'notes', 'fragrances', 'brands', 'behaviour'] as const;

export const detectEmergingTrends: ToolSpec<EmergingInput, EmergingSignal[]> = {
  name: 'detect_emerging_trends',
  description:
    'Early-stage signals: notes, products or behaviours gaining traction before they appear in mainstream ' +
    'rankings. Each signal carries the evidence that triggered it. Signals are qualitative with categorical ' +
    'momentum labels — no invented growth percentages.',
  costClass: 'live',
  ttlSeconds: 12 * 3600,
  inputSchema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: [...CATEGORIES], default: 'all' },
      limit: { type: 'integer', default: 10, minimum: 1, maximum: 30 },
    },
  },
  parseInput(raw) {
    const o = obj(raw);
    return {
      category: optEnum(o, 'category', CATEGORIES, 'all'),
      limit: optInt(o, 'limit', 10, 1, 30),
    };
  },
  async run(input, ctx): Promise<ToolResult<EmergingSignal[]>> {
    // Measured leading indicator: high recent posting share against a low
    // absolute base. A tag with few total posts but most of them recent is
    // emerging; a tag with many posts spread evenly is established.
    const tax = await ctx.sources.reference.hashtagTaxonomy();
    const { value, source } = await ctx.sources.social.getHashtagMetrics('tiktok', [
      ...tax.ingredient,
      ...tax.brand,
    ]);

    const ingredientSet = new Set(tax.ingredient.map((t) => t.toLowerCase()));

    const signals: EmergingSignal[] = value
      .filter((m) => m.postCount > 0 && m.recentPostCount / m.postCount >= 0.5)
      .sort((a, b) => b.recentPostCount / b.postCount - a.recentPostCount / a.postCount)
      .map((m) => {
        const recentShare = (m.recentPostCount / m.postCount) * 100;
        return {
          name: m.hashtag.replace(/^#/, ''),
          category: (ingredientSet.has(m.hashtag.toLowerCase())
            ? 'notes'
            : 'fragrances') as EmergingSignal['category'],
          momentum: (recentShare >= 80
            ? 'explosive'
            : recentShare >= 65
              ? 'strong'
              : 'building') as EmergingSignal['momentum'],
          evidence: `${m.recentPostCount} of ${m.postCount} observed posts are recent (${recentShare.toFixed(0)}% recent share), against ${m.totalViews.toLocaleString('en-GB')} total views.`,
          firstObservedAt: m.observedAt,
          supportingEntities: [m.hashtag],
        };
      });

    const filtered =
      input.category === 'all'
        ? signals
        : signals.filter((s) => s.category === input.category);
    const rows = filtered.slice(0, input.limit);

    return {
      data: rows,
      sources: [source],
      modelRole: 'none',
      numericOrigin: 'measured',
      requested: input.limit,
      returned: rows.length,
      omissions:
        rows.length < input.limit
          ? [
              `Only ${rows.length} hashtags met the emergence threshold (>=50% of observed posts recent). Threshold is not lowered to fill the requested count.`,
            ]
          : undefined,
      observedAt: source.observedAt,
      cacheHit: source.kind === 'cache',
    };
  },
};

function emptySource(id: string): SourceRef {
  return { id: `internal:${id}`, kind: 'derived', observedAt: new Date().toISOString(), recordCount: 0 };
}
