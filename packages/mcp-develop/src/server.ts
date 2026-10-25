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
import { z } from 'zod'
import {
  extendAddon,
  findAddonPackage,
  findExample,
  getCapability,
  listAddonPackages,
  listCapabilities,
  listExamples,
  listSkills,
  readSkill,
  requireWorkspaceRoot,
  scaffoldAddon,
  scaffoldCapStub,
  validateAddon,
  whoProvides,
} from '@camstack/develop'
import { resolveReviewHub } from './track-review/config.js'
import type { ReviewHub } from './track-review/hub-api.js'
import { registerTrackReviewTools } from './track-review/register.js'

function text(value: unknown): { content: { type: 'text'; text: string }[] } {
  return {
    content: [
      {
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
  }
}

function workspaceRootFromEnv(): string {
  const override = process.env.CAMSTACK_WORKSPACE
  if (override && override.trim() !== '') return override
  return requireWorkspaceRoot(process.cwd())
}

const server = new McpServer({
  name: 'camstack-develop',
  version: '0.1.0',
})

server.tool('list_addons', 'List workspace packages that declare camstack.addons[]', {}, async () =>
  text(listAddonPackages(workspaceRootFromEnv())),
)

server.tool(
  'get_addon',
  'Resolve one addon package by id, npm name, or path',
  { query: z.string() },
  async ({ query }) => {
    const pkg = findAddonPackage(workspaceRootFromEnv(), query)
    if (!pkg) return text({ error: `not found: ${query}` })
    return text(pkg)
  },
)

server.tool(
  'list_capabilities',
  'List capability definitions from packages/types *.cap.ts sources',
  {},
  async () => text(listCapabilities(workspaceRootFromEnv())),
)

server.tool(
  'get_capability',
  'Get one capability by name',
  { name: z.string() },
  async ({ name }) => {
    const cap = getCapability(workspaceRootFromEnv(), name)
    if (!cap) return text({ error: `not found: ${name}` })
    return text(cap)
  },
)

server.tool(
  'who_provides',
  'Which addons declare a given capability name',
  { capName: z.string() },
  async ({ capName }) => text(whoProvides(workspaceRootFromEnv(), capName)),
)

server.tool(
  'list_examples',
  'Curated core-package examples (providers, notifiers, OSD, …)',
  {},
  async () => text(listExamples()),
)

server.tool(
  'find_example',
  'Rank curated examples for a free-text query',
  { query: z.string() },
  async ({ query }) => text(findExample(workspaceRootFromEnv(), query)),
)

server.tool(
  'validate_addon',
  'Validate manifest + vite entries (+ known caps). Omit query for whole workspace.',
  { query: z.string().optional() },
  async ({ query }) => text(validateAddon(workspaceRootFromEnv(), query)),
)

server.tool(
  'scaffold_addon',
  'Create packages/addon-<name>/ with BaseAddon stub + vite entries map',
  {
    name: z.string(),
    displayName: z.string().optional(),
    description: z.string().optional(),
    kind: z.enum(['empty', 'provider', 'notifier', 'osd', 'post-analysis']).optional(),
    directory: z.string().optional(),
    dryRun: z.boolean().optional(),
  },
  async (args) =>
    text(
      scaffoldAddon({
        workspaceRoot: workspaceRootFromEnv(),
        name: args.name,
        ...(args.displayName !== undefined ? { displayName: args.displayName } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.kind !== undefined ? { kind: args.kind } : {}),
        ...(args.directory !== undefined ? { directory: args.directory } : {}),
        dryRun: args.dryRun === true,
      }),
    ),
)

server.tool(
  'scaffold_cap_stub',
  'Write a *.cap.ts stub (does not edit index.ts or run codegen)',
  {
    name: z.string(),
    scope: z.enum(['system', 'device']).optional(),
    mode: z.enum(['singleton', 'collection']).optional(),
    dryRun: z.boolean().optional(),
  },
  async (args) =>
    text(
      scaffoldCapStub({
        workspaceRoot: workspaceRootFromEnv(),
        name: args.name,
        ...(args.scope !== undefined ? { scope: args.scope } : {}),
        ...(args.mode !== undefined ? { mode: args.mode } : {}),
        dryRun: args.dryRun === true,
      }),
    ),
)

server.tool(
  'extend_addon',
  'Add a new manifest entry + source + vite key to an existing addon package',
  {
    addon: z.string(),
    entryId: z.string(),
    displayName: z.string().optional(),
    description: z.string().optional(),
    dryRun: z.boolean().optional(),
  },
  async (args) =>
    text(
      extendAddon({
        workspaceRoot: workspaceRootFromEnv(),
        addon: args.addon,
        entryId: args.entryId,
        ...(args.displayName !== undefined ? { displayName: args.displayName } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        dryRun: args.dryRun === true,
      }),
    ),
)

server.tool('list_skills', 'List portable skill-pack markdown procedures', {}, async () =>
  text(listSkills()),
)

server.tool(
  'get_skill',
  'Read one skill markdown file (camstack-addon | camstack-capability | camstack-secrets | camstack-docs | architecture | track-review; the old ids add-addon / add-capability / sync-docs still resolve)',
  { id: z.string() },
  async ({ id }) => {
    const skill = readSkill(id)
    if (!skill) return text({ error: `unknown skill: ${id}` })
    return text({ info: skill.info, content: skill.content })
  },
)

let cachedHub: ReviewHub | undefined
function reviewHub(): ReviewHub {
  cachedHub ??= resolveReviewHub()
  return cachedHub
}

registerTrackReviewTools(server, {
  getHub: reviewHub,
  now: () => Date.now(),
  random: Math.random,
})

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err)
  console.error(`[camstack-mcp-develop] ${msg}`)
  process.exit(1)
})
