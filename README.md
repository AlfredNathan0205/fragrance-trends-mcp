# Fragrance Trends MCP

Commercial foundation for fragrance trend intelligence over the Model Context
Protocol. Ten tools, a provenance guarantee on every response, and per-tenant
cost control.

Extracted from the reusable intelligence patterns in the production trend
analysis application, with no inherited Git history or production deployment
configuration. Runs with no API keys in evaluation mode.

```bash
npm install
npm run build
npm run smoke        # full pipeline on real captured snapshots
npm run mcp:check    # MCP protocol conformance over stdio
npm run verify       # clean build + commercial boundary + smoke + MCP checks
```

## The ten tools

| Tool | Cost | Returns |
|---|---|---|
| `get_trending_fragrances` | cached | Ranked hashtags by measured engagement |
| `get_trending_ingredients` | cached | Ranked notes and ingredients, taxonomy-joined |
| `get_regional_trends` | live | Qualitative market characterisation, 7 regions |
| `analyze_trend_velocity` | derived | Rate of change from stored history |
| `predict_trend_lifecycle` | derived | Emerging / growth / peak / plateau / decline |
| `detect_emerging_trends` | live | Early signals with triggering evidence |
| `find_market_gaps` | heavy | Demand-vs-coverage whitespace |
| `get_fragrance_launches` | live | Recent launches, placeholder-filtered |
| `search_fragrance_intelligence` | live | Grounded answer to a freeform question |
| `generate_trend_report` | heavy | Structured report with figures and limitations |

## The guarantee

Every response is wrapped:

```jsonc
{
  "data": [ /* ... */ ],
  "provenance": {
    "sources":   [{ "id": "apify:clockworks~tiktok-scraper",
                    "kind": "cache", "observedAt": "2026-07-23T07:46:26.953Z" }],
    "cache":     { "staleness": "stale", "ageSeconds": 1749000 },
    "integrity": { "modelRole": "none", "numericOrigin": "measured",
                   "guard": "enforced" },
    "coverage":  { "requested": 15, "returned": 11, "partial": true,
                   "omissions": ["4 tracked hashtags had no measured data …"] }
  },
  "meta": { "costUnits": 1, "durationMs": 2 }
}
```

`modelRole: "none"` or `"qualitative_only"` means no language model authored a
number in `data`. A runtime guard enforces it and fails closed.

On first run against the real production snapshot, that guard reported:

```
CLAMP_PEGGING [growth]: 22 of 41 rows (54%) sit on the extremes -50 / 200.
```

A genuine defect — over half the dataset reporting clamp bounds as
measurements. Caught before it reached a licensee.

## Layout

```
packages/core   ports · adapters · provenance · guard · pipeline   (0 deps)
packages/api    tenancy · plans · metering · budget
packages/mcp    protocol binding · stdio entrypoint
docs/           ARCHITECTURE.md · EXTRACTION-MAP.md
```

## Modes

| Mode | `FTM_API_KEY` | Vendor calls |
|---|---|---|
| Fixture | `FTM_MODE=fixture` (default) | none — captured snapshots, zero spend |
| Licensed | `FTM_MODE=licensed` + key | **fail-closed until rights-approved live adapters and persistent stores are wired** |

## Status

Commercial foundation, not yet a hosted data product. Fixture mode is suitable
for demos and technical evaluation. Before a licensee uses live data: document
IP ownership, clear source/vendor rights for the intended use, implement the
approved live adapters, move tenancy and metering to Postgres, and accumulate
daily historical snapshots. See `docs/COMMERCIALIZATION.md`.

## Commercial model

The recommended first product is **single-customer licensed software deployed
in the customer's environment**, using the customer's own collection accounts
and keys. A hosted multi-tenant API/MCP that redistributes data is a later model
and requires explicit source rights plus database row isolation.

## Ownership and licence

Copyright © 2026 Nevodia Tech. All rights reserved. This repository is private
and proprietary; see `LICENSE`.
