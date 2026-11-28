/**
 * The `develop` toolset: workspace tools plus `track_review_*`. Registered
 * both by the `camstack-mcp-develop` bin and by `dominevo mcp --toolsets develop`.
 */
import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
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
  SCAFFOLD_KINDS,
  validateAddon,
  whoProvides,
} from '@dominevo/develop'
import { createReviewHubProvider } from './track-review/config.js'
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
  const override = process.env.DOMINEVO_WORKSPACE
  if (override && override.trim() !== '') return override
  return requireWorkspaceRoot(process.cwd())
}

/**
 * How a host registers the develop tools. The `dominevo mcp` toolset passes
 * nothing and gets all of them. A host that already owns some names (the
 * private operator MCP keeps its own capability and skill tools) passes
 * `only` and takes the rest from here instead of copying them.
 */
export interface RegisterDevelopOptions {
  /** Register just these tool names. The hub-facing `track_review_*` tools need `trackReview: true` then. */
  readonly only?: readonly string[]
  /** Register the `track_review_*` tools. Defaults to on when `only` is absent. */
  readonly trackReview?: boolean
  /** The workspace the tools read; defaults to `DOMINEVO_WORKSPACE`, else the working directory's. */
  readonly workspaceRoot?: () => string
  /** Annotation class for a tool name, when the host classifies its tools. */
  readonly annotationsFor?: (name: string) => ToolAnnotations | undefined
}

export function registerDevelopTools(
  server: McpServer,
  options: RegisterDevelopOptions = {},
): void {
  const root = options.workspaceRoot ?? workspaceRootFromEnv
  const reg = <Args extends ZodRawShapeCompat>(
    name: string,
    description: string,
    schema: Args,
    cb: ToolCallback<Args>,
  ): void => {
    if (options.only !== undefined && !options.only.includes(name)) return
    const annotations = options.annotationsFor?.(name)
    if (annotations === undefined) server.tool(name, description, schema, cb)
    else server.tool(name, description, schema, annotations, cb)
  }

  reg('list_addons', 'List workspace packages that declare camstack.addons[]', {}, async () =>
    text(listAddonPackages(root())),
  )

  reg(
    'get_addon',
    'Resolve one addon package by id, npm name, or path',
    { query: z.string() },
    async ({ query }) => {
      const pkg = findAddonPackage(root(), query)
      if (!pkg) return text({ error: `not found: ${query}` })
      return text(pkg)
    },
  )

  reg(
    'list_capabilities',
    'List capability definitions from packages/types *.cap.ts sources',
    {},
    async () => text(listCapabilities(root())),
  )

  reg('get_capability', 'Get one capability by name', { name: z.string() }, async ({ name }) => {
    const cap = getCapability(root(), name)
    if (!cap) return text({ error: `not found: ${name}` })
    return text(cap)
  })

  reg(
    'who_provides',
    'Which addons declare a given capability name',
    { capName: z.string() },
    async ({ capName }) => text(whoProvides(root(), capName)),
  )

  reg(
    'list_examples',
    'Curated core-package examples (providers, notifiers, OSD, …)',
    {},
    async () => text(listExamples()),
  )

  reg(
    'find_example',
    'Rank curated examples for a free-text query',
    { query: z.string() },
    async ({ query }) => text(findExample(root(), query)),
  )

  reg(
    'validate_addon',
    'Validate manifest + vite entries (+ known caps). Omit query for whole workspace.',
    { query: z.string().optional() },
    async ({ query }) => text(validateAddon(root(), query)),
  )

  reg(
    'scaffold_addon',
    'Create packages/addon-<name>/ with BaseAddon stub + vite entries map',
    {
      name: z.string(),
      displayName: z.string().optional(),
      description: z.string().optional(),
      kind: z.enum(SCAFFOLD_KINDS).optional(),
      directory: z.string().optional(),
      dryRun: z.boolean().optional(),
    },
    async (args) =>
      text(
        scaffoldAddon({
          workspaceRoot: root(),
          name: args.name,
          ...(args.displayName !== undefined ? { displayName: args.displayName } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.kind !== undefined ? { kind: args.kind } : {}),
          ...(args.directory !== undefined ? { directory: args.directory } : {}),
          dryRun: args.dryRun === true,
        }),
      ),
  )

  reg(
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
          workspaceRoot: root(),
          name: args.name,
          ...(args.scope !== undefined ? { scope: args.scope } : {}),
          ...(args.mode !== undefined ? { mode: args.mode } : {}),
          dryRun: args.dryRun === true,
        }),
      ),
  )

  reg(
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
          workspaceRoot: root(),
          addon: args.addon,
          entryId: args.entryId,
          ...(args.displayName !== undefined ? { displayName: args.displayName } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          dryRun: args.dryRun === true,
        }),
      ),
  )

  reg('list_skills', 'List portable skill-pack markdown procedures', {}, async () =>
    text(listSkills()),
  )

  reg(
    'get_skill',
    'Read one skill markdown file (camstack-addon | camstack-capability | camstack-secrets | camstack-docs | architecture | track-review; the old ids add-addon / add-capability / sync-docs still resolve)',
    { id: z.string() },
    async ({ id }) => {
      const skill = readSkill(id)
      if (!skill) return text({ error: `unknown skill: ${id}` })
      return text({ info: skill.info, content: skill.content })
    },
  )

  const reviewHub = createReviewHubProvider()

  if (!(options.trackReview ?? options.only === undefined)) return
  registerTrackReviewTools(server, {
    getHub: reviewHub,
    now: () => Date.now(),
    random: Math.random,
  })
}
