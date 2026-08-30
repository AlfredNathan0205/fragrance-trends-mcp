/**
 * Streamable HTTP transport — the hosted delivery surface.
 *
 * The stdio entrypoint is how a single developer runs this locally. This is how
 * a licensee consumes it remotely: one URL, one API key, per-tenant metering.
 *
 * Written against Web Standard `Request`/`Response` so the same handler runs on
 * Vercel, Cloudflare Workers, Deno or a plain Node server. `createNodeRequestListener`
 * adapts it to Node's `(req, res)` signature for serverless platforms.
 *
 * Three properties are deliberate and must survive refactoring:
 *
 *   1. No anonymous access to tools. A request without a recognised key gets 401.
 *   2. Licensed mode still fails closed here, exactly as it does over stdio.
 *      Exposing an HTTP endpoint must never become a way to skip that gate.
 *   3. Metering state is per-instance and therefore NOT authoritative on
 *      serverless. It is a guard rail against runaway vendor spend inside one
 *      instance, not a billing ledger. Durable metering needs Postgres — see
 *      docs/HOSTING.md. This is stated in the status payload so nobody deploys
 *      it believing otherwise.
 */

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { PLANS, TenantStore, UnauthorizedTenant, UsageMeter, type PlanTier } from '@ftm/api';
import { TOOLS } from '@ftm/core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createMcpServer } from './server.js';

const SERVER_VERSION = '0.2.0';
const TIERS: readonly PlanTier[] = ['evaluation', 'standard', 'enterprise'];

/** Hop-by-hop and length headers must not be replayed onto a Web `Request`. */
const DROPPED_REQUEST_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'content-length',
  'host',
]);

export type Env = Record<string, string | undefined>;

export interface HttpMcpOptions {
  /** Defaults to `process.env`. Injectable so tests never mutate real env. */
  env?: Env;
}

export interface TenantSeed {
  name: string;
  tier: PlanTier;
  key: string;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/**
 * Reads licensee keys from the environment.
 *
 * `FTM_HTTP_TENANTS` is the general form:
 *   [{"name":"acme","tier":"standard","key":"ftm_..."}]
 *
 * `FTM_EVALUATION_KEY` is shorthand for a single evaluation-tier licensee,
 * which is the common case when handing an endpoint to a prospect.
 *
 * Keys are hashed on load; the plaintext is never retained.
 */
export function readTenantSeeds(env: Env): TenantSeed[] {
  const seeds: TenantSeed[] = [];
  const raw = env['FTM_HTTP_TENANTS'];

  if (raw && raw.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ConfigurationError('FTM_HTTP_TENANTS must be valid JSON.');
    }
    if (!Array.isArray(parsed)) {
      throw new ConfigurationError('FTM_HTTP_TENANTS must be a JSON array of tenant objects.');
    }
    parsed.forEach((entry, i) => {
      const e = entry as Partial<TenantSeed>;
      if (typeof e?.key !== 'string' || e.key.trim() === '') {
        throw new ConfigurationError(`FTM_HTTP_TENANTS[${i}] is missing a non-empty "key".`);
      }
      if (typeof e.tier !== 'string' || !TIERS.includes(e.tier as PlanTier)) {
        throw new ConfigurationError(
          `FTM_HTTP_TENANTS[${i}].tier must be one of ${TIERS.join(', ')}.`,
        );
      }
      seeds.push({
        name: typeof e.name === 'string' && e.name.trim() !== '' ? e.name : `tenant-${i + 1}`,
        tier: e.tier as PlanTier,
        key: e.key,
      });
    });
  }

  const evaluationKey = env['FTM_EVALUATION_KEY'];
  if (evaluationKey && evaluationKey.trim() !== '') {
    seeds.push({ name: 'evaluation', tier: 'evaluation', key: evaluationKey });
  }

  return seeds;
}

interface Provisioned {
  tenants: TenantStore;
  meter: UsageMeter;
  seeded: number;
}

function provision(env: Env): Provisioned {
  const tenants = new TenantStore();
  const meter = new UsageMeter(tenants);
  for (const seed of readTenantSeeds(env)) {
    tenants.register(seed.name, seed.tier, seed.key);
  }
  return { tenants, meter, seeded: tenants.list().length };
}

function json(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(), ...extraHeaders },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers':
      'authorization, content-type, x-api-key, mcp-session-id, mcp-protocol-version, last-event-id',
    'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version',
  };
}

function bearerKey(request: Request): string | undefined {
  const auth = request.headers.get('authorization');
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1]) return match[1].trim();
  }
  const direct = request.headers.get('x-api-key');
  return direct?.trim() || undefined;
}

function wantsEventStream(request: Request): boolean {
  return (request.headers.get('accept') ?? '').includes('text/event-stream');
}

/**
 * Builds the HTTP handler. Returns a function of `Request -> Response`.
 *
 * Provisioning happens once per instance, so warm invocations share the meter
 * and rate limiter. Cold starts reset it — see the durability caveat above.
 */
export function createHttpMcpHandler(options: HttpMcpOptions = {}) {
  const env = options.env ?? process.env;
  const mode = env['FTM_MODE'] ?? 'fixture';

  let state: Provisioned | undefined;
  let configError: string | undefined;

  if (mode !== 'fixture' && mode !== 'licensed') {
    configError = 'FTM_MODE must be either "fixture" or "licensed".';
  } else {
    try {
      state = provision(env);
    } catch (err) {
      configError = err instanceof Error ? err.message : String(err);
    }
  }

  function status(): Response {
    return json(
      {
        name: 'fragrance-trends-mcp',
        version: SERVER_VERSION,
        transport: 'streamable-http',
        protocol: 'Model Context Protocol',
        mode,
        endpoint: '/api/mcp',
        tools: TOOLS.length,
        authentication: 'Authorization: Bearer <api key>',
        tenantsProvisioned: state?.seeded ?? 0,
        configurationError: configError ?? null,
        caveats: {
          data:
            mode === 'fixture'
              ? 'Fixture snapshots only. Responses are dated and must not be represented as live.'
              : 'Licensed mode is gated and returns 503 until rights-approved adapters are wired.',
          metering:
            'Per-instance and non-authoritative on serverless. A spend guard rail, not a billing ledger.',
          tenancy: 'In-memory tenant store. Postgres row-level isolation is required before production.',
        },
      },
      configError ? 500 : 200,
    );
  }

  return async function handle(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // A browser hitting the endpoint should get an explanation, not a stack
    // trace. MCP clients asking for an SSE stream fall through to the transport.
    if (request.method === 'GET' && !wantsEventStream(request)) {
      return status();
    }

    if (configError || !state) {
      return json(
        { error: 'server_misconfigured', message: configError ?? 'Server is not configured.' },
        500,
      );
    }

    // Same gate as stdio. An HTTP surface must not become a bypass.
    if (mode === 'licensed') {
      return json(
        {
          error: 'licensed_mode_disabled',
          message:
            'Licensed mode is intentionally disabled: configure a rights-approved live SourceRegistry, ' +
            'Postgres tenant store, and persistent usage meter before enabling vendor calls.',
        },
        503,
      );
    }

    if (state.seeded === 0) {
      return json(
        {
          error: 'not_provisioned',
          message:
            'No licensee keys are configured. Set FTM_EVALUATION_KEY or FTM_HTTP_TENANTS before serving tool traffic.',
        },
        503,
      );
    }

    const key = bearerKey(request);
    if (!key) {
      return json(
        {
          error: 'unauthorized',
          message: 'Provide an API key via the Authorization: Bearer header.',
        },
        401,
        { 'www-authenticate': 'Bearer realm="fragrance-trends-mcp"' },
      );
    }

    let tenantId: string;
    try {
      tenantId = state.tenants.authenticate(key).id;
    } catch (err) {
      if (err instanceof UnauthorizedTenant) {
        return json({ error: 'unauthorized', message: err.message }, 401, {
          'www-authenticate': 'Bearer realm="fragrance-trends-mcp"',
        });
      }
      throw err;
    }

    const server = createMcpServer({
      tenantId,
      meter: state.meter,
      allowVendorCalls: false,
      licensedMode: false,
    });

    // Stateless: no session affinity, because serverless instances are not
    // sticky. Buffered JSON responses rather than SSE for the same reason.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      const raw = await transport.handleRequest(request);
      const body = await raw.text();
      const headers = new Headers(raw.headers);
      for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
      return new Response(body.length > 0 ? body : null, { status: raw.status, headers });
    } finally {
      await server.close().catch(() => undefined);
    }
  };
}

export type FetchHandler = (request: Request) => Promise<Response>;

/**
 * Adapts a Web-standard handler to Node's `(req, res)` signature, which is what
 * Vercel Node functions and a plain `http.createServer` both expect.
 */
export function createNodeRequestListener(handler: FetchHandler) {
  return async function listener(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      }
      const body = Buffer.concat(chunks);

      const forwardedProto = req.headers['x-forwarded-proto'];
      const proto =
        (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(',')[0] ??
        'http';
      const host = req.headers.host ?? 'localhost';
      const url = new URL(req.url ?? '/', `${proto}://${host}`);

      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined || DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
        if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
        else headers.set(name, value);
      }

      const method = req.method ?? 'GET';
      const init: RequestInit = { method, headers };
      if (method !== 'GET' && method !== 'HEAD' && body.length > 0) {
        init.body = body;
      }

      const response = await handler(new Request(url, init));
      res.statusCode = response.status;
      response.headers.forEach((value, name) => res.setHeader(name, value));
      const text = await response.text();
      res.end(text.length > 0 ? text : undefined);
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json; charset=utf-8');
      }
      res.end(
        JSON.stringify({
          error: 'internal',
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  };
}

export { PLANS };
