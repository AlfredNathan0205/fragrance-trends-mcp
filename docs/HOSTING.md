# Hosting the HTTP transport

## Two transports, one server

| Transport | Entrypoint | Who uses it |
|---|---|---|
| stdio | `packages/mcp/src/stdio.ts` | A developer running the server locally as a subprocess of Claude Desktop, Cursor or Claude Code |
| Streamable HTTP | `packages/mcp/src/http.ts` via `api/mcp.mjs` | A remote licensee pointing an MCP client at a URL with an API key |

Both call the same `createMcpServer` and the same execution pipeline. There is no
second implementation of the tools, the provenance envelope or the integrity guard.

**A stdio server cannot be deployed to a serverless platform.** It speaks JSON-RPC
over standard input and output and never binds a port, so any HTTP request to it
fails at invocation. That is what `api/mcp.mjs` exists to solve, and what
`npm run http:check` exists to prevent regressing.

## Local run

```bash
npm run build
npm run mcp:http      # prints the endpoint and a minted API key
```

```bash
curl -s http://localhost:8787/api/mcp | head -20                  # status document
curl -s -X POST http://localhost:8787/api/mcp \
  -H "authorization: Bearer $FTM_EVALUATION_KEY" \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Deploying to Vercel

`vercel.json` sets the build command, serves `public/` as the static root, and
exposes the function at `/api/mcp` with `/mcp` rewritten to it. The function is
plain JavaScript importing compiled output, so the platform never needs to
resolve the monorepo's TypeScript project references.

Required environment variables:

| Variable | Required | Purpose |
|---|---|---|
| `FTM_MODE` | no | `fixture` (default) or `licensed`. Licensed returns 503 by design. |
| `FTM_EVALUATION_KEY` | one of these | Shorthand: provisions a single evaluation-tier licensee. |
| `FTM_HTTP_TENANTS` | one of these | JSON array: `[{"name":"acme","tier":"standard","key":"ftm_..."}]` |

With neither key variable set, tool traffic returns `503 not_provisioned`. This is
deliberate — an unprovisioned deployment must not serve tools anonymously.

Two **project-level** settings cannot be expressed in `vercel.json` and must be
checked on first import, because Vercel's auto-detection gets both wrong on a
monorepo of this shape:

| Setting | Required value | What happens otherwise |
|---|---|---|
| Root Directory | `./` | Auto-set to `packages/mcp`, where no `build` script exists |
| Framework Preset | `Other` | Auto-detected as `Node`, which ignores `outputDirectory` |

Generate a key with `node -e "import('@ftm/api').then(m=>console.log(m.mintKey()))"`.
Only the SHA-256 hash is retained at runtime; the plaintext exists solely in the
platform's environment configuration.

## Client configuration

```json
{
  "mcpServers": {
    "fragrance-trends": {
      "url": "https://<deployment-host>/api/mcp",
      "headers": { "Authorization": "Bearer ftm_..." }
    }
  }
}
```

## Troubleshooting

**`npm error Missing script: "build"` / `workspace @ftm/mcp` / `location /vercel/path0/packages/mcp`**
Root Directory is pointing at a workspace package instead of the repository root.
The `build` script is defined once, at the root, because it drives `tsc -b` across
all three project references. Set Root Directory to `./`.

**`Error: No entrypoint found in "/vercel/path0"` listing `index.js`, `server.js`, `app.js` …**
The project is being treated as a standalone Node server. It is not one — it is a
static root plus a function in `api/`. `vercel.json` now pins `"framework": null`,
but if the project was imported before that, set Framework Preset to `Other`.

**`503 not_provisioned` from a successful deployment**
The build is fine; no licensee key is configured. Set `FTM_EVALUATION_KEY` or
`FTM_HTTP_TENANTS`, then redeploy so the new environment reaches the function.

**`503 licensed_mode_disabled`**
Working as designed. `FTM_MODE=licensed` is gated until rights-approved adapters
and persistent stores exist. Use `fixture`.

**`401 unauthorized`**
The key is missing, malformed, or not one of the provisioned keys. Note that
changing an environment variable requires a redeploy — the function reads keys at
cold start.

## What this deployment is not

Three limits are real and are reported in the `GET /api/mcp` status payload rather
than hidden:

1. **Metering is per-instance, not a billing ledger.** `UsageMeter` holds state in
   memory. Serverless instances are neither sticky nor singular, so a licensee
   spread across ten warm instances gets roughly ten times the intended rate limit,
   and a cold start resets the window. It is a guard rail against runaway vendor
   spend inside one instance. Durable enforcement needs the usage counters in
   Postgres with atomic pre-authorisation.
2. **Tenancy is in-memory.** Keys are provisioned from environment variables at
   cold start. Adding, suspending or re-tiering a licensee currently means a
   redeploy. Real deployment needs a tenant table and row-level scoping.
3. **Data is dated fixture snapshots, not live.** Fixture provenance is stamped
   into every response. Nothing here should be represented to a customer as
   realtime.

## Statelessness

The transport runs with `sessionIdGenerator: undefined` and `enableJsonResponse: true`:
no session affinity, buffered JSON rather than SSE streams. Serverless instances
are not sticky, so a session created on one instance would not be found on the
next. Server-initiated notifications and resumable streams are therefore not
available over HTTP; they are available over stdio. If long-running streamed tool
output becomes a requirement, that needs a persistent host rather than functions.

## Order of work before a licensee connects

1. Data resale rights cleared for every upstream source.
2. IP ownership settled in writing.
3. Postgres tenant store with row-level isolation, replacing the in-memory store.
4. Durable usage counters with atomic pre-authorisation.
5. Rights-approved live `SourceRegistry`, at which point `FTM_MODE=licensed`
   becomes meaningful and the fail-closed gate in both transports can be lifted.
