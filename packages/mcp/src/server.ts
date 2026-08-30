/**
 * MCP protocol layer.
 *
 * Thin by design. It maps ToolSpecs to MCP tool descriptors and routes calls
 * into the core execution pipeline. No business logic lives here — that is what
 * lets the same ten tools also back a REST surface or a nightly batch export
 * without a rewrite.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  createFixtureRegistry,
  executeTool,
  TOOLS,
  ToolExecutionError,
  type Meter,
  type SourceRegistry,
} from '@ftm/core';
import { randomUUID } from 'node:crypto';

export interface ServerOptions {
  sources?: SourceRegistry;
  meter?: Meter;
  tenantId: string;
  /** False in fixture/demo mode: tools degrade honestly instead of calling vendors. */
  allowVendorCalls?: boolean;
  licensedMode?: boolean;
}

export function createMcpServer(opts: ServerOptions): Server {
  const sources = opts.sources ?? createFixtureRegistry();
  const allowVendorCalls = opts.allowVendorCalls ?? false;
  const licensedMode = opts.licensedMode ?? true;

  const server = new Server(
    { name: 'fragrance-trends-mcp', version: '0.2.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      // Cost and freshness are advertised so the calling model can choose the
      // cheap tool when the cheap tool will do.
      description: `${t.description}\n\n[cost: ${t.costClass}; freshness target: ${Math.round(t.ttlSeconds / 3600)}h]`,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const requestId = randomUUID();
    try {
      const envelope = await executeTool({
        tool: req.params.name,
        args: req.params.arguments ?? {},
        ctx: {
          sources,
          tenantId: opts.tenantId,
          requestId,
          licensedMode,
          allowVendorCalls,
        },
        meter: opts.meter,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(envelope, null, 2) }],
      };
    } catch (err) {
      if (err instanceof ToolExecutionError) {
        // Surface the reason. A licensee debugging a quota stop or an integrity
        // rejection needs to know which it was.
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { error: err.code, message: err.message, detail: err.detail ?? null, requestId },
                null,
                2,
              ),
            },
          ],
        };
      }
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                error: 'internal',
                message: err instanceof Error ? err.message : String(err),
                requestId,
              },
              null,
              2,
            ),
          },
        ],
      };
    }
  });

  return server;
}
