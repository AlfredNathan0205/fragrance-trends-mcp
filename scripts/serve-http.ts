/**
 * Local HTTP server for the MCP Streamable HTTP transport.
 *
 * Same handler the hosted function uses, so what you test locally is what
 * deploys. Set FTM_EVALUATION_KEY first, or one is minted for this run.
 */

import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { mintKey } from '@ftm/api';
import { createHttpMcpHandler, createNodeRequestListener } from '../packages/mcp/src/http.js';

const port = Number(process.env['PORT'] ?? 8787);
const apiKey = process.env['FTM_EVALUATION_KEY'] ?? mintKey();

const server = createServer(
  createNodeRequestListener(
    createHttpMcpHandler({ env: { ...process.env, FTM_EVALUATION_KEY: apiKey } }),
  ),
);

server.listen(port, () => {
  const { port: bound } = server.address() as AddressInfo;
  console.log(`Fragrance Trends MCP — Streamable HTTP\n`);
  console.log(`  endpoint  http://localhost:${bound}/api/mcp`);
  console.log(`  api key   ${apiKey}`);
  console.log(`  mode      ${process.env['FTM_MODE'] ?? 'fixture'}\n`);
  console.log(`  curl -s http://localhost:${bound}/api/mcp | head -20\n`);
});
