#!/usr/bin/env node
/**
 * CamStack develop MCP server (stdio).
 *
 * Two families of tools:
 *
 *  - Workspace tools (`list_addons`, `scaffold_addon`, `validate_addon`, …):
 *    wrap `@camstack/develop`, the same operations as `camstack develop …`.
 *    They read and write files in the local workspace only. No SQLite opens,
 *    no deploy bypass, no hub access.
 *  - `track_review_*` tools: talk to a hub, configured by CAMSTACK_HUB_URL +
 *    CAMSTACK_HUB_TOKEN_FILE (or CAMSTACK_HUB_TOKEN) + CAMSTACK_HUB_CA_FILE.
 *    `track_review_triage` and `track_review_frame` only READ the hub;
 *    `track_review_plan` touches nothing. `track_review_apply` and
 *    `track_review_backfill_origin` are the ONLY tools that mutate a hub
 *    (track flags, retrain frames/annotations/origins, a retrain collection);
 *    `apply` refuses unless called with `confirm: true` and an explicit
 *    collection name, `backfill_origin` is a dry-run unless `confirm: true`,
 *    and both need an admin token.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerDevelopTools } from './register.js'

const server = new McpServer({
  name: 'camstack-develop',
  version: '0.1.0',
})

registerDevelopTools(server)

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`[camstack-mcp-develop] ${msg}`)
  process.exit(1)
})
