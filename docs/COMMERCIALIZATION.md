# Commercialization gates

## Product sequence

### Model A: licensed single-customer deployment

Ship the engine into each customer's environment. The customer supplies and
controls its own data-provider accounts and keys. Nevodia licenses the tool
surface, fragrance taxonomy, provenance guard, analysis logic, deployment, and
support. This is the recommended first revenue model.

### Model B: hosted API plus MCP

Build REST entitlements, billing, durable metering, and a remote MCP transport
over the same core. This model may serve or redistribute data only where the
source terms or a negotiated agreement explicitly permit that use.

## Release gates

| Gate | Fixture evaluation | Model A | Model B |
|---|---:|---:|---:|
| IP assignment/licence documented | recommended | required | required |
| Source/vendor rights inventory | disclose fixtures | required per customer use | required for redistribution |
| Rights-approved SourceRegistry | no | required | required |
| Customer-owned provider keys | no | required | optional |
| Persistent tenant/key store | no | per deployment | required |
| Persistent atomic usage meter | no | required | required |
| Tenant columns + RLS | no | isolated deployment | required |
| Daily historical snapshots | optional | required for longitudinal tools | required |
| Billing and entitlements | no | contract may suffice | required |
| Security review and penetration test | no | required | required |

## Initial commercial scope

Expose the existing ten tools. For the first licensed release, prioritize:

1. `get_trending_fragrances`
2. `get_trending_ingredients`
3. `detect_emerging_trends`
4. `search_fragrance_intelligence`

Keep velocity and lifecycle tools coverage-aware until sufficient daily history
exists. Keep report output structured; rendering belongs to the client.

## Data-rights policy

Maintain a machine-readable inventory for every source with: owner, collection
method, contract/terms version, permitted purposes, redistribution status,
retention, geography, attribution, deletion obligations, and review date.

No source enters a live registry while its redistribution/use status is
`unknown`. A provider key being technically valid is not evidence of permission.

## Metering requirement

The in-memory proof-of-concept meter is suitable only for evaluation. Production
must atomically reserve budget before a tool runs, settle actual usage after the
call, expire abandoned reservations, and persist an auditable per-tenant usage
ledger. Concurrent calls must not overspend a tenant's budget.

## Definition of commercially ready

A release is commercially ready only when its deployment mode's gates above are
met, `npm run verify` passes, source freshness and coverage are disclosed in every
response, and sales material accurately distinguishes measured, derived, and
qualitative outputs.

