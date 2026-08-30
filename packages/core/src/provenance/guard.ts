/**
 * Runtime integrity guard.
 *
 * Every finding below corresponds to a real production incident recorded in the
 * parent app's `.agents/memory/anti-hallucination.md`. That file was tribal
 * knowledge in prose. This file makes it executable, so a regression fails a
 * test instead of failing a customer demo.
 */

import type { IntegrityInfo, ModelRole } from './types.js';

export type FindingCode =
  /** Payload contains numbers but the tool declared it had none. */
  | 'UNDECLARED_NUMERICS'
  /** Licensed mode forbids a model authoring output. */
  | 'GENERATIVE_MODEL_IN_LICENSED_MODE'
  /** Every row carries an identical value for a numeric field. */
  | 'FLAT_DISTRIBUTION'
  /** A ratio between two numeric fields is constant across rows. */
  | 'CONSTANT_CROSS_FIELD_RATIO'
  /** Mass round numbers — the signature of a hand-filled or poisoned cache. */
  | 'IMPLAUSIBLE_ROUNDNESS'
  /** A large share of rows sit on identical extreme values — a clamp, not a measurement. */
  | 'CLAMP_PEGGING';

export interface Finding {
  code: FindingCode;
  severity: 'error' | 'warn';
  field?: string;
  detail: string;
}

export class IntegrityViolation extends Error {
  constructor(public readonly findings: Finding[]) {
    super(
      `Integrity guard rejected response: ${findings
        .map((f) => `${f.code}${f.field ? ` (${f.field})` : ''}`)
        .join(', ')}`,
    );
    this.name = 'IntegrityViolation';
  }
}

interface AuditOptions {
  modelRole: ModelRole;
  declaredNumericOrigin: IntegrityInfo['numericOrigin'];
  /** Licensed deployments refuse generative numerics outright. */
  licensedMode?: boolean;
  /** Fields that are legitimately constant (ids, enums-as-number, ranks). */
  ignoreFields?: string[];
}

/** Pull the row array out of a payload, if the payload is row-shaped. */
function asRows(data: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(data)) {
    return data.every((d) => d && typeof d === 'object' && !Array.isArray(d))
      ? (data as Record<string, unknown>[])
      : null;
  }
  if (data && typeof data === 'object') {
    for (const v of Object.values(data as Record<string, unknown>)) {
      const rows = Array.isArray(v) ? asRows(v) : null;
      if (rows && rows.length >= 3) return rows;
    }
  }
  return null;
}

function numericFields(rows: Record<string, unknown>[], ignore: Set<string>) {
  const fields = new Map<string, number[]>();
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (ignore.has(k) || typeof v !== 'number' || !Number.isFinite(v)) continue;
      const arr = fields.get(k) ?? [];
      arr.push(v);
      fields.set(k, arr);
    }
  }
  // Only consider fields present on most rows.
  for (const [k, vals] of fields) {
    if (vals.length < rows.length * 0.8) fields.delete(k);
  }
  return fields;
}

function containsNumber(value: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.some((v) => containsNumber(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) =>
      containsNumber(v, depth + 1),
    );
  }
  return false;
}

/**
 * Audit a payload. Returns findings; caller decides whether to throw.
 *
 * Deliberately conservative: it flags shapes that *look* fabricated even when
 * the generating code is honest. The parent app learned the hard way that a
 * user who sees the same number on every row does not care whether a bug or a
 * lie produced it — trust is gone either way.
 */
export function auditPayload(data: unknown, opts: AuditOptions): Finding[] {
  const findings: Finding[] = [];
  const ignore = new Set([
    'id',
    'rank',
    'year',
    'index',
    ...(opts.ignoreFields ?? []),
  ]);

  if (opts.licensedMode !== false && opts.modelRole === 'generative') {
    findings.push({
      code: 'GENERATIVE_MODEL_IN_LICENSED_MODE',
      severity: 'error',
      detail:
        'A generative model authored this payload. Licensed tools must run models in qualitative_only mode.',
    });
  }

  if (opts.declaredNumericOrigin === 'none' && containsNumber(data)) {
    findings.push({
      code: 'UNDECLARED_NUMERICS',
      severity: 'error',
      detail:
        'Tool declared numericOrigin="none" but the payload contains numeric values.',
    });
  }

  const rows = asRows(data);
  if (!rows || rows.length < 3) return findings;

  const fields = numericFields(rows, ignore);

  // 1. Flat distribution — "growth is always 0" class of bug.
  for (const [field, vals] of fields) {
    const distinct = new Set(vals);
    if (distinct.size === 1 && vals.length >= 3) {
      findings.push({
        code: 'FLAT_DISTRIBUTION',
        severity: 'warn',
        field,
        detail: `Every one of ${vals.length} rows reports ${vals[0]}. Check for a precondition the real data can never satisfy (e.g. "if (n < 4) return 0").`,
      });
    }
  }

  // 2. Constant cross-field ratio — the poisoned-cache signature.
  const names = [...fields.keys()];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = fields.get(names[i]!)!;
      const b = fields.get(names[j]!)!;
      if (a.length !== b.length || a.length < 4) continue;
      const ratios: number[] = [];
      for (let k = 0; k < a.length; k++) {
        const den = b[k]!;
        if (den === 0) break;
        ratios.push(a[k]! / den);
      }
      if (ratios.length !== a.length) continue;
      const first = ratios[0]!;
      if (first === 0) continue;
      const allSame = ratios.every((r) => Math.abs(r - first) / Math.abs(first) < 1e-6);
      if (allSame) {
        findings.push({
          code: 'CONSTANT_CROSS_FIELD_RATIO',
          severity: 'error',
          field: `${names[i]}/${names[j]}`,
          detail: `Ratio is exactly ${first.toFixed(4)} on all ${ratios.length} rows. Real scraped data does not do this — one formula stamped out every row.`,
        });
      }
    }
  }

  // 3. Clamp pegging.
  //
  // Found in the parent app's own production snapshot: of 42 tracked hashtags,
  // 14 reported growth of exactly +200 and 9 exactly -50. Those are the bounds
  // of a clamp, not observations. A third of the dataset was reporting the
  // ceiling as if it were a measurement, which silently destroys any ranking
  // built on that field.
  for (const [field, vals] of fields) {
    if (vals.length < 8) continue;
    const counts = new Map<number, number>();
    for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1);
    const distinct = [...counts.keys()].sort((a, b) => a - b);
    if (distinct.length < 2) continue;
    const lo = distinct[0]!;
    const hi = distinct[distinct.length - 1]!;
    const pegged = (counts.get(lo) ?? 0) + (counts.get(hi) ?? 0);
    const share = pegged / vals.length;
    if (share >= 0.35 && (counts.get(hi) ?? 0) >= 3) {
      findings.push({
        code: 'CLAMP_PEGGING',
        severity: 'warn',
        field,
        detail: `${pegged} of ${vals.length} rows (${Math.round(share * 100)}%) sit on the extremes ${lo} / ${hi}. Values pegged to a clamp are not measurements — any ranking or momentum label derived from this field is unreliable for those rows.`,
      });
    }
  }

  // 4. Mass roundness — hand-filled cache entries.
  for (const [field, vals] of fields) {
    const big = vals.filter((v) => Math.abs(v) >= 1000);
    if (big.length < 4) continue;
    const round = big.filter((v) => v % 1000 === 0);
    if (round.length === big.length) {
      findings.push({
        code: 'IMPLAUSIBLE_ROUNDNESS',
        severity: 'warn',
        field,
        detail: `All ${big.length} values are exact multiples of 1000. Inspect the persisted cache, not just the generating code.`,
      });
    }
  }

  return findings;
}

/** Audit and throw on any error-severity finding. */
export function enforce(data: unknown, opts: AuditOptions): Finding[] {
  const findings = auditPayload(data, opts);
  const errors = findings.filter((f) => f.severity === 'error');
  if (errors.length > 0) throw new IntegrityViolation(errors);
  return findings;
}
