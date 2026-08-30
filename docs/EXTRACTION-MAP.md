# Extraction map

Which of the parent app's 67 service files move into `packages/core`, and in
what order. Figures below come from static analysis of the actual repo
(source revision `dd99405`), not estimates.

## Headline

| Measure | Value |
|---|---|
| Service files | 67 |
| Service LOC | 29,671 |
| Express-coupled | **0 files** |
| DB-coupled | 4 files (1,095 LOC) |
| Clean lift candidates | **63 files (28,576 LOC), 96%** |

The good news is better than expected. The earlier read of "12 of 67 touch
Express" counted type imports; on closer analysis **no service file imports
Express or calls `res.json`**. Request handling was already confined to
`server/api/` and `server/routes/`. The service layer is genuinely portable.

## Decoupling work, by tier

### Tier 1 — pure logic (11 files, 6,003 LOC)

No vendor SDK, no database. Copy, retype against ports, done.

| File | LOC |
|---|---|
| `comprehensive-fragrance-library-service.ts` | 1,606 |
| `comprehensive-emotion-mapper-service.ts` | 1,008 |
| `enhanced-predictive-intelligence-service.ts` | 830 |
| `enhanced-fragrance-knowledge-service.ts` | 556 |
| `trend-detector.ts` | 479 |
| `ml-prediction-service.ts` | 399 |
| `scrape-creator-service.ts` | 396 |
| `comprehensive-demographics-service.ts` | 254 |
| `comprehensive-sustainability-service.ts` | 236 |
| `fragella-service.ts` | 197 |
| `report-registry.ts` | 42 |

`comprehensive-fragrance-library-service.ts` is the single most valuable file in
the repo: 1,606 lines of fragrance taxonomy — houses, note pyramids, ingredient
families. Not derivable from a scrape, expensive to rebuild, and the backbone of
`ReferencePort`. Lift it first.

### Tier 2 — single-vendor (52 files)

Replace one SDK import with a port. Mechanical.

| Vendor | Files touching it |
|---|---|
| YouTube | 21 |
| Gemini | 17 |
| OpenAI | 14 |
| Apify | 14 |
| PDFKit | 7 |
| Bright Data | 5 |
| EnsembleData | 3 |
| OpenRouter | 2 |
| Firecrawl / Octoparse / SendGrid | 1 each |

The long tail matters commercially: Octoparse, EnsembleData, Firecrawl and
ScrapeCreator each appear in 1–3 files. Each is a separate contract to
renegotiate for resale rights. **Cutting the three lightest-touch vendors
removes three negotiations for roughly 400 LOC of rework** — likely the best
trade available before licensing.

### Tier 3 — DB-coupled (4 files, 1,095 LOC)

Need `TrendStorePort` before they lift. All four are longitudinal, so they are
also the ones blocked on historical data.

| File | LOC |
|---|---|
| `trend-lifecycle-service.ts` | 398 |
| `cross-platform-migration-service.ts` | 286 |
| `micro-trend-detector-service.ts` | 224 |
| `trend-velocity-service.ts` | 187 |

Reimplemented in `adapters/longitudinal.ts` rather than lifted — their original
fallback paths fabricated trajectories, so the logic needed rewriting, not
porting.

### Tier 4 — multi-vendor (5 files)

Three or more vendors in one file. Highest rework cost, highest contract risk.

| File | LOC | Vendors |
|---|---|---|
| `report-generator-service.ts` | 1,697 | Gemini, OpenAI, PDFKit, YouTube |
| `openai-trend-service.ts` | 588 | Apify, OpenAI, YouTube |
| `apify-page-data.ts` | 443 | Apify, Gemini, YouTube |
| `crystal-ball-service.ts` | 250 | Gemini, OpenAI, OpenRouter |
| `grok-trend-service.ts` | 183 | OpenAI, OpenRouter, YouTube |

Defer all five past v1. `report-generator-service.ts` alone is 1,697 lines and
half of it is PDF layout, which the MCP does not need — `generate_trend_report`
returns structured sections and lets the client render.

## Non-code assets

Higher value per line than any service file.

| Asset | Why it matters |
|---|---|
| `.agents/memory/*.md` (22 notes) | 12+ months of production scar tissue. Six are already encoded as guard checks; the rest belong in the runbook. |
| `apify_cache.json` (256 KB) | Real engagement snapshot. Now the fixture backing the zero-cost demo. |
| `.data-cache/*.json` (92 KB) | Trending lists, market gaps, emerging signals. Seed + demo data. |
| Hashtag taxonomies | The brand/generic/ingredient split in `apify-daily-cache.ts`. Mixing those categories was a documented defect; the taxonomy is the fix. |

## Sequence

**Phase 0 — clear the blockers (do first, in parallel with nothing)**
IP ownership in writing. Vendor resale-rights audit. Neither is engineering
work and both can invalidate everything downstream.

**Phase 0.5 — start writing daily snapshots today**
Whatever else happens. Three of the ten tools are empty without history, and the
clock on a 12-month series only starts once. This is a cron job and a table.

**Phase 1 — core extraction (~2 weeks)**
Tier 1 lift, starting with the fragrance library. `ReferencePort` and
`SocialMetricsPort` implemented live. Guard checks ported alongside.

**Phase 2 — three tools live (~2 weeks)**
`get_trending_fragrances`, `get_trending_ingredients`,
`search_fragrance_intelligence` against real Apify and Perplexity. Proves the
provenance contract under live conditions.

**Phase 3 — tenancy and metering (~2 weeks)**
Postgres with `tenant_id` everywhere. Replace the in-memory store. Usage
statements and budget alerts.

**Phase 4 — remaining seven tools (~3 weeks)**
Tier 2 vendors behind ports. Tier 3 unblocked by whatever history Phase 0.5 has
accumulated.

**Total to licensable v1: 9–10 weeks**, assuming Phase 0 clears. Against 4–6
months from scratch.

## What this scaffold already proves

Running `npm run smoke`:

- 10 tools registered, cost-classed, TTL-declared
- Real snapshot data flowing through the full envelope
- Guard catching four fabrication signatures on a synthetic payload
- Guard catching a **genuine clamp-pegging defect** in the real production data
- Plan gating blocking an evaluation tenant from a heavy tool
- Budget and rate limits stopping a runaway caller

Running `npm run mcp:check`: MCP handshake, tool listing with JSON Schema, a
live tool call over stdio, and correctly shaped errors.
