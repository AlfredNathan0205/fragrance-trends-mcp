# Security

Report suspected vulnerabilities privately to the repository owner. Do not
open a public issue containing secrets, customer identifiers, source payloads,
or exploit details.

## Security boundaries

- Fixture mode is the default and makes no external vendor calls.
- Licensed mode fails closed until an approved live source registry and
  persistent tenant/meter stores are configured.
- API keys must be hashed at rest. Raw keys and vendor credentials must never
  be committed or logged.
- Every production record must be tenant-scoped and protected by row-level
  security before shared multi-tenant hosting is enabled.
- Every response passes through the provenance and integrity guard.
- Generative model output may not originate numeric market metrics.

## Before production

Complete threat modelling, dependency review, key rotation procedures,
rate-limit/load testing, audit-log retention, incident response, backup/restore
testing, and an external penetration test.

