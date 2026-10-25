#!/usr/bin/env node
/**
 * Private CamStack operator MCP — `camstack-dev` (offline) / future `camstack-ops`.
 *
 * NOT the public `@camstack/mcp-develop` package. Serves memory overlays,
 * private skills, and full workspace knowledge freely on the operator machine.
 */
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as path from 'node:path'
import { z } from 'zod'
import {
  extendAddon,
  findAddonPackage,
  findExample,
  listAddonPackages,
  listExamples,
  listSkills as listPublicSkills,
  readSkill as readPublicSkill,
  requireWorkspaceRoot,
  scaffoldAddon,
  validateAddon,
  whoProvides,
} from '@camstack/develop'
import { loadDevelopOverlay } from './config.js'
import { text, textError } from './text.js'
import { DEV_TOOLSETS, hasToolset, parseToolsets, type Toolset } from './toolsets.js'
import {
  decisionsForPath,
  getDecision,
  getKnowledgeIndex,
  guardsFor,
  normalizeAdrId,
  subsystemMap,
  subsystemOf,
  trapsFor,
} from './knowledge/index.js'
import { nextAdrNumber, readSection } from './knowledge/read.js'
import { resolveInsideRoot, runUiCli } from './ui/run.js'
import { planCapability } from './caps/plan.js'
import { scaffoldCapability } from './caps/scaffold.js'
import { methodTiersDiff, runCodegen } from './caps/codegen.js'
import { capShipPlan } from './caps/ship.js'
import { getEnrichedCapability, listEnrichedCapabilities } from './caps/enriched.js'
import { affectedChecks, runChecks } from './ci/affected.js'
import { annotationsFor } from './annotations.js'
import { loadApiIndex } from './ops/api-index.js'
import { connectOpsHub, connectOpsMutator, type OpsHub, type OpsMutator } from './ops/hub.js'
import { registerOpsTools } from './ops/register.js'
import { topology } from './ops/curated.js'
import { registerModelTools } from './models/register.js'
import { spawnRunner, type ProcessRunner } from './models/eval.js'
import { MutationGate, stderrAudit, type AuditSink } from './mutations/gate.js'
import { releaseRunner } from './release/commands.js'
import { releasePlan } from './release/plan.js'
import { releaseStatus } from './release/status.js'
import { ScaffoldUiArgsSchema, scaffoldUiComponent } from './ui/scaffold.js'
import { objectShape } from './zod-shape.js'
import { unifiedDiff } from './diff.js'

function workspaceRootFromEnv(): string {
  const override = process.env.CAMSTACK_WORKSPACE
  if (override && override.trim() !== '') return override
  return requireWorkspaceRoot(process.cwd())
}

export interface ServerOptions {
  /** `--token-file` of the ops entry (the first link of the credential chain). */
  readonly tokenFile?: string
  /** `--server`: the hub address, when not in the environment or scratchpad. */
  readonly server?: string
  /** The hub to use instead of connecting (tests inject a fake behind the real gate). */
  readonly hub?: OpsHub
  /** `--allow-mutations`: without it the mutating tools do not exist (D836). */
  readonly allowMutations?: boolean
  /** The mutation doorway to use instead of connecting (tests). */
  readonly mutator?: OpsMutator
  /** Where every mutating-tool call is recorded; defaults to stderr JSON lines. */
  readonly audit?: AuditSink
  /** Process runner for eval_model and the release reads (tests inject a fake). */
  readonly runProcess?: ProcessRunner
  /** Clock and token source for the mutation gate (tests). */
  readonly now?: () => number
  readonly newToken?: () => string
}

export function createServer(
  toolsets: readonly Toolset[] = DEV_TOOLSETS,
  options: ServerOptions = {},
): McpServer {
  const isOpsOnly = hasToolset(toolsets, 'ops') && !hasToolset(toolsets, 'knowledge')
  const server = new McpServer({
    name: isOpsOnly ? 'camstack-ops' : 'camstack-dev',
    version: '0.1.0',
  })

  // Every tool is registered with its annotation class (plan §3.10).
  const tool = <Args extends ZodRawShapeCompat>(
    name: string,
    description: string,
    schema: Args,
    cb: ToolCallback<Args>,
  ): void => {
    server.tool(name, description, schema, annotationsFor(name), cb)
  }

  const root = () => workspaceRootFromEnv()
  const overlay = () => loadDevelopOverlay()
  const knowledge = () => getKnowledgeIndex(root(), overlay())

  // ── knowledge ────────────────────────────────────────────────────────────
  if (hasToolset(toolsets, 'knowledge')) {
    tool(
      'search_knowledge',
      'BM25 search across ADRs, architecture, AGENTS, guards, subsystems, private memory, and the sibling planning clone when it exists (hits from that clone carry source planning). When the clone is absent the result says so once and indexes nothing from it.',
      {
        query: z.string(),
        kinds: z
          .array(
            z.enum([
              'adr',
              'architecture',
              'agents',
              'guard',
              'subsystem',
              'memory',
              'skill',
              'reference',
              'planning',
            ]),
          )
          .optional(),
        limit: z.number().int().positive().max(50).optional(),
      },
      async ({ query, kinds, limit }) => {
        const index = knowledge()
        return text({
          planning: index.planning,
          hits: index.search(query, { kinds, limit }),
        })
      },
    )

    tool(
      'get_decision',
      'Resolve D9 / 9 / adr-0009 to frontmatter + Decision + Enforcement',
      { id: z.string() },
      async ({ id }) => {
        const doc = getDecision(knowledge(), id)
        if (!doc) return textError(`decision not found: ${normalizeAdrId(id)}`)
        return text({
          id: doc.id,
          title: doc.title,
          path: doc.relativePath,
          status: doc.meta?.status,
          appliesTo: doc.meta?.appliesTo,
          supersededBy: doc.meta?.supersededBy,
          decision: doc.meta?.decision,
          enforcement: doc.meta?.enforcement,
        })
      },
    )

    tool(
      'decisions_for_path',
      'ADRs whose applies-to/covers match a path, plus (Dnn) citations in the file',
      { path: z.string() },
      async ({ path: filePath }) =>
        text(
          decisionsForPath(knowledge(), filePath).map((d) => ({
            id: d.id,
            title: d.title,
            path: d.relativePath,
          })),
        ),
    )

    tool(
      'traps_for',
      'Union of skill traps, matching guards, and private memory lessons',
      { topic: z.string() },
      async ({ topic }) => text(trapsFor(knowledge(), topic)),
    )

    tool(
      'subsystem_of',
      'Which subsystem chapter(s) claim a path (from docs/subsystems.yaml)',
      { path: z.string() },
      async ({ path: filePath }) => text(subsystemOf(knowledge(), filePath)),
    )

    tool('subsystem_map', 'Full subsystem taxonomy', {}, async () =>
      text(subsystemMap(knowledge())),
    )

    tool(
      'guards_for',
      'Guards relevant to the given paths, with exact commands',
      { paths: z.array(z.string()) },
      async ({ paths }) => text(guardsFor(knowledge(), paths)),
    )

    tool('list_skills', 'Public develop skills + repo/user overlays', {}, async () => {
      const pub = listPublicSkills()
      const privateSkills = knowledge()
        .docs.filter((d) => d.kind === 'skill')
        .map((d) => ({
          id: d.id.replace(/^skill:/, ''),
          title: d.title,
          path: d.relativePath,
          private: d.private === true,
        }))
      return text({ public: pub, overlays: privateSkills })
    })

    tool(
      'get_skill',
      'Read a skill (public pack first, then repo/user overlays)',
      { id: z.string() },
      async ({ id }) => {
        const pub = readPublicSkill(id)
        if (pub)
          return text({
            layer: 'public',
            info: pub.info,
            content: pub.content,
          })
        const doc = knowledge().docs.find(
          (d) => d.kind === 'skill' && (d.id === `skill:${id}` || d.title === id),
        )
        if (!doc) return textError(`unknown skill: ${id}`)
        return text({
          layer: doc.private ? 'private' : 'repo',
          id: doc.id,
          path: doc.relativePath,
          content: doc.body,
        })
      },
    )

    tool(
      'read_section',
      'Text of one indexed section — the id search_knowledge returns (an architecture anchor, Dnn, a skill id, or a planning doc). Truncated past 12 KB. A planning section carries source planning.',
      { id: z.string() },
      async ({ id }) => {
        const section = readSection(knowledge(), id)
        if (!section) return textError(`section not found: ${id}`)
        return text(section)
      },
    )

    tool(
      'next_adr_number',
      'Next free decision number and file name pattern, from the adr files in docs/decisions (not the generated index).',
      {},
      async () => text(nextAdrNumber(path.join(root(), 'docs', 'decisions'))),
    )
  }

  // ── ui ───────────────────────────────────────────────────────────────────
  if (hasToolset(toolsets, 'ui')) {
    tool(
      'find_ui_component',
      'Rank library components for a free-text need (wraps scripts/ui/cli.ts find)',
      { need: z.string() },
      async ({ need }) => text(runUiCli(root(), 'find', [need])),
    )

    tool(
      'get_ui_component',
      'Props, summary and usage sites for one library export (wraps ui:show)',
      { name: z.string() },
      async ({ name }) => {
        const r = runUiCli(root(), 'show', [name])
        return r.exitCode === 0 ? text(r) : textError(r.output || `not found: ${name}`)
      },
    )

    tool(
      'list_ui_tokens',
      'Admin Tailwind tokens and/or viewer theme tokens (wraps ui:tokens)',
      { platform: z.enum(['admin', 'viewer']).optional() },
      async ({ platform }) => text(runUiCli(root(), 'tokens', platform ? [platform] : [])),
    )

    tool(
      'scaffold_ui_component',
      'Scaffold a ui-library component (file + spec + barrel export). Dry run by default and the dry run is a diff; apply:true writes. Writes confined to the workspace.',
      objectShape(ScaffoldUiArgsSchema),
      async (args) => {
        const result = scaffoldUiComponent(root(), ScaffoldUiArgsSchema.parse(args))
        return result.status === 'refused' ? textError(result.reason) : text(result)
      },
    )

    tool(
      'check_ui_file',
      'Flag raw hex, palette classes, native tags (wraps ui:check; developer tool — not a CI gate)',
      { path: z.string() },
      async ({ path: filePath }) => {
        const rel = resolveInsideRoot(root(), filePath)
        if (rel === null) return textError(`path is outside the workspace: ${filePath}`)
        const r = runUiCli(root(), 'check', [rel, '--warn'])
        return r.exitCode === 2
          ? textError(
              'not a UI source file (only packages/*/src/**/*.tsx|css, plus .ts in admin-ui and ui-library)',
            )
          : text(r)
      },
    )
  }

  // (scaffold_ui_component is registered with the ui tools above)
  // ── caps ─────────────────────────────────────────────────────────────────
  if (hasToolset(toolsets, 'caps')) {
    tool('list_capabilities', 'List enriched capability definitions', {}, async () =>
      text(
        listEnrichedCapabilities(root()).map((c) => ({
          name: c.name,
          scope: c.scope,
          mode: c.mode,
          deviceNative: c.deviceNative,
          internal: c.internal,
          methodCount: c.methods.length,
          relativeFile: c.relativeFile,
        })),
      ),
    )

    tool(
      'get_capability',
      'Enriched capability: methods, auth, deviceNative, mount, providers metadata',
      { name: z.string() },
      async ({ name }) => {
        const cap = getEnrichedCapability(root(), name)
        if (!cap) return textError(`not found: ${name}`)
        return text(cap)
      },
    )

    tool(
      'who_provides',
      'Which addons declare a given capability name',
      { capName: z.string() },
      async ({ capName }) => text(whoProvides(root(), capName)),
    )

    tool(
      'plan_capability',
      'Cardinality-aware plan: do you need a cap, which archetype, guards, examples',
      {
        purpose: z.string(),
        archetype: z
          .enum([
            'system-singleton',
            'system-collection',
            'device-native',
            'device-dispatch',
            'wrapper',
            'internal',
          ])
          .optional(),
      },
      async ({ purpose, archetype }) =>
        text(
          planCapability(root(), {
            purpose,
            ...(archetype ? { archetype } : {}),
          }),
        ),
    )

    tool(
      'scaffold_capability',
      'Scaffold a cardinality-aware cap (dry-run by default; set apply:true to write)',
      {
        name: z.string(),
        archetype: z.enum([
          'system-singleton',
          'system-collection',
          'device-native',
          'device-dispatch',
          'wrapper',
          'internal',
        ]),
        apply: z.boolean().optional(),
      },
      async ({ name, archetype, apply }) =>
        text(
          scaffoldCapability({
            workspaceRoot: root(),
            name,
            archetype,
            apply: apply === true,
          }),
        ),
    )

    tool(
      'run_codegen',
      'Run npm run codegen (or codegen:check)',
      { check: z.boolean().optional() },
      async ({ check }) => text(runCodegen(root(), { check: check === true })),
    )

    tool(
      'method_tiers_diff',
      'Show method-tier baseline drift; pass update:true to accept',
      { update: z.boolean().optional() },
      async ({ update }) => text(methodTiersDiff(root(), { update: update === true })),
    )

    tool(
      'cap_ship_plan',
      'Describe-only publish/deploy train for changed caps',
      {
        changedCaps: z.array(z.string()),
        kind: z
          .enum(['new-cap', 'new-method', 'additive-field', 'auth-tier', 'unknown'])
          .optional(),
      },
      async ({ changedCaps, kind }) => text(capShipPlan(changedCaps, kind ?? 'unknown')),
    )
  }

  // ── addons (reuse public develop library) ────────────────────────────────
  if (hasToolset(toolsets, 'addons')) {
    tool('list_addons', 'List workspace packages that declare camstack.addons[]', {}, async () =>
      text(listAddonPackages(root())),
    )

    tool(
      'get_addon',
      'Resolve one addon package by id, npm name, or path',
      { query: z.string() },
      async ({ query }) => {
        const pkg = findAddonPackage(root(), query)
        if (!pkg) return textError(`not found: ${query}`)
        return text(pkg)
      },
    )

    tool('list_examples', 'Curated core-package examples', {}, async () => text(listExamples()))

    tool(
      'find_example',
      'Rank curated examples for a free-text query',
      { query: z.string() },
      async ({ query }) => text(findExample(root(), query)),
    )

    tool(
      'validate_addon',
      'Validate manifest + vite entries (+ known caps)',
      { query: z.string().optional() },
      async ({ query }) => text(validateAddon(root(), query)),
    )

    tool(
      'scaffold_addon',
      'Create packages/addon-<name>/. Dry run by default (shows each file as a diff); dryRun:false writes.',
      {
        name: z.string(),
        displayName: z.string().optional(),
        description: z.string().optional(),
        kind: z
          .enum([
            'empty',
            'provider',
            'notifier',
            'osd',
            'post-analysis',
            'model-studio',
            'admin-ui',
          ])
          .optional(),
        directory: z.string().optional(),
        dryRun: z.boolean().optional(),
      },
      async (args) => {
        const dryRun = args.dryRun !== false
        const result = scaffoldAddon({
          workspaceRoot: root(),
          name: args.name,
          ...(args.displayName !== undefined ? { displayName: args.displayName } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.kind !== undefined ? { kind: args.kind } : {}),
          ...(args.directory !== undefined ? { directory: args.directory } : {}),
          dryRun,
        })
        const { contents, ...rest } = result
        return text({
          ...rest,
          dryRun,
          diffs: (contents ?? []).map((c) => unifiedDiff(c.path, null, c.content)),
        })
      },
    )

    tool(
      'extend_addon',
      'Add a manifest entry + source + vite key to an existing addon (dry run by default; dryRun:false writes)',
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
            dryRun: args.dryRun !== false,
          }),
        ),
    )
  }

  // ── ci ───────────────────────────────────────────────────────────────────
  if (hasToolset(toolsets, 'ci')) {
    tool(
      'affected_checks',
      'Map changed paths (or git diff) to local check commands. Never suggests checks.yml.',
      {
        paths: z.array(z.string()).optional(),
        gitDiff: z.boolean().optional(),
      },
      async ({ paths, gitDiff }) =>
        text(
          affectedChecks(root(), {
            ...(paths ? { paths } : {}),
            gitDiff: gitDiff !== false && !paths,
          }),
        ),
    )

    tool(
      'run_checks',
      'Run an affected_checks plan locally; deny-lists checks.yml / publish / docker / ssh',
      {
        paths: z.array(z.string()).optional(),
        gitDiff: z.boolean().optional(),
      },
      async ({ paths, gitDiff }) => {
        const plan = affectedChecks(root(), {
          ...(paths ? { paths } : {}),
          gitDiff: gitDiff === true,
        })
        return text({ plan: plan.checks, ...runChecks(root(), plan.checks) })
      },
    )
  }

  // ── release (describe only: never publishes, dispatches, tags or deploys) ──
  if (hasToolset(toolsets, 'release')) {
    tool(
      'release_plan',
      'DESCRIBES the ordered release train for changed paths (publish via CI, applyServerUpdate, deploys, verification, viewer OTA) with the traps. Executes nothing; the commands are for a human.',
      {
        paths: z.array(z.string()).optional(),
        gitDiff: z.boolean().optional(),
        note: z.string().max(500).optional(),
      },
      async ({ paths, gitDiff, note }) => {
        const changed =
          paths ?? (gitDiff === false ? [] : affectedChecks(root(), { gitDiff: true }).paths)
        return text(releasePlan(changed, note))
      },
    )
  }

  // ── ops (read-only, credentialed; the `camstack-ops` entry) ───────────────
  if (hasToolset(toolsets, 'ops')) {
    let connected: OpsHub | undefined
    let connecting: Promise<OpsHub> | undefined
    // The connection may renew an expired `camstack login` session over HTTP, so
    // it is settled by `ready()` before any tool body asks for the hub.
    const ready = async (): Promise<void> => {
      if (options.hub || connected) return
      connecting ??= connectOpsHub({
        workspaceRoot: root(),
        index: loadApiIndex(root()),
        ...(options.tokenFile ? { tokenFile: options.tokenFile } : {}),
        ...(options.server ? { server: options.server } : {}),
      })
      try {
        connected = await connecting
      } finally {
        connecting = undefined
      }
    }
    const getHub = (): OpsHub => {
      if (options.hub) return options.hub
      if (!connected) throw new Error('the hub connection is not ready')
      return connected
    }
    registerOpsTools(tool, getHub, ready)

    const runner = options.runProcess ?? spawnRunner
    tool(
      'release_status',
      'Where the train stands, read-only: git vs origin/main, CI and publish runs (gh), npm registry vs local versions, node versions from the hub. Reads only; nothing is published or dispatched.',
      {},
      async () =>
        text(
          await releaseStatus(root(), {
            run: releaseRunner(runner),
            hubVersions: () => topology(getHub()),
          }),
        ),
    )

    if (hasToolset(toolsets, 'models')) {
      let mutator: OpsMutator | undefined
      let mutating: Promise<OpsMutator> | undefined
      const readyAll = async (): Promise<void> => {
        await ready()
        if (options.mutator || mutator || !options.allowMutations) return
        mutating ??= connectOpsMutator({
          workspaceRoot: root(),
          index: loadApiIndex(root()),
          ...(options.tokenFile ? { tokenFile: options.tokenFile } : {}),
          ...(options.server ? { server: options.server } : {}),
        })
        try {
          mutator = await mutating
        } finally {
          mutating = undefined
        }
      }
      const getMutator = (): OpsMutator => {
        if (options.mutator) return options.mutator
        if (!mutator) throw new Error('the hub connection is not ready')
        return mutator
      }
      const gate = new MutationGate({
        allowMutations: options.allowMutations === true,
        audit: options.audit ?? stderrAudit,
        ...(options.now ? { now: options.now } : {}),
        ...(options.newToken ? { newToken: options.newToken } : {}),
      })
      registerModelTools(tool, { root, getHub, ready: readyAll, getMutator, gate, run: runner })
    }
  }

  return server
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.findIndex((a) => a === name || a.startsWith(`${name}=`))
  if (i < 0) return undefined
  const arg = argv[i]!
  return arg.includes('=') ? arg.split('=').slice(1).join('=') : argv[i + 1]
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const toolsets = parseToolsets(argv)
  const tokenFile = flagValue(argv, '--token-file')
  const hubServer = flagValue(argv, '--server')
  const server = createServer(toolsets, {
    allowMutations: argv.includes('--allow-mutations'),
    ...(tokenFile ? { tokenFile } : {}),
    ...(hubServer ? { server: hubServer } : {}),
  })
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

const isDirect =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('server.js') ||
    process.argv[1].endsWith('server.ts') ||
    process.argv[1].includes('mcp-dev'))

if (isDirect) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[camstack-dev] ${msg}`)
    process.exit(1)
  })
}
