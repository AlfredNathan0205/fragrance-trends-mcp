# Architecture

## Why this shape

The source production app is a single-tenant web product: 123 REST
endpoints, 35 Postgres tables with no tenant column, Azure AD SSO with a domain
allowlist, and a React frontend of 40+ pages. All of that is correct for one
company's staff using one dashboard.

A licensed MCP is a different product with the same brain. What a licensee buys
is not the dashboard — it is the data pipeline and the judgement encoded around
it. So the conversion keeps the service layer, discards the delivery layer, and
adds the three things a licence requires: a provenance guarantee, tenant
isolation, and cost control.

```
┌──────────────────────────────────────────────────────────────┐
│  MCP client (Claude Desktop · Cursor · Claude Code · agent)  │
└───────────────────────────┬──────────────────────────────────┘
                            │ MCP over stdio / HTTP+SSE
┌───────────────────────────▼──────────────────────────────────┐
│  packages/mcp — protocol layer                               │
│  ListTools · CallTool · error shaping. No business logic.    │
└───────────────────────────┬──────────────────────────────────┘
                            │ executeTool()
┌───────────────────────────▼──────────────────────────────────┐
│  packages/core — execution pipeline                          │
│                                                              │
│   parseInput ─► authorise ─► run ─► buildEnvelope ─► guard   │
│                    │                                  │      │
│                    │                            fail closed  │
│                    ▼                                         │
│            packages/api (Meter)                              │
│                                                              │
│  10 ToolSpecs ── adapters/ ── ports/ (interfaces only)       │
└───────────────────────────┬──────────────────────────────────┘
                            │
        ┌───────────────────┴───────────────────┐
        ▼                                       ▼
┌──────────────────┐                 ┌──────────────────────┐
│ fixtures/        │                 │ live/  (post-contract)│
│ real snapshots   │                 │ Apify · Perplexity    │
│ zero vendor cost │                 │ Firecrawl · YouTube   │
└──────────────────┘                 └──────────────────────┘
```

## The four load-bearing decisions

### 1. Ten tools, not 123 endpoints

MCP clients degrade as tool count grows: the calling model re-reads the whole
tool list every turn and picks one. A 123-entry menu of near-synonyms
(`/api/europe-trends`, `/api/india-trends`, `/api/china-trends`…) guarantees
mis-selection and burns context on every request.

Seven regional endpoints became one `region` enum. Dashboard-shaped endpoints
that existed to feed a specific React page disappeared entirely. What remains is
ten capabilities that a model can distinguish by name.

Rule going forward: an eleventh tool must justify why it cannot be a parameter
on an existing one.

### 2. Provenance is a type, not a convention

Every response is an `Envelope<T>`:

```jsonc
{
  "data": [ /* ... */ ],
  "provenance": {
    "sources":   [{ "id": "apify:clockworks~tiktok-scraper", "kind": "cache",
                    "observedAt": "2026-07-23T07:46:26.953Z", "recordCount": 41 }],
    "cache":     { "hit": true, "ageSeconds": 1749000, "ttlSeconds": 21600,
                   "staleness": "stale" },
    "integrity": { "modelRole": "none", "numericOrigin": "measured",
                   "guard": "enforced", "notes": [ /* findings */ ] },
    "coverage":  { "requested": 15, "returned": 11, "partial": true,
                   "omissions": ["4 tracked hashtags had no measured data …"] }
  },
  "meta": { "tool": "...", "tenantId": "...", "costUnits": 1, "durationMs": 2 }
}
```

`modelRole` is the contractual field. `qualitative_only` means the model saw
measured data and returned prose or categorical labels — it did not author a
number. `generative` is rejected outright in licensed mode.

This turns `.agents/memory/anti-hallucination.md` from tribal prose into
something a procurement reviewer can test.

### 3. The integrity guard fails closed

`packages/core/src/provenance/guard.ts` inspects every payload before it can
leave. Each check is a production incident from the parent app, made executable:

| Finding | Origin |
|---|---|
| `FLAT_DISTRIBUTION` | growth was always `0` because the formula required ≥4 sample posts and only 3 were stored |
| `CONSTANT_CROSS_FIELD_RATIO` | poisoned disk cache where likes/views was exactly 0.06 on every row |
| `CLAMP_PEGGING` | *(found by this guard, in the real snapshot — see below)* |
| `IMPLAUSIBLE_ROUNDNESS` | hand-filled cache entries with post counts in exact thousands |
| `UNDECLARED_NUMERICS` | payload contains numbers the tool claimed it had none of |
| `GENERATIVE_MODEL_IN_LICENSED_MODE` | policy |

Error-severity findings throw. Warnings ride along in
`provenance.integrity.notes` so the licensee sees them too — hiding a caveat is
how you lose a renewal.

**The guard found a live defect on first run.** Against the genuine production
snapshot (`apify_cache.json`, observed 2026-07-23), it reported:

```
CLAMP_PEGGING [growth]: 22 of 41 rows (54%) sit on the extremes -50 / 200.
```

Fourteen hashtags report growth of exactly +200 and nine exactly −50. Those are
clamp bounds, not measurements. Over half the dataset is reporting the ceiling
as if it were an observation, which means any ranking or momentum label built on
`growth` is unreliable for those rows. That is a real bug in the parent app,
surfaced by a guard written in an afternoon — and a reasonable argument for
building the guard before building anything else.

### 4. Cost is declared on the tool

Vendor spend scales with tool calls. An enthusiastic licensee wiring
`generate_trend_report` into a loop can outspend their licence fee in an
afternoon, and the Apify bill arrives here.

Each `ToolSpec` declares a `costClass`, and the meter **pre-authorises** before
the vendor call:

| Class | Units | Meaning |
|---|---|---|
| `cached` | 1 | served from a warm snapshot |
| `derived` | 2 | deterministic computation, CPU only |
| `live` | 10 | at least one paid scrape or web-search call |
| `heavy` | 50 | multi-stage fan-out plus synthesis |

Charging after the fact means the budget is already blown, so authorisation
happens first.

## Package boundaries

| Package | Depends on | Contains |
|---|---|---|
| `@ftm/core` | nothing | ports, adapters, provenance, guard, registry, pipeline |
| `@ftm/api` | core | tenancy, plans, metering, budget |
| `@ftm/mcp` | core, api | MCP protocol binding, stdio entrypoint |

Core has **zero runtime dependencies**. Input validation is hand-rolled rather
than pulling Zod, because a licensed server ships into customer environments
where every transitive dependency is a supply-chain question at security review.
The whole tree is one runtime dependency: the MCP SDK.

## Ports and fixture mode

Adapters depend on interfaces (`SocialMetricsPort`, `WebIntelPort`,
`TrendStorePort`, `ReferencePort`), never on vendor SDKs. Three consequences:

1. **Demos cost nothing.** `createFixtureRegistry()` serves real captured
   snapshots. A prospect can run the server with no keys.
2. **Vendors are swappable.** If Apify's terms block resale, the port is
   reimplemented against another provider without touching trend logic.
3. **Behaviour is testable.** Deterministic inputs, deterministic assertions.

Fixture mode stays honest: sources are tagged `kind: "cache"` with their true
`observedAt`, so the envelope reports `staleness: "stale"` on months-old data
rather than implying it is live.

## Honest emptiness

`analyze_trend_velocity` and `predict_trend_lifecycle` return **zero rows** in
fixture mode, each with a stated reason:

```
Khamrah: 0 historical observation(s) available, 4 required. No trajectory is
reported. This is a data-coverage limit, not a finding of "no trend".
```

The parent app's equivalents fabricated trajectories from array-index formulas
(`(index % 4) + 2`) when the snapshot table was empty. The output looked
plausibly varied and was entirely invented. Refusing to answer is the single
most important behavioural change in the conversion, and the hardest to
sell internally — an empty dashboard panel looks like a bug until you understand
what the alternative was.

This also names the real gap: **the historical snapshot table is the missing
asset.** Point-in-time engagement is cheap to acquire. A trustworthy 12-month
series is not, and it is what makes longitudinal tools worth licensing. Start
writing daily snapshots now, whatever else happens — the clock on that asset
only starts once.

## What is deliberately absent

- **Frontend.** 40+ React pages, ~15 abandoned dashboard variants. Not needed.
- **Human auth.** Azure AD SSO, Passport sessions, CSRF, login forms. A licensee
  is a key with a contract, not a user with a password.
- **PDF rendering.** Four generators, ~3k lines. `generate_trend_report` returns
  structured data; rendering is a client concern.
- **The 5,187-line `routes.ts`.** Replaced by a 45-line registry.

## Deployment modes

| Mode | `FTM_API_KEY` | Vendor calls | Use |
|---|---|---|---|
| Fixture | unset | none | demos, evaluation, CI |
| Licensed | set | enabled | production licensee |

```jsonc
{
  "mcpServers": {
    "fragrance-trends": {
      "command": "npx",
      "args": ["-y", "@ftm/mcp"],
      "env": { "FTM_API_KEY": "ftm_..." }
    }
  }
}
```

## Before a licensee touches this

1. **IP ownership.** The source production app includes client-specific branding
   and deployment configuration. Ownership and reuse rights must be settled in
   writing first. This scaffold is a clean repo with no inherited git history for
   that reason, but a clean repo is not a clean title.
2. **Vendor resale rights.** Apify, Bright Data, Firecrawl, EnsembleData,
   Octoparse, RapidAPI and OpenRouter mostly permit internal use and restrict
   resale of derived data. A licensed MCP is resale.
3. **Postgres tenancy.** The in-memory `TenantStore` is a proof of concept.
   Real deployment needs a `tenant_id` column on every table and row-level
   scoping — the largest single piece of net-new work.
4. **Historical snapshots.** Without them, three of the ten tools return empty.
