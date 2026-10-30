/**
 * The `develop` toolset: workspace tools plus `track_review_*`. Registered
 * both by the `camstack-mcp-develop` bin and by `camstack mcp --toolsets develop`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
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

export function registerDevelopTools(server: McpServer): void {
  server.tool(
    'list_addons',
    'List workspace packages that declare camstack.addons[]',
    {},
    async () => text(listAddonPackages(workspaceRootFromEnv())),
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
}
