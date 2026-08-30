/**
 * Minimal input validation.
 *
 * Zod would be nicer, but a licensed MCP server ships into customer
 * environments and every dependency is a supply-chain question at review time.
 * The input surface here is ten tools with a dozen scalar params, so hand-rolled
 * validators keep the runtime dependency list at exactly one (the MCP SDK).
 */

export class InvalidInput extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInput';
  }
}

export function obj(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidInput('Arguments must be an object.');
  }
  return raw as Record<string, unknown>;
}

export function optInt(
  raw: Record<string, unknown>,
  key: string,
  def: number,
  min: number,
  max: number,
): number {
  const v = raw[key];
  if (v === undefined || v === null) return def;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new InvalidInput(`"${key}" must be an integer.`);
  }
  if (n < min || n > max) {
    throw new InvalidInput(`"${key}" must be between ${min} and ${max}.`);
  }
  return n;
}

export function optEnum<T extends string>(
  raw: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  def: T,
): T {
  const v = raw[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw new InvalidInput(`"${key}" must be one of: ${allowed.join(', ')}.`);
  }
  return v as T;
}

export function reqEnum<T extends string>(
  raw: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  const v = raw[key];
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw new InvalidInput(`"${key}" is required and must be one of: ${allowed.join(', ')}.`);
  }
  return v as T;
}

export function reqString(raw: Record<string, unknown>, key: string, maxLen = 500): string {
  const v = raw[key];
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new InvalidInput(`"${key}" is required and must be a non-empty string.`);
  }
  if (v.length > maxLen) throw new InvalidInput(`"${key}" exceeds ${maxLen} characters.`);
  return v.trim();
}

export function optString(
  raw: Record<string, unknown>,
  key: string,
  def: string | null = null,
  maxLen = 500,
): string | null {
  const v = raw[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== 'string') throw new InvalidInput(`"${key}" must be a string.`);
  if (v.length > maxLen) throw new InvalidInput(`"${key}" exceeds ${maxLen} characters.`);
  return v.trim();
}

export function optBool(raw: Record<string, unknown>, key: string, def: boolean): boolean {
  const v = raw[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== 'boolean') throw new InvalidInput(`"${key}" must be a boolean.`);
  return v;
}
