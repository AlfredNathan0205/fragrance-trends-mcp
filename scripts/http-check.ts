/**
 * HTTP transport conformance check.
 *
 * Boots the real handler on a loopback port and drives it with the official MCP
 * client over Streamable HTTP. This is the test that would have caught the
 * original failure: deploying a stdio-only server to an HTTP platform.
 *
 * Asserted:
 *   1. GET returns a status document rather than crashing.
 *   2. POST without a key is rejected 401 — no anonymous tool access.
 *   3. POST with a bad key is rejected 401.
 *   4. A valid key completes the MCP handshake and lists all ten tools.
 *   5. A tool call returns a provenance envelope with measured numerics.
 *   6. Plan gating still applies over HTTP (heavy tool blocked on evaluation).
 *   7. Licensed mode fails closed over HTTP exactly as it does over stdio.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpMcpHandler, createNodeRequestListener } from '../packages/mcp/src/http.js';

const API_KEY = 'ftm_local_conformance_key';

function fail(message: string): never {
  console.error(`\nHTTP conformance check FAILED: ${message}\n`);
  process.exit(1);
}

function assert(condition: unknown, message: string): void {
  if (!condition) fail(message);
}

async function listen(env: Record<string, string | undefined>): Promise<{
  server: HttpServer;
  url: string;
}> {
  const server = createServer(createNodeRequestListener(createHttpMcpHandler({ env })));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/api/mcp` };
}

function close(server: HttpServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function firstTextPayload(result: unknown): Record<string, unknown> {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  const text = content.find((c) => c.type === 'text')?.text;
  assert(text, 'Tool result contained no text content.');
  return JSON.parse(text as string) as Record<string, unknown>;
}

async function main(): Promise<void> {
  console.log('Fragrance Trends MCP — HTTP transport conformance\n');

  const fixture = await listen({ FTM_MODE: 'fixture', FTM_EVALUATION_KEY: API_KEY });

  try {
    // 1. Browser-style GET must explain itself, not fail.
    const statusRes = await fetch(fixture.url);
    assert(statusRes.status === 200, `GET status expected 200, got ${statusRes.status}.`);
    const status = (await statusRes.json()) as Record<string, unknown>;
    assert(status['transport'] === 'streamable-http', 'Status did not advertise streamable-http.');
    assert(status['tenantsProvisioned'] === 1, 'Status did not report the provisioned tenant.');
    console.log(
      `  GET status ....... 200  mode=${String(status['mode'])} tools=${String(status['tools'])}`,
    );

    // 2 & 3. Authentication is mandatory.
    for (const [label, headers] of [
      ['no key', {}],
      ['bad key', { authorization: 'Bearer ftm_not_a_real_key' }],
    ] as [string, Record<string, string>][]) {
      const res = await fetch(fixture.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      assert(res.status === 401, `POST with ${label} expected 401, got ${res.status}.`);
      console.log(`  POST ${label.padEnd(8)} ... 401  rejected`);
    }

    // 4. Real handshake through the official client.
    const client = new Client({ name: 'ftm-http-check', version: '0.2.0' });
    const transport = new StreamableHTTPClientTransport(new URL(fixture.url), {
      requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } },
    });
    await client.connect(transport);

    const { tools } = await client.listTools();
    assert(tools.length === 10, `Expected 10 tools over HTTP, got ${tools.length}.`);
    console.log(`\n  Handshake OK. ${tools.length} tools advertised over HTTP.`);

    // 5. Provenance survives the transport change.
    const called = await client.callTool({
      name: 'get_trending_ingredients',
      arguments: { limit: 3 },
    });
    assert(!(called as { isError?: boolean }).isError, 'Licensed tool call unexpectedly errored.');
    const envelope = firstTextPayload(called);
    const provenance = envelope['provenance'] as Record<string, unknown> | undefined;
    const integrity = provenance?.['integrity'] as Record<string, unknown> | undefined;
    assert(provenance, 'Response envelope carried no provenance block.');
    assert(
      integrity?.['numericOrigin'] === 'measured',
      `Expected measured numerics, got ${String(integrity?.['numericOrigin'])}.`,
    );
    assert(integrity?.['modelRole'] === 'none', 'Fixture path should declare no model role.');
    const meta = envelope['meta'] as Record<string, unknown> | undefined;
    console.log(
      `  Tool call OK. numerics=${String(integrity?.['numericOrigin'])} guard=${String(integrity?.['guard'])} cost=${String(meta?.['costUnits'])} unit(s)`,
    );

    // 6. Commercial gating is transport-independent.
    const gated = await client.callTool({
      name: 'generate_trend_report',
      arguments: { focus: 'oud' },
    });
    assert((gated as { isError?: boolean }).isError, 'Heavy tool should be blocked on evaluation.');
    const gatedPayload = firstTextPayload(gated);
    assert(
      gatedPayload['error'] === 'quota',
      `Expected a quota error, got ${String(gatedPayload['error'])}.`,
    );
    console.log(`  Plan gating OK. ${String(gatedPayload['message'])}`);

    await client.close();
  } finally {
    await close(fixture.server);
  }

  // 7. Licensed mode must not be reachable over HTTP either.
  const licensed = await listen({
    FTM_MODE: 'licensed',
    FTM_API_KEY: 'ftm_boundary_only',
    FTM_EVALUATION_KEY: API_KEY,
  });
  try {
    const res = await fetch(licensed.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert(res.status === 503, `Licensed mode expected 503, got ${res.status}.`);
    const body = (await res.json()) as Record<string, unknown>;
    assert(
      body['error'] === 'licensed_mode_disabled',
      'Licensed mode returned the wrong error code.',
    );
    console.log('  Licensed mode ..... 503  fails closed over HTTP');
  } finally {
    await close(licensed.server);
  }

  console.log('\nHTTP conformance check passed.');
}

main().catch((err) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
