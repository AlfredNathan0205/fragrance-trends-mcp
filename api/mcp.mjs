/**
 * Vercel function entrypoint for the Streamable HTTP MCP transport.
 *
 * Plain JavaScript against the compiled output on purpose: the platform build
 * step runs `npm run build`, so this file needs no compilation of its own and
 * cannot drift from the monorepo's TypeScript project references.
 *
 * All behaviour lives in packages/mcp/src/http.ts. This is wiring only.
 */

import { createHttpMcpHandler, createNodeRequestListener } from '../packages/mcp/dist/http.js';

export default createNodeRequestListener(createHttpMcpHandler());
