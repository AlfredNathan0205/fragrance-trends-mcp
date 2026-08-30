import { enforce, type Finding } from './guard.js';
import type {
  CacheInfo,
  CallMeta,
  Envelope,
  IntegrityInfo,
  ModelRole,
  Provenance,
  SourceRef,
  Staleness,
} from './types.js';

export function staleness(ageSeconds: number, ttlSeconds: number): Staleness {
  if (ageSeconds <= ttlSeconds) return 'fresh';
  if (ageSeconds <= ttlSeconds * 2) return 'aging';
  return 'stale';
}

export function cacheInfo(
  hit: boolean,
  observedAt: string | null,
  ttlSeconds: number,
): CacheInfo {
  const ageSeconds = observedAt
    ? Math.max(0, Math.round((Date.now() - Date.parse(observedAt)) / 1000))
    : 0;
  return { hit, ageSeconds, ttlSeconds, staleness: staleness(ageSeconds, ttlSeconds) };
}

export interface BuildEnvelopeInput<T> {
  data: T;
  tool: string;
  tenantId: string;
  requestId: string;
  costUnits: number;
  startedAt: number;
  sources: SourceRef[];
  cache: CacheInfo;
  modelRole: ModelRole;
  numericOrigin: IntegrityInfo['numericOrigin'];
  requested: number;
  returned: number;
  omissions?: string[];
  ignoreFields?: string[];
  licensedMode?: boolean;
}

/**
 * Wrap a tool result. Runs the integrity guard before the value can escape —
 * a violation throws rather than shipping a suspicious number to a licensee.
 */
export function buildEnvelope<T>(input: BuildEnvelopeInput<T>): {
  envelope: Envelope<T>;
  warnings: Finding[];
} {
  const warnings = enforce(input.data, {
    modelRole: input.modelRole,
    declaredNumericOrigin: input.numericOrigin,
    licensedMode: input.licensedMode,
    ignoreFields: input.ignoreFields,
  });

  const notes = warnings.map((w) => `${w.code}${w.field ? ` [${w.field}]` : ''}: ${w.detail}`);

  const provenance: Provenance = {
    sources: input.sources,
    generatedAt: new Date().toISOString(),
    cache: input.cache,
    integrity: {
      modelRole: input.modelRole,
      numericOrigin: input.numericOrigin,
      guard: 'enforced',
      ...(notes.length > 0 ? { notes } : {}),
    },
    coverage: {
      requested: input.requested,
      returned: input.returned,
      partial: input.returned < input.requested,
      ...(input.omissions?.length ? { omissions: input.omissions } : {}),
    },
  };

  const meta: CallMeta = {
    tool: input.tool,
    tenantId: input.tenantId,
    requestId: input.requestId,
    costUnits: input.costUnits,
    durationMs: Date.now() - input.startedAt,
  };

  return { envelope: { data: input.data, provenance, meta }, warnings };
}
