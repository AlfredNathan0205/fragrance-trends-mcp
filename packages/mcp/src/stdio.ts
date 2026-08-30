#!/usr/bin/env node
/**
 * stdio entrypoint — what Claude Desktop, Cursor, and Claude Code connect to.
 *
 *   {
 *     "mcpServers": {
 *       "fragrance-trends": {
 *         "command": "npx",
 *         "args": ["-y", "@ftm/mcp"],
 *         "env": { "FTM_API_KEY": "ftm_..." }
 *       }
 *     }
 *   }
 *
 * Default mode is fixture: captured snapshots, no vendor spend.
 *
 * Licensed mode deliberately fails closed in this repository until a
 * rights-approved SourceRegistry and persistent tenant/meter stores are wired.
 * An API key alone must never turn fixture data into a product represented as
 * live, nor authorise unreviewed vendor redistribution.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PLANS, TenantStore, UsageMeter } from '@ftm/api';
import { createMcpServer } from './server.js';

async function main() {
  const mode = process.env['FTM_MODE'] ?? 'fixture';
  const apiKey = process.env['FTM_API_KEY'];
  const tenants = new TenantStore();
  const meter = new UsageMeter(tenants);

  if (mode !== 'fixture' && mode !== 'licensed') {
    throw new Error('FTM_MODE must be either "fixture" or "licensed".');
  }

  if (mode === 'licensed') {
    if (!apiKey) {
      throw new Error('FTM_API_KEY is required when FTM_MODE=licensed.');
    }
    throw new Error(
      'Licensed mode is intentionally disabled: configure a rights-approved live SourceRegistry, ' +
        'Postgres tenant store, and persistent usage meter before enabling vendor calls.',
    );
  }

  const { tenant } = tenants.create('evaluation', 'evaluation');
  process.stderr.write(
    `[ftm] fixture mode; tier=${tenant.tier}; budget=${PLANS.evaluation.monthlyCostUnits} units/30d; vendor calls disabled.\n`,
  );

  const server = createMcpServer({
    tenantId: tenant.id,
    meter,
    allowVendorCalls: false,
    licensedMode: false,
  });
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`[ftm] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
