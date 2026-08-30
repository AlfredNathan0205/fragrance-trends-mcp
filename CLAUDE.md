# Claude Code project rules

Read `docs/ARCHITECTURE.md` and `docs/COMMERCIALIZATION.md` before changing code.

## Non-negotiable invariants

1. All tools execute through `executeTool()`: validate, pre-authorise, run,
   envelope, guard, record. Never add a bypass.
2. Every response includes source, observed time, freshness, coverage,
   integrity, tenant, request ID, cost units, and duration.
3. Language models may produce qualitative prose and labels, but never invent
   numeric market metrics. Licensed mode rejects generative numerics.
4. Return honest empty output when history or coverage is insufficient.
5. Fixture mode performs no vendor calls and must remain the default.
6. Licensed mode stays fail-closed until rights-approved live adapters,
   persistent tenancy, and persistent metering are configured.
7. No secrets, client branding, customer data, production URLs, cookie jars, or
   production deployment configuration may enter this repository.
8. No multi-tenant claim until every persistent row is tenant-scoped and
   protected by RLS, with cross-tenant tests passing.
9. Do not add an eleventh MCP tool unless it cannot be expressed as a parameter
   on an existing tool.
10. Both transports enforce the same gates. The HTTP surface requires an API key
    for all tool traffic, never serves tools anonymously, and must never become a
    way to bypass plan gating or the licensed-mode gate.
11. Do not describe hosted metering or tenancy as production-ready. Metering is
    per-instance and tenancy is in-memory until both are moved to Postgres.

Run `npm run verify` before proposing or committing a change.

