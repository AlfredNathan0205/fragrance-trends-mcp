/**
 * Tools 9-10: freeform intelligence search and report generation.
 *
 * From trend-chat.ts / insight-grounding-service.ts and report-generator-service.ts.
 *
 * These two are the reason the grounding contract exists. A freeform question
 * and a generated report are exactly where a model is most tempted to supply a
 * confident number nobody measured. Both tools therefore run the model in
 * grounded mode: measured context is injected, and the model is instructed to
 * cite the injected figures or say nothing.
 */

import type { HashtagMetric } from '../ports/index.js';
import type { SourceRef } from '../provenance/types.js';
import type { ToolContext, ToolResult, ToolSpec } from '../tool.js';
import { obj, optEnum, optInt, reqString } from '../validate.js';
import { momentumFrom } from './trending.js';

/**
 * Build the measured-data context block injected into every grounded prompt.
 *
 * Direct descendant of buildApifyAIContext() in the parent app. The rule it
 * encodes: the model may only reference numbers that appear in this block.
 */
export function buildGroundingContext(metrics: HashtagMetric[]): string {
  if (metrics.length === 0) {
    return 'MEASURED DATA: none available for this query.\nYou must state that no measured data was available. Do not supply figures from memory.';
  }
  const lines = metrics
    .slice(0, 25)
    .map(
      (m) =>
        `- ${m.hashtag}: ${m.postCount} posts, ${m.totalViews} views, ${m.totalLikes} likes, growth ${m.growth}%, momentum ${momentumFrom(m.growth)}, observed ${m.observedAt}`,
    );
  return [
    'MEASURED DATA (the only figures you may cite):',
    ...lines,
    '',
    'Rules:',
    '- Every number in your answer must appear verbatim above.',
    '- Do NOT introduce market sizes, revenue figures, percentages, or counts from your own knowledge.',
    '- If the measured data does not answer the question, say so plainly.',
    '- Qualitative interpretation, context, and recommendations are welcome and expected.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Tool 9: search_fragrance_intelligence
// ---------------------------------------------------------------------------

export interface IntelligenceAnswer {
  question: string;
  answer: string;
  /** Measured figures the answer was allowed to draw on. */
  groundedOn: Array<{ hashtag: string; views: number; posts: number; growth: number }>;
  /** True when the model was given no measured data to work from. */
  ungrounded: boolean;
}

interface SearchInput {
  question: string;
  scope: 'social' | 'market' | 'ingredient' | 'auto';
}

const SCOPES = ['auto', 'social', 'market', 'ingredient'] as const;

export const searchFragranceIntelligence: ToolSpec<SearchInput, IntelligenceAnswer[]> = {
  name: 'search_fragrance_intelligence',
  description:
    'Answers a freeform fragrance market question. The model is grounded on measured engagement data and ' +
    'may only cite figures present in that grounding set; it will state that data is unavailable rather ' +
    'than estimate. Returns the grounding set alongside the answer so any figure can be traced.',
  costClass: 'live',
  ttlSeconds: 3600,
  inputSchema: {
    type: 'object',
    required: ['question'],
    properties: {
      question: {
        type: 'string',
        description: 'Natural-language question, e.g. "Is gourmand momentum slowing on TikTok?"',
      },
      scope: {
        type: 'string',
        enum: [...SCOPES],
        default: 'auto',
        description: 'Which grounding set to load. "auto" selects from the question wording.',
      },
    },
  },
  parseInput(raw) {
    const o = obj(raw);
    return {
      question: reqString(o, 'question', 1000),
      scope: optEnum(o, 'scope', SCOPES, 'auto'),
    };
  },
  async run(input, ctx): Promise<ToolResult<IntelligenceAnswer[]>> {
    const tax = await ctx.sources.reference.hashtagTaxonomy();

    const scope =
      input.scope !== 'auto'
        ? input.scope
        : /ingredient|note|accord|oud|vanilla|musk|amber/i.test(input.question)
          ? 'ingredient'
          : 'social';

    const tags =
      scope === 'ingredient' ? tax.ingredient : [...tax.brand, ...tax.generic];

    const { value: metrics, source } = await ctx.sources.social.getHashtagMetrics('tiktok', tags);
    const grounding = buildGroundingContext(metrics);
    const sources: SourceRef[] = [source];

    if (!ctx.allowVendorCalls) {
      return {
        data: [
          {
            question: input.question,
            answer:
              'Model synthesis is disabled in this deployment mode. The measured grounding set that would have been used is returned below, so the question can be answered manually against real figures.',
            groundedOn: metrics.slice(0, 25).map((m) => ({
              hashtag: m.hashtag,
              views: m.totalViews,
              posts: m.postCount,
              growth: m.growth,
            })),
            ungrounded: metrics.length === 0,
          },
        ],
        sources,
        modelRole: 'none',
        numericOrigin: 'measured',
        requested: 1,
        returned: 1,
        omissions: ['Synthesis step skipped: vendor calls disabled.'],
        observedAt: source.observedAt,
        cacheHit: source.kind === 'cache',
      };
    }

    const { value: answer, source: modelSource } = await ctx.sources.web.queryQualitative<string>({
      prompt: `${grounding}\n\nQUESTION: ${input.question}\n\nAnswer in under 250 words.`,
      timeoutMs: 8000,
    });
    sources.push(modelSource);

    return {
      data: [
        {
          question: input.question,
          answer: typeof answer === 'string' && answer.trim() ? answer.trim() : 'No answer returned.',
          groundedOn: metrics.slice(0, 25).map((m) => ({
            hashtag: m.hashtag,
            views: m.totalViews,
            posts: m.postCount,
            growth: m.growth,
          })),
          ungrounded: metrics.length === 0,
        },
      ],
      sources,
      modelRole: 'qualitative_only',
      numericOrigin: 'measured',
      requested: 1,
      returned: 1,
      omissions:
        metrics.length === 0
          ? ['No measured data matched this question; the answer is explicitly ungrounded.']
          : undefined,
      observedAt: source.observedAt,
      cacheHit: source.kind === 'cache',
    };
  },
};

// ---------------------------------------------------------------------------
// Tool 10: generate_trend_report
// ---------------------------------------------------------------------------

export interface ReportSection {
  heading: string;
  body: string;
  /** Measured figures cited in this section, for footnoting. */
  figures: Array<{ label: string; value: number; source: string; observedAt: string }>;
}

export interface TrendReport {
  title: string;
  generatedAt: string;
  periodCovered: string;
  sections: ReportSection[];
  /** Explicit list of what the report could not cover. Goes in the document. */
  limitations: string[];
}

interface ReportInput {
  focus: string;
  sections: number;
  format: 'structured' | 'markdown';
}

const FORMATS = ['structured', 'markdown'] as const;

export const generateTrendReport: ToolSpec<ReportInput, TrendReport[]> = {
  name: 'generate_trend_report',
  description:
    'Assembles a structured trend report on a focus area from measured data plus grounded commentary. ' +
    'Every figure carries its source and observation date, and the report includes a limitations section ' +
    'listing what could not be evidenced. This is the most expensive tool; prefer narrower tools where possible.',
  costClass: 'heavy',
  ttlSeconds: 24 * 3600,
  inputSchema: {
    type: 'object',
    required: ['focus'],
    properties: {
      focus: {
        type: 'string',
        description: 'Report subject, e.g. "gourmand notes", "Middle East niche", "Lattafa".',
      },
      sections: { type: 'integer', default: 4, minimum: 1, maximum: 8 },
      format: { type: 'string', enum: [...FORMATS], default: 'structured' },
    },
  },
  parseInput(raw) {
    const o = obj(raw);
    return {
      focus: reqString(o, 'focus', 200),
      sections: optInt(o, 'sections', 4, 1, 8),
      format: optEnum(o, 'format', FORMATS, 'structured'),
    };
  },
  async run(input, ctx): Promise<ToolResult<TrendReport[]>> {
    const tax = await ctx.sources.reference.hashtagTaxonomy();
    const { value: metrics, source } = await ctx.sources.social.getHashtagMetrics('tiktok', [
      ...tax.brand,
      ...tax.generic,
      ...tax.ingredient,
    ]);

    const top = [...metrics].sort((a, b) => b.totalViews - a.totalViews).slice(0, 10);
    const limitations: string[] = [];

    if (metrics.length === 0) {
      limitations.push('No measured engagement data was available; no quantitative section could be produced.');
    }
    // Longitudinal sections require history the fixture store does not have.
    const history = await ctx.sources.store.getSeries(input.focus, 'post_count', 90);
    if (history.value.length < 4) {
      limitations.push(
        `Trajectory analysis omitted: ${history.value.length} historical observation(s) for "${input.focus}", 4 required. The report covers a point-in-time snapshot only.`,
      );
    }
    if (!ctx.allowVendorCalls) {
      limitations.push('Narrative commentary omitted: model synthesis disabled in this deployment mode.');
    }

    const sections: ReportSection[] = [
      {
        heading: `Measured engagement — ${input.focus}`,
        body:
          top.length > 0
            ? `Ranked by observed total views across ${metrics.length} tracked hashtags.`
            : 'No measured engagement available for this focus area.',
        figures: top.map((m) => ({
          label: m.hashtag,
          value: m.totalViews,
          source: source.id,
          observedAt: m.observedAt,
        })),
      },
      {
        heading: 'Momentum distribution',
        body: (() => {
          const buckets = new Map<string, number>();
          for (const m of metrics) {
            const k = momentumFrom(m.growth);
            buckets.set(k, (buckets.get(k) ?? 0) + 1);
          }
          return [...buckets.entries()]
            .map(([k, v]) => `${v} hashtag(s) classified ${k}`)
            .join('; ') || 'No momentum data.';
        })(),
        figures: [],
      },
    ].slice(0, input.sections);

    const report: TrendReport = {
      title: `Fragrance trend report: ${input.focus}`,
      generatedAt: new Date().toISOString(),
      periodCovered: source.observedAt
        ? `Snapshot observed ${source.observedAt}`
        : 'Unknown period',
      sections,
      limitations,
    };

    return {
      data: [report],
      sources: [source, history.source],
      modelRole: ctx.allowVendorCalls ? 'qualitative_only' : 'none',
      numericOrigin: 'measured',
      requested: input.sections,
      returned: sections.length,
      omissions: limitations,
      observedAt: source.observedAt,
      cacheHit: source.kind === 'cache',
    };
  },
};
