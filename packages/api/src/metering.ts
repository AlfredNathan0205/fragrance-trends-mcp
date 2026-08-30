/**
 * Metering and budget enforcement.
 *
 * The commercial risk in a licensed MCP is not piracy, it is an enthusiastic
 * licensee wiring `generate_trend_report` into a loop. Each heavy call fans out
 * to paid scrape and model APIs. Unmetered, one customer can spend more than
 * their annual licence fee in an afternoon, and the bill arrives here.
 *
 * So: authorise before the vendor call, not after.
 */

import type { Meter } from '@ftm/core';
import { ToolNotLicensed, type Tenant, type TenantStore } from './tenancy.js';

export class QuotaExceeded extends Error {
  constructor(
    message: string,
    public readonly kind: 'rate' | 'budget',
  ) {
    super(message);
    this.name = 'QuotaExceeded';
  }
}

interface Usage {
  /** Cost units consumed in the current 30-day window. */
  windowUnits: number;
  windowStart: number;
  /** Timestamps of recent calls, for the per-minute limiter. */
  recentCalls: number[];
  byTool: Map<string, { calls: number; units: number }>;
}

const WINDOW_MS = 30 * 24 * 3600 * 1000;

export class UsageMeter implements Meter {
  private usage = new Map<string, Usage>();

  constructor(private readonly tenants: TenantStore) {}

  private get(tenantId: string): Usage {
    let u = this.usage.get(tenantId);
    if (!u) {
      u = { windowUnits: 0, windowStart: Date.now(), recentCalls: [], byTool: new Map() };
      this.usage.set(tenantId, u);
    }
    if (Date.now() - u.windowStart > WINDOW_MS) {
      u.windowUnits = 0;
      u.windowStart = Date.now();
      u.byTool.clear();
    }
    return u;
  }

  private tenant(tenantId: string): Tenant {
    const t = this.tenants.list().find((x) => x.id === tenantId);
    if (!t) throw new QuotaExceeded(`Unknown tenant ${tenantId}.`, 'budget');
    return t;
  }

  async authorise(tenantId: string, tool: string, costUnits: number): Promise<void> {
    const tenant = this.tenant(tenantId);
    const u = this.get(tenantId);

    const allowed = tenant.quota.allowedTools;
    if (allowed.length > 0 && !allowed.includes(tool)) {
      throw new ToolNotLicensed(tool, tenant.tier);
    }

    const cutoff = Date.now() - 60_000;
    u.recentCalls = u.recentCalls.filter((t) => t > cutoff);
    if (u.recentCalls.length >= tenant.quota.callsPerMinute) {
      throw new QuotaExceeded(
        `Rate limit: ${tenant.quota.callsPerMinute} calls/minute for the ${tenant.tier} plan.`,
        'rate',
      );
    }

    // Pre-authorise the full cost. Refusing before the vendor call is the point.
    if (u.windowUnits + costUnits > tenant.quota.monthlyCostUnits) {
      throw new QuotaExceeded(
        `Budget exhausted: ${u.windowUnits}/${tenant.quota.monthlyCostUnits} cost units used this window; "${tool}" needs ${costUnits}.`,
        'budget',
      );
    }
  }

  async record(
    tenantId: string,
    tool: string,
    costUnits: number,
    _durationMs: number,
  ): Promise<void> {
    const u = this.get(tenantId);
    u.windowUnits += costUnits;
    u.recentCalls.push(Date.now());
    const t = u.byTool.get(tool) ?? { calls: 0, units: 0 };
    t.calls += 1;
    t.units += costUnits;
    u.byTool.set(tool, t);
  }

  /** Per-tenant statement. Drives invoicing and the "you're at 80%" email. */
  statement(tenantId: string) {
    const tenant = this.tenant(tenantId);
    const u = this.get(tenantId);
    return {
      tenant: tenant.name,
      tier: tenant.tier,
      windowStart: new Date(u.windowStart).toISOString(),
      unitsUsed: u.windowUnits,
      unitsLimit: tenant.quota.monthlyCostUnits,
      utilisation: Number(((u.windowUnits / tenant.quota.monthlyCostUnits) * 100).toFixed(1)),
      byTool: [...u.byTool.entries()]
        .map(([tool, v]) => ({ tool, ...v }))
        .sort((a, b) => b.units - a.units),
    };
  }
}
