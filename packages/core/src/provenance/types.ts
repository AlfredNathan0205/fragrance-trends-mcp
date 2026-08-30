/**
 * Provenance envelope.
 *
 * Every value that leaves this system is wrapped. This is not logging — it is the
 * licensable product guarantee. A licensee (Givaudan, Firmenich, dsm-firmenich,
 * Symrise, a brand-side insights team) will ask, in procurement:
 *
 *   "Which of these numbers did a language model make up?"
 *
 * The answer this system gives is: none, and here is the machine-checkable proof.
 *
 * Carried over from the parent app's `.agents/memory/anti-hallucination.md`, which
 * documented the rule informally. Here it is a type and a runtime guard.
 */

/** How a source produced its contribution. */
export type SourceKind =
  /** Real observation of the outside world (Apify, Bright Data, YouTube API). */
  | 'measured'
  /** Computed from measured inputs by deterministic code in this repo. */
  | 'derived'
  /** A language model. May NEVER be the origin of a numeric field. */
  | 'model'
  /** Replay of a previous measured/derived result. */
  | 'cache'
  /** Static reference data (taxonomies, ingredient families). */
  | 'reference';

export interface SourceRef {
  /** Stable id, e.g. 'apify:clockworks~tiktok-scraper'. */
  id: string;
  kind: SourceKind;
  /** When the underlying observation was made — NOT when we served it. */
  observedAt: string;
  /** Rows/records that actually came back. Lets a licensee judge sample size. */
  recordCount?: number;
  /** Public URL when the source is citable. */
  url?: string;
  /** Actor/model/endpoint identifier for audit. */
  ref?: string;
}

export type Staleness = 'fresh' | 'aging' | 'stale';

export interface CacheInfo {
  hit: boolean;
  ageSeconds: number;
  ttlSeconds: number;
  staleness: Staleness;
}

/**
 * The role a language model was permitted to play in this response.
 *
 * `qualitative_only` is the default and the contractual promise: the model saw
 * measured data as context and returned prose, labels, or categorical enums.
 * It did not author a number.
 */
export type ModelRole = 'none' | 'qualitative_only' | 'generative';

export interface IntegrityInfo {
  modelRole: ModelRole;
  /** Origin of every numeric field in `data`. 'none' when the payload has no numbers. */
  numericOrigin: 'measured' | 'derived' | 'none';
  /** Set when the runtime guard actually ran and passed. */
  guard: 'enforced' | 'skipped';
  /**
   * Populated when a tool deliberately returns less than asked rather than
   * filling the gap. Honest emptiness is a feature — see the parent app's
   * lesson that fabricated trajectories are worse than no trajectories.
   */
  notes?: string[];
}

export interface CoverageInfo {
  requested: number;
  returned: number;
  partial: boolean;
  /** Human-readable reasons for anything missing. */
  omissions?: string[];
}

export interface Provenance {
  sources: SourceRef[];
  generatedAt: string;
  cache: CacheInfo;
  integrity: IntegrityInfo;
  coverage: CoverageInfo;
}

export interface CallMeta {
  tool: string;
  tenantId: string;
  requestId: string;
  /** Billing units consumed. See packages/api/src/metering.ts. */
  costUnits: number;
  durationMs: number;
}

/** The single shape every MCP tool returns. */
export interface Envelope<T> {
  data: T;
  provenance: Provenance;
  meta: CallMeta;
}
