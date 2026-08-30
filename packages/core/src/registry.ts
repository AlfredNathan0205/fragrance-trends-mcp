/**
 * The ten tools.
 *
 * Ten, not the parent app's 123 REST endpoints. MCP clients degrade badly as
 * tool count grows — the calling model has to pick correctly from the list on
 * every turn, and a 123-entry menu of near-synonyms guarantees mis-selection.
 * Seven regional endpoints collapsed into one region enum; the rest were either
 * UI plumbing, auth, or variations that belong behind a parameter.
 *
 * Adding an eleventh tool should require justifying why it cannot be a
 * parameter on an existing one.
 */

import { detectEmergingTrends, analyzeTrendVelocity, predictTrendLifecycle } from './adapters/longitudinal.js';
import { generateTrendReport, searchFragranceIntelligence } from './adapters/intelligence.js';
import { findMarketGaps, getFragranceLaunches } from './adapters/opportunity.js';
import { getRegionalTrends } from './adapters/regional.js';
import { getTrendingFragrances, getTrendingIngredients } from './adapters/trending.js';
import type { AnyToolSpec } from './tool.js';

export const TOOLS: AnyToolSpec[] = [
  getTrendingFragrances,
  getTrendingIngredients,
  getRegionalTrends,
  analyzeTrendVelocity,
  predictTrendLifecycle,
  detectEmergingTrends,
  findMarketGaps,
  getFragranceLaunches,
  searchFragranceIntelligence,
  generateTrendReport,
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): AnyToolSpec {
  const t = TOOL_BY_NAME.get(name);
  if (!t) {
    throw new Error(
      `Unknown tool "${name}". Available: ${TOOLS.map((x) => x.name).join(', ')}.`,
    );
  }
  return t;
}
