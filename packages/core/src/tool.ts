/**
 * Tool contract.
 *
 * Deliberately protocol-agnostic. The MCP package adapts these to MCP tools;
 * the same specs can back a REST surface or a batch export without touching
 * business logic. The parent app's 5,187-line routes.ts is what happens when
 * transport and logic are not separated.
 */

import type { SourceRegistry } from './ports/index.js';
import type { Envelope, ModelRole, SourceRef } from './provenance/types.js';

/**
 * Cost class drives both billing and the per-tenant budget ceiling.
 *
 * Vendor spend scales directly with tool calls. An unmetered licensee running
 * `generate_trend_report` in a loop can outspend their own licence fee inside a
 * day, so cost is declared on the tool, not discovered on the invoice.
 */
export type CostClass = 'cached' | 'derived' | 'live' | 'heavy';

export const COST_UNITS: Record<CostClass, number> = {
  /** Served from a warm snapshot. Effectively free. */
  cached: 1,
  /** Deterministic computation over cached inputs. CPU only. */
  derived: 2,
  /** Triggers at least one paid vendor call (scrape or live web search). */
  live: 10,
  /** Multi-stage: several vendor calls plus model synthesis plus rendering. */
  heavy: 50,
};

export interface ToolContext {
  sources: SourceRegistry;
  tenantId: string;
  requestId: string;
  /** Licensed deployments reject generative numerics. Default true. */
  licensedMode: boolean;
  /** Set false in fixture/demo mode so tools degrade instead of calling vendors. */
  allowVendorCalls: boolean;
}

export interface ToolResult<T> {
  data: T;
  sources: SourceRef[];
  modelRole: ModelRole;
  numericOrigin: 'measured' | 'derived' | 'none';
  requested: number;
  returned: number;
  omissions?: string[];
  /** Observation time of the freshest input, for cache reporting. */
  observedAt: string | null;
  cacheHit: boolean;
  /** Numeric fields that are legitimately uniform and should not trip the guard. */
  ignoreFields?: string[];
}

export interface ToolSpec<TInput = unknown, TOutput = unknown> {
  name: string;
  /** Shown to the calling model. Must state what the tool will NOT do. */
  description: string;
  costClass: CostClass;
  /** Freshness contract surfaced in every envelope. */
  ttlSeconds: number;
  /** JSON Schema for MCP `inputSchema`. Hand-written to stay dependency-light. */
  inputSchema: Record<string, unknown>;
  /** Parse and validate raw input; throw on invalid. */
  parseInput(raw: unknown): TInput;
  run(input: TInput, ctx: ToolContext): Promise<ToolResult<TOutput>>;
}

export type AnyToolSpec = ToolSpec<any, any>;
export type { Envelope };
