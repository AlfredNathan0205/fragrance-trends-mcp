/**
 * End-to-end smoke test.
 *
 * Exercises: tool listing, envelope construction, the integrity guard (both
 * pass and deliberate-failure paths), plan-gated tool access, and budget
 * exhaustion. Runs entirely on fixture data — no keys, no vendor spend.
 */

import {
  auditPayload,
  createFixtureRegistry,
  executeTool,
  fixtureMeta,
  TOOLS,
  ToolExecutionError,
  type ToolContext,
} from '@ftm/core';
import { TenantStore, UsageMeter } from '@ftm/api';
import { randomUUID } from 'node:crypto';

const tenants = new TenantStore();
const meter = new UsageMeter(tenants);
const { tenant: ent } = tenants.create('Acme Fragrance Co', 'enterprise');
const { tenant: evalTenant } = tenants.create('Trial User', 'evaluation');

const sources = createFixtureRegistry();

function ctx(tenantId: string): ToolContext {
  return {
    sources,
    tenantId,
    requestId: randomUUID(),
    licensedMode: true,
    allowVendorCalls: false,
  };
}

function line(s = '') {
  process.stdout.write(`${s}\n`);
}

async function main() {
  line('='.repeat(72));
  line('FRAGRANCE TRENDS MCP — proof of concept');
  line('='.repeat(72));
  line(`Fixture provenance: Apify snapshot ${fixtureMeta.apifyObservedAt}`);
  line(`                    trending list  ${fixtureMeta.trendingObservedAt}`);
  line();

  line(`TOOL SURFACE (${TOOLS.length} tools)`);
  line('-'.repeat(72));
  for (const t of TOOLS) {
    line(`  ${t.name.padEnd(32)} ${t.costClass.padEnd(8)} ttl=${String(Math.round(t.ttlSeconds / 3600)).padStart(3)}h`);
  }
  line();

  // ---- 1. A measured tool, full envelope --------------------------------
  line('1. get_trending_fragrances (measured path)');
  line('-'.repeat(72));
  const env = await executeTool({
    tool: 'get_trending_fragrances',
    args: { limit: 5, segment: 'all' },
    ctx: ctx(ent.id),
    meter,
  });
  const rows = env.data as Array<Record<string, unknown>>;
  for (const r of rows) {
    line(
      `  #${r['rank']} ${String(r['hashtag']).padEnd(24)} views=${String(r['totalViews']).padStart(9)} growth=${String(r['growth']).padStart(5)}%  ${r['momentum']}`,
    );
  }
  line();
  line('  provenance:');
  line(`    source      ${env.provenance.sources[0]?.id} (${env.provenance.sources[0]?.kind})`);
  line(`    observedAt  ${env.provenance.sources[0]?.observedAt}`);
  line(`    staleness   ${env.provenance.cache.staleness} (age ${Math.round(env.provenance.cache.ageSeconds / 86400)}d, ttl ${env.provenance.cache.ttlSeconds / 3600}h)`);
  line(`    modelRole   ${env.provenance.integrity.modelRole}`);
  line(`    numerics    ${env.provenance.integrity.numericOrigin}, guard ${env.provenance.integrity.guard}`);
  line(`    coverage    ${env.provenance.coverage.returned}/${env.provenance.coverage.requested}${env.provenance.coverage.partial ? ' (partial)' : ''}`);
  for (const o of env.provenance.coverage.omissions ?? []) line(`      - ${o}`);
  line(`    cost        ${env.meta.costUnits} units, ${env.meta.durationMs}ms`);
  line();

  // ---- 2. Honest emptiness ----------------------------------------------
  line('2. analyze_trend_velocity (no history — must refuse, not fabricate)');
  line('-'.repeat(72));
  const vel = await executeTool({
    tool: 'analyze_trend_velocity',
    args: { limit: 3 },
    ctx: ctx(ent.id),
    meter,
  });
  line(`  rows returned: ${(vel.data as unknown[]).length}`);
  for (const o of (vel.provenance.coverage.omissions ?? []).slice(0, 3)) line(`    - ${o}`);
  line();

  // ---- 3. Emerging signals ----------------------------------------------
  line('3. detect_emerging_trends (measured leading indicator)');
  line('-'.repeat(72));
  const emg = await executeTool({
    tool: 'detect_emerging_trends',
    args: { limit: 4 },
    ctx: ctx(ent.id),
    meter,
  });
  for (const s of emg.data as Array<Record<string, unknown>>) {
    line(`  ${String(s['name']).padEnd(22)} ${String(s['momentum']).padEnd(10)} ${s['evidence']}`);
  }
  line();

  // ---- 4. Guard catches a fabricated-looking payload ---------------------
  line('4. Integrity guard vs. known fabrication signatures');
  line('-'.repeat(72));
  const poisoned = [
    { tag: 'a', views: 100_000, likes: 6000, growth: 0 },
    { tag: 'b', views: 200_000, likes: 12_000, growth: 0 },
    { tag: 'c', views: 300_000, likes: 18_000, growth: 0 },
    { tag: 'd', views: 400_000, likes: 24_000, growth: 0 },
    { tag: 'e', views: 500_000, likes: 30_000, growth: 0 },
  ];
  const findings = auditPayload(poisoned, {
    modelRole: 'none',
    declaredNumericOrigin: 'measured',
  });
  for (const f of findings) {
    line(`  [${f.severity.toUpperCase()}] ${f.code}${f.field ? ` (${f.field})` : ''}`);
    line(`         ${f.detail}`);
  }
  line();

  // ---- 4b. Guard run against the REAL production snapshot ---------------
  line('4b. Guard vs. the actual production snapshot (all 42 tracked hashtags)');
  line('-'.repeat(72));
  const full = await executeTool({
    tool: 'get_trending_fragrances',
    args: { limit: 50 },
    ctx: ctx(ent.id),
    meter,
  });
  const realNotes = full.provenance.integrity.notes ?? [];
  if (realNotes.length === 0) {
    line('  no integrity findings');
  }
  for (const n of realNotes) line(`  ${n}`);
  line();

  // ---- 5. Plan gating ----------------------------------------------------
  line('5. Plan gating — evaluation tier calling a heavy tool');
  line('-'.repeat(72));
  try {
    await executeTool({
      tool: 'generate_trend_report',
      args: { focus: 'gourmand' },
      ctx: ctx(evalTenant.id),
      meter,
    });
    line('  UNEXPECTED: call succeeded');
  } catch (err) {
    const e = err as ToolExecutionError;
    line(`  blocked [${e.code}]: ${e.message}`);
  }
  line();

  // ---- 6. Budget exhaustion ---------------------------------------------
  line('6. Budget enforcement — draining the evaluation allowance');
  line('-'.repeat(72));
  let calls = 0;
  let stopped = '';
  for (let i = 0; i < 800; i++) {
    try {
      await executeTool({
        tool: 'get_trending_fragrances',
        args: { limit: 1 },
        ctx: ctx(evalTenant.id),
        meter,
      });
      calls++;
    } catch (err) {
      stopped = (err as ToolExecutionError).message;
      break;
    }
  }
  line(`  ${calls} calls authorised, then stopped:`);
  line(`  ${stopped}`);
  const st = meter.statement(evalTenant.id);
  line(`  statement: ${st.unitsUsed}/${st.unitsLimit} units (${st.utilisation}%)`);
  for (const t of st.byTool) line(`    ${t.tool.padEnd(28)} ${t.calls} calls, ${t.units} units`);
  line();

  line('='.repeat(72));
  line('All paths exercised.');
  line('='.repeat(72));
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
