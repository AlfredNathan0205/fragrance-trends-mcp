/**
 * Protocol conformance check: spawns the stdio server as a real MCP client
 * would, lists tools, and calls one. Verifies the wire format, not just the
 * internal pipeline.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function main() {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'packages/mcp/src/stdio.ts'],
    cwd: process.cwd(),
  });

  const client = new Client({ name: 'conformance-check', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const { tools } = await client.listTools();
  process.stdout.write(`Handshake OK. Server advertises ${tools.length} tools.\n\n`);
  for (const t of tools) {
    const required = (t.inputSchema as { required?: string[] }).required ?? [];
    const props = Object.keys((t.inputSchema as { properties?: object }).properties ?? {});
    process.stdout.write(
      `  ${t.name}\n    params: ${props.join(', ') || '(none)'}${required.length ? `  required: ${required.join(', ')}` : ''}\n`,
    );
  }

  process.stdout.write('\nCalling get_trending_ingredients(limit=3)...\n');
  const res = await client.callTool({
    name: 'get_trending_ingredients',
    arguments: { limit: 3 },
  });
  const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
  const env = JSON.parse(text);
  for (const r of env.data) {
    process.stdout.write(
      `  ${String(r.entity).padEnd(18)} ${String(r.category ?? 'uncategorised').padEnd(12)} views=${r.totalViews}\n`,
    );
  }
  process.stdout.write(
    `\n  integrity: modelRole=${env.provenance.integrity.modelRole} numerics=${env.provenance.integrity.numericOrigin} guard=${env.provenance.integrity.guard}\n`,
  );
  process.stdout.write(`  cache: ${env.provenance.cache.staleness}, cost ${env.meta.costUnits} unit(s)\n`);

  process.stdout.write('\nCalling an unlicensed/invalid input to check error shape...\n');
  const bad = await client.callTool({
    name: 'predict_trend_lifecycle',
    arguments: {},
  });
  process.stdout.write(`  isError=${bad.isError} -> ${(bad.content as Array<{ text: string }>)[0]!.text.replace(/\s+/g, ' ').slice(0, 140)}\n`);

  await client.close();
  process.stdout.write('\nConformance check passed.\n');
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
