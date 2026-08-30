/**
 * Execution pipeline.
 *
 * One path in and out of every tool: validate, authorise+meter, run, wrap,
 * guard. Nothing bypasses it. This is what keeps the provenance guarantee from
 * being a convention that erodes the first time someone is in a hurry.
 */

import { buildEnvelope, cacheInfo } from './provenance/envelope.js';
import { IntegrityViolation } from './provenance/guard.js';
import { getTool } from './registry.js';
import { COST_UNITS, type ToolContext } from './tool.js';
import type { Envelope } from './provenance/types.js';
import { InvalidInput } from './validate.js';

export interface Meter {
  /**
   * Called BEFORE the tool runs. Throws or returns a denial to stop execution.
   * Pre-authorisation matters because the expensive part is the vendor call —
   * charging after the fact means the budget is already blown.
   */
  authorise(tenantId: string, tool: string, costUnits: number): Promise<void>;
  /** Called after a successful run, with the actual duration. */
  record(tenantId: string, tool: string, costUnits: number, durationMs: number): Promise<void>;
}

export interface ExecuteOptions {
  tool: string;
  args: unknown;
  ctx: ToolContext;
  meter?: Meter;
}

export class ToolExecutionError extends Error {
  constructor(
    message: string,
    public readonly code: 'invalid_input' | 'integrity' | 'quota' | 'internal',
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}

export async function executeTool(opts: ExecuteOptions): Promise<Envelope<unknown>> {
  const spec = getTool(opts.tool);
  const startedAt = Date.now();
  const costUnits = COST_UNITS[spec.costClass];

  let input: unknown;
  try {
    input = spec.parseInput(opts.args);
  } catch (err) {
    if (err instanceof InvalidInput) {
      throw new ToolExecutionError(err.message, 'invalid_input');
    }
    throw err;
  }

  if (opts.meter) {
    try {
      await opts.meter.authorise(opts.ctx.tenantId, spec.name, costUnits);
    } catch (err) {
      throw new ToolExecutionError(
        err instanceof Error ? err.message : 'Quota denied.',
        'quota',
      );
    }
  }

  const result = await spec.run(input, opts.ctx);

  try {
    const { envelope } = buildEnvelope({
      data: result.data,
      tool: spec.name,
      tenantId: opts.ctx.tenantId,
      requestId: opts.ctx.requestId,
      costUnits,
      startedAt,
      sources: result.sources,
      cache: cacheInfo(result.cacheHit, result.observedAt, spec.ttlSeconds),
      modelRole: result.modelRole,
      numericOrigin: result.numericOrigin,
      requested: result.requested,
      returned: result.returned,
      omissions: result.omissions,
      ignoreFields: result.ignoreFields,
      licensedMode: opts.ctx.licensedMode,
    });

    await opts.meter?.record(opts.ctx.tenantId, spec.name, costUnits, Date.now() - startedAt);
    return envelope;
  } catch (err) {
    if (err instanceof IntegrityViolation) {
      // Fail closed. A suspicious number never reaches a licensee.
      throw new ToolExecutionError(err.message, 'integrity', err.findings);
    }
    throw err;
  }
}
