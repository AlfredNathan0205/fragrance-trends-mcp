/**
 * Tenancy.
 *
 * The parent app authenticated humans through Azure AD SSO with a domain
 * allowlist — correct for one company's staff, useless for licensing. A
 * licensee is a machine holding a key, with a contract attached: which tools,
 * how many calls, how much vendor spend, and whether they may redistribute.
 *
 * Nothing here is user identity. There are no user accounts in an MCP licence.
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

export type PlanTier = 'evaluation' | 'standard' | 'enterprise';

export interface Quota {
  /** Rolling 30-day cost-unit ceiling. Hard stop, not a soft warning. */
  monthlyCostUnits: number;
  /** Burst protection. Vendor rate limits are the real constraint. */
  callsPerMinute: number;
  /** Tools this licensee may call. Empty = all. Enables tiered packaging. */
  allowedTools: string[];
  /** Whether responses may be cached and re-served by the licensee. */
  redistributionAllowed: boolean;
}

export const PLANS: Record<PlanTier, Quota> = {
  evaluation: {
    monthlyCostUnits: 500,
    callsPerMinute: 10,
    // Heavy tools are the ones that burn vendor credit. Not on a free trial.
    allowedTools: [
      'get_trending_fragrances',
      'get_trending_ingredients',
      'detect_emerging_trends',
      'search_fragrance_intelligence',
    ],
    redistributionAllowed: false,
  },
  standard: {
    monthlyCostUnits: 25_000,
    callsPerMinute: 60,
    allowedTools: [],
    redistributionAllowed: false,
  },
  enterprise: {
    monthlyCostUnits: 250_000,
    callsPerMinute: 300,
    allowedTools: [],
    redistributionAllowed: true,
  },
};

export interface Tenant {
  id: string;
  name: string;
  tier: PlanTier;
  quota: Quota;
  /** SHA-256 of the API key. The key itself is never stored. */
  keyHash: string;
  active: boolean;
  createdAt: string;
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function mintKey(prefix = 'ftm'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

export class UnauthorizedTenant extends Error {
  constructor(message = 'Invalid or inactive API key.') {
    super(message);
    this.name = 'UnauthorizedTenant';
  }
}

export class ToolNotLicensed extends Error {
  constructor(tool: string, tier: PlanTier) {
    super(`Tool "${tool}" is not included in the ${tier} plan.`);
    this.name = 'ToolNotLicensed';
  }
}

/**
 * In-memory tenant store for the proof of concept.
 *
 * Swap for Postgres with a tenant_id column on every row before any real
 * licensee touches it — the parent app's 35 tables have no tenant isolation at
 * all, which is the largest single piece of net-new work in the conversion.
 */
export class TenantStore {
  private byHash = new Map<string, Tenant>();

  create(name: string, tier: PlanTier): { tenant: Tenant; apiKey: string } {
    const apiKey = mintKey();
    const tenant: Tenant = {
      id: randomUUID(),
      name,
      tier,
      quota: { ...PLANS[tier] },
      keyHash: hashKey(apiKey),
      active: true,
      createdAt: new Date().toISOString(),
    };
    this.byHash.set(tenant.keyHash, tenant);
    return { tenant, apiKey };
  }

  /** Constant-time comparison to keep key lookup free of timing signal. */
  authenticate(apiKey: string): Tenant {
    const hash = hashKey(apiKey);
    for (const [storedHash, tenant] of this.byHash) {
      const a = Buffer.from(storedHash, 'hex');
      const b = Buffer.from(hash, 'hex');
      if (a.length === b.length && timingSafeEqual(a, b)) {
        if (!tenant.active) throw new UnauthorizedTenant('Licence suspended.');
        return tenant;
      }
    }
    throw new UnauthorizedTenant();
  }

  assertToolAllowed(tenant: Tenant, tool: string): void {
    const allowed = tenant.quota.allowedTools;
    if (allowed.length > 0 && !allowed.includes(tool)) {
      throw new ToolNotLicensed(tool, tenant.tier);
    }
  }

  list(): Tenant[] {
    return [...this.byHash.values()];
  }
}
