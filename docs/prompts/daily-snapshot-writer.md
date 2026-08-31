# Claude Code prompt — daily snapshot writer

Paste everything below the line into Claude Code, run from inside
`fragrance-trends-mcp/`. It assumes the repo is already cloned and `npm install`
has been run.

---

## Context

This repository (`fragrance-trends-mcp`) is a licensable Model Context Protocol
server for fragrance trend intelligence. Read `CLAUDE.md`, `docs/ARCHITECTURE.md`
and `packages/core/src/ports/index.ts` before writing any code — they define
invariants this task must not violate.

Three of the ten tools make longitudinal claims and currently return honest,
empty results because there is no historical data:

- `analyze_trend_velocity` (`packages/core/src/adapters/longitudinal.ts`)
- `predict_trend_lifecycle` (same file)
- Any future report section that depends on a trajectory

Both call `ctx.sources.store.getSeries(entity, metric, sinceDays)`, defined by
`TrendStorePort` in `packages/core/src/ports/index.ts`. The current
implementation, `FixtureStore` in `packages/core/src/fixtures/registry.ts`,
always returns `[]` — there is exactly one historical snapshot in the whole
repo, and one point is not a series (`MIN_POINTS = 4` in `longitudinal.ts`).

**Your job is not to change those three tools or flip any commercial gate.**
Your job is to build the daily job that starts accumulating the history they
need. The tools already know how to consume it once it exists.

## Non-negotiables (do not violate any of these)

1. **Do not modify `packages/mcp`, `packages/api`, or the existing tool logic
   in `packages/core/src/adapters/`.** This task only adds a new, separate
   writer and a new store adapter. The existing fixture-mode MCP server must
   keep working exactly as it does today.
2. **Do not touch, query, or credential against the production database**
   (the Neon Postgres behind the live Trend Analysis / ScentTrends
   application). This writer uses its own, newly provisioned database. If you
   are unsure whether a connection string points at production, stop and ask
   rather than connect.
3. **Do not flip `FTM_MODE` to `licensed` or wire this new store into
   `createFixtureRegistry()` or the HTTP/stdio servers.** Licensed mode stays
   fail-closed per `CLAUDE.md` invariant 6 until a separate, explicit task
   clears the legal gates and wires an approved `SourceRegistry`. This task
   only produces the data; connecting it to a live tool path is future work.
4. **Never zero-fill or interpolate a missing observation.** If a vendor call
   fails or returns nothing for an entity, skip that entity for that day and
   record why. Follow the existing pattern in `toMetric()` in
   `fixtures/registry.ts`, which drops a record rather than defaulting a
   missing `growth` field to `0`.
5. **No secrets, client branding, or production hostnames in committed
   files.** Extend `.gitignore` and `.env.example` rather than hardcoding
   anything. `npm run check:commercial` must still pass.
6. Every run must be **idempotent**: running the job twice on the same UTC day
   must not create duplicate rows.
7. Every run must be **auditable**: record what ran, when, how many vendor
   calls were made, how many rows were written, and any entities skipped —
   this is the same provenance discipline the rest of the codebase already
   follows (see `provenance/envelope.ts`).

## What to build

### 1. A new isolated Postgres database

Provision a **new** Postgres database dedicated to this writer — do not reuse
the production database. Supabase is available as a connector in this
environment; use it, or any Postgres the user prefers, but confirm which one
before writing connection code. Add the connection string as
`SNAPSHOT_DATABASE_URL` in `.env.example` (placeholder only) and read it via
`process.env`.

### 2. Schema

Create `packages/snapshot-writer/sql/001_init.sql`:

```sql
create table if not exists trend_snapshots (
  id           bigint generated always as identity primary key,
  entity       text not null,
  entity_type  text not null check (entity_type in ('fragrance','ingredient','note','hashtag')),
  metric       text not null,
  value        double precision not null,
  observed_at  timestamptz not null,
  source_id    text not null,
  source_kind  text not null,
  record_count integer not null default 1,
  run_id       uuid not null,
  created_at   timestamptz not null default now(),
  unique (entity, metric, observed_at)
);

create index if not exists trend_snapshots_entity_metric_idx
  on trend_snapshots (entity, metric, observed_at desc);

create table if not exists snapshot_runs (
  id              uuid primary key,
  started_at      timestamptz not null,
  finished_at     timestamptz,
  status          text not null check (status in ('running','success','partial','failed')),
  vendor_calls    integer not null default 0,
  rows_written    integer not null default 0,
  entities_skipped jsonb not null default '[]',
  error           text
);
```

`observed_at` is truncated to the UTC day the run executed, which is what makes
`unique (entity, metric, observed_at)` double as the idempotency key: rerunning
the same day upserts (`on conflict do update`) rather than inserting twice.

### 3. The writer script

Create `packages/snapshot-writer/src/run.ts`. It should:

1. Generate a `run_id` (UUID) and insert a `snapshot_runs` row with
   `status='running'`.
2. Load the tracked entity/hashtag list from a **committed config file**,
   `packages/snapshot-writer/config/tracked-entities.json` — do not derive this
   list from production. Seed it from the existing fixture taxonomy in
   `packages/core/src/fixtures/registry.ts` (`hashtagTaxonomy()`,
   `trending-fragrances.json`, `ingredient-trends.json`) as a reasonable
   starting set, but make it a plain editable JSON file so the tracked list can
   grow independently of fixtures.
3. Call the real Apify TikTok actor (`clockworks/tiktok-scraper`, the same one
   already referenced as `apify:clockworks~tiktok-scraper` throughout this
   repo) via the user's own Apify account. Use the `apify` connector /
   `APIFY_TOKEN` env var — a **new token scoped to this project**, not the
   production one. One actor run per invocation; do not loop per-hashtag.
4. For each tracked entity, compute the same aggregate shape as
   `HashtagMetric` in `ports/index.ts` (`postCount`, `totalViews`, `growth`,
   etc.) and write one `trend_snapshots` row per `(entity, metric)` you can
   support today — at minimum `metric='post_count'`, since that's what
   `velocityFrom()` and `classify()` in `longitudinal.ts` consume. Skip, don't
   zero-fill, any entity absent from the actor's response.
5. Upsert with `on conflict (entity, metric, observed_at) do update set
   value = excluded.value, record_count = excluded.record_count`.
6. On completion, update the `snapshot_runs` row: `status` (`success` if every
   tracked entity got a row, `partial` if some were skipped, `failed` on an
   unhandled error), `vendor_calls`, `rows_written`, `entities_skipped`.
7. Exit non-zero on `failed` so the scheduler surfaces it; exit zero on
   `partial` but log a clear warning — a partial day is expected and honest,
   not a bug.

### 4. A Postgres-backed `TrendStorePort`, kept separate from the fixture path

Create `packages/core/src/adapters/postgres-store.ts` implementing
`TrendStorePort` against the same `trend_snapshots` table (`getSeries` selects
by `entity` + `metric` within `sinceDays`; `listEntities` selects distinct
`entity` by `entity_type`). This is the adapter a future, explicitly-approved
licensed `SourceRegistry` will use — **do not wire it into
`createFixtureRegistry()`, the HTTP transport, or the stdio transport in this
task.** Export it from `packages/core/src/index.ts` alongside the existing
exports so it's available, but unused, until that future task connects it.

### 5. Scheduling

Add `.github/workflows/daily-snapshot.yml`:

- Trigger: `schedule` (once daily, pick a fixed UTC hour) and
  `workflow_dispatch` (manual run for testing).
- Steps: checkout, setup-node, `npm ci`, `npm run snapshot:run`.
- Secrets: `APIFY_TOKEN` and `SNAPSHOT_DATABASE_URL` as GitHub Actions
  repository secrets — never committed.
- This workflow must be **separate from `verify.yml`**. It costs real vendor
  spend and must never run on every push or pull request.

Add to `package.json`:

```json
"snapshot:run": "tsx packages/snapshot-writer/src/run.ts",
"snapshot:migrate": "tsx packages/snapshot-writer/src/migrate.ts"
```

### 6. Tests

Add `packages/snapshot-writer/src/run.test.ts` (or a `scripts/snapshot-check.ts`
following the existing `scripts/http-check.ts` style) covering, against a local
or test database:

- A fixture-backed dry run (no real Apify call — inject a fake actor client)
  writes the expected number of rows and skips entities with no data.
- Running the same simulated day twice results in the same row count (upsert,
  not duplicate).
- A vendor failure marks the run `partial` or `failed` and never writes a
  fabricated value.

### 7. Documentation

Add `docs/SNAPSHOTS.md` covering: the schema, how to provision the database,
how to get an Apify token, the manual dry-run command, what "the clock starts
once you deploy this" means in practice (three tools stay empty-but-honest
until `MIN_POINTS = 4` daily rows accumulate, i.e. four days minimum, and
meaningfully more before velocity/lifecycle output is useful), and the explicit
note that wiring `postgres-store.ts` into a live tool path is a separate,
future task gated on the legal clearances in `docs/COMMERCIALIZATION.md`.

## Acceptance criteria

- `npm run check:commercial`, `npm run build`, `npm run smoke`, `npm run
  mcp:check`, and `npm run http:check` all still pass unmodified — this task
  must not regress the existing verified surface.
- `npm run snapshot:migrate` creates the schema against a fresh database.
- `npm run snapshot:run` executed twice against the same day produces no
  duplicate rows and a correct `snapshot_runs` audit trail.
- A manually-triggered `daily-snapshot.yml` run succeeds end to end in GitHub
  Actions using repository secrets.
- No file changed under `packages/mcp/`, `packages/api/`, or
  `packages/core/src/adapters/longitudinal.ts` (confirm with `git diff
  --stat` before finishing).
- `postgres-store.ts` exists, is exported, and is **not** referenced by
  `packages/mcp/src/stdio.ts`, `packages/mcp/src/http.ts`, or
  `createFixtureRegistry()`.

Report back: the database you provisioned, the row count after the first run,
which entities were skipped and why, and confirmation that the four files
listed above are untouched.
