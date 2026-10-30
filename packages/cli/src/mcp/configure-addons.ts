/**
 * `configure` tools for the addon store (board #274).
 *
 * The same `addons.*` procedures the admin UI's addon store calls:
 * `searchAvailable` (the catalog), `list` and `listInstallations` (what is
 * installed where), `listUpdates`, `installPackage`, `updatePackage` and
 * `uninstallPackage`. A package the manifest marks `protected` or
 * `removable: false` is refused in the DRY RUN with that reason; so is a
 * framework package (updated through the server update, not here).
 *
 * After an apply the hub has the answer; agents reconcile later, so the result
 * says which nodes had it and which will follow, and offers `ops_status`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  text,
  type DryRunOutcome,
  type GatedResult,
  type GatedToolSpec,
  type HubClient,
} from '@camstack/develop'
import { z } from 'zod'
import type { FetchFn, McpContext, ToolTextResult } from './context.js'
import { runGatedAdmin } from './configure-support.js'
import { cap, readQuery, withHub, type NoSessionResult } from './ops-hub.js'

const REGISTRY = 'https://registry.npmjs.org'
const REGISTRY_TIMEOUT_MS = 5_000
const MAX_RESULTS = 15

const PackageName = z
  .string()
  .min(1)
  .regex(/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/, 'not an npm package name')

// ---------------------------------------------------------------------------
// what the hub says

const CatalogShape = z.looseObject({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  keywords: z.array(z.string()).optional(),
  installed: z.boolean(),
  capabilities: z.array(z.string()).nullable(),
})

const ListedAddonShape = z.looseObject({
  manifest: z.looseObject({
    id: z.string(),
    packageName: z.string(),
    packageVersion: z.string(),
    // The hub answers null, not absent, for a manifest without the flag.
    protected: z.boolean().nullish(),
    removable: z.boolean().nullish(),
  }),
})

const UpdateShape = z.looseObject({
  name: z.string(),
  currentVersion: z.string(),
  latestVersion: z.string(),
  category: z.enum(['addon', 'core']),
  requiresRestart: z.boolean(),
  isSystem: z.boolean(),
})

const InstallationsShape = z.looseObject({
  installations: z.array(
    z.looseObject({
      nodeId: z.string(),
      isHub: z.boolean(),
      isOnline: z.boolean(),
      version: z.string().nullable(),
      source: z.string(),
    }),
  ),
  unreachable: z.array(z.looseObject({ nodeId: z.string(), error: z.string() })),
})

const VersionsShape = z.array(
  z.looseObject({ version: z.string(), deprecated: z.string().optional() }),
)

const UninstallShape = z.looseObject({
  success: z.boolean(),
  packageName: z.string(),
  results: z.array(
    z.looseObject({
      nodeId: z.string(),
      outcome: z.string(),
      error: z.string().optional(),
    }),
  ),
})

const ServerStatusShape = z.looseObject({
  runningVersion: z.string().nullable().optional(),
})

interface Protection {
  readonly protected: boolean
  readonly addonIds: readonly string[]
  readonly hubVersion: string | null
}

async function readProtection(client: HubClient, packageName: string): Promise<Protection | null> {
  const list = await readQuery(client, 'addons.list', {}, z.array(ListedAddonShape))
  if (!list.ok) return null
  const mine = list.value.filter((a) => a.manifest.packageName === packageName)
  return {
    protected: mine.some((a) => a.manifest.protected === true || a.manifest.removable === false),
    addonIds: mine.map((a) => a.manifest.id),
    hubVersion: mine[0]?.manifest.packageVersion ?? null,
  }
}

const PROTECTED_REASON = (name: string): string =>
  `${name} is a protected package (manifest protected / removable:false): the kernel needs it, so it is never installed over, updated or removed here`

/** Fail closed: a package whose flags could not be read is never touched. */
const UNREADABLE_PROTECTION_REASON = (name: string): string =>
  `could not read whether ${name} is protected (addons.list did not answer with the expected shape); nothing is changed until it does`

// ---------------------------------------------------------------------------
// compatibility, read from the published manifest

const PackumentShape = z.looseObject({
  peerDependencies: z.record(z.string(), z.string()).optional(),
  engines: z.record(z.string(), z.string()).optional(),
  camstack: z
    .looseObject({
      addons: z
        .array(
          z.looseObject({
            execution: z.looseObject({ placement: z.string().optional() }).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
})

export interface Compatibility {
  /** Where the addon runs, from its manifest `execution.placement`; null = not declared / unreadable. */
  readonly placement: readonly string[] | null
  /** The `@camstack/types` peer range the package was published against. */
  readonly peerTypesRange: string | null
  readonly node: string | null
  /** Why the above could not be read. */
  readonly unreadable?: string
}

async function compatibilityOf(
  name: string,
  version: string,
  fetchFn: FetchFn,
): Promise<Compatibility> {
  const url = `${REGISTRY}/${name.replace('/', '%2f')}/${version}`
  try {
    const res = await fetchFn(url, {
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    })
    if (!res.ok)
      return {
        placement: null,
        peerTypesRange: null,
        node: null,
        unreadable: `registry answered ${res.status}`,
      }
    const parsed = PackumentShape.safeParse(await res.json())
    if (!parsed.success) {
      return {
        placement: null,
        peerTypesRange: null,
        node: null,
        unreadable: 'unexpected registry document',
      }
    }
    const placements = (parsed.data.camstack?.addons ?? [])
      .map((a) => a.execution?.placement)
      .filter((p): p is string => p !== undefined)
    return {
      placement: placements.length > 0 ? [...new Set(placements)] : null,
      peerTypesRange: parsed.data.peerDependencies?.['@camstack/types'] ?? null,
      node: parsed.data.engines?.['node'] ?? null,
    }
  } catch (err) {
    return {
      placement: null,
      peerTypesRange: null,
      node: null,
      unreadable: err instanceof Error ? err.message : String(err),
    }
  }
}

// ---------------------------------------------------------------------------
// configure_addons_search

export interface AddonSearchItem {
  readonly name: string
  readonly version: string
  readonly description: string
  readonly capabilities: readonly string[] | null
  readonly installed: boolean
  readonly installedVersion: string | null
  /** The version an update would move to; null when none, or when updates could not be read. */
  readonly updateTo: string | null
  readonly protected: boolean
  readonly compatibility: Compatibility
}

export interface AddonSearchResult {
  readonly status: 'ok' | 'unavailable'
  readonly hubServerVersion?: string | null
  readonly items?: readonly AddonSearchItem[]
  readonly truncated?: number
  readonly updatesUnavailable?: string
  readonly reason?: string
  readonly note?: string
}

export interface AddonSearchArgs {
  readonly query?: string
  readonly capability?: string
}

export async function configureAddonsSearch(
  ctx: McpContext,
  args: AddonSearchArgs,
): Promise<AddonSearchResult | NoSessionResult> {
  return withHub(ctx, async ({ client }) => {
    const [catalog, listed, updates, server] = await Promise.all([
      readQuery(
        client,
        'addons.searchAvailable',
        {
          ...(args.query !== undefined ? { query: args.query } : {}),
          ...(args.capability !== undefined ? { capability: args.capability } : {}),
        },
        z.array(CatalogShape),
      ),
      readQuery(client, 'addons.list', {}, z.array(ListedAddonShape)),
      readQuery(client, 'addons.listUpdates', {}, z.array(UpdateShape)),
      readQuery(client, 'serverManagement.getServerPackageStatus', undefined, ServerStatusShape),
    ])
    if (!catalog.ok) return { status: 'unavailable', reason: catalog.reason }
    const byPackage = new Map<string, { version: string; protectedPkg: boolean }>()
    if (listed.ok) {
      for (const a of listed.value) {
        const prev = byPackage.get(a.manifest.packageName)
        byPackage.set(a.manifest.packageName, {
          version: a.manifest.packageVersion,
          protectedPkg:
            (prev?.protectedPkg ?? false) ||
            a.manifest.protected === true ||
            a.manifest.removable === false,
        })
      }
    }
    const updateTo = new Map(updates.ok ? updates.value.map((u) => [u.name, u.latestVersion]) : [])
    const capped = cap(catalog.value, MAX_RESULTS)
    const items = await Promise.all(
      capped.items.map(async (c): Promise<AddonSearchItem> => {
        const mine = byPackage.get(c.name)
        return {
          name: c.name,
          version: c.version,
          description: c.description,
          capabilities: c.capabilities,
          installed: c.installed || mine !== undefined,
          installedVersion: mine?.version ?? null,
          updateTo: updateTo.get(c.name) ?? null,
          protected: mine?.protectedPkg ?? false,
          compatibility: await compatibilityOf(c.name, c.version, ctx.fetch),
        }
      }),
    )
    return {
      status: 'ok',
      hubServerVersion: server.ok ? (server.value.runningVersion ?? null) : null,
      items,
      truncated: capped.truncated,
      ...(updates.ok ? {} : { updatesUnavailable: updates.reason }),
      note: 'No addon declares a minimum server version; compatibility shows the @camstack/types peer range, the node engine and where the addon is placed (hub-only or any node).',
    }
  })
}

// ---------------------------------------------------------------------------
// what a node has, after an apply

export interface NodeInstallation {
  readonly nodeId: string
  readonly isHub: boolean
  readonly online: boolean
  readonly version: string | null
}

export interface InstallReport {
  readonly hub: 'present' | 'absent' | 'unknown'
  readonly nodes: readonly NodeInstallation[]
  readonly unreachable: readonly string[]
  readonly followUp: string
}

async function installReport(client: HubClient, packageName: string): Promise<InstallReport> {
  const read = await readQuery(
    client,
    'addons.listInstallations',
    { packageName },
    InstallationsShape,
  )
  if (!read.ok) {
    return {
      hub: 'unknown',
      nodes: [],
      unreachable: [],
      followUp: `could not read where ${packageName} is installed (${read.reason}); ask ops_status in a minute`,
    }
  }
  const nodes = read.value.installations.map((i) => ({
    nodeId: i.nodeId,
    isHub: i.isHub,
    online: i.isOnline,
    version: i.version,
  }))
  return {
    hub: nodes.some((n) => n.isHub) ? 'present' : 'absent',
    nodes,
    unreachable: read.value.unreachable.map((u) => u.nodeId),
    followUp:
      'The hub answered now; agents follow by reconciliation, check again in ~1 min with ops_status.',
  }
}

// ---------------------------------------------------------------------------
// install

export interface InstallArgs {
  readonly packageName: string
  readonly version?: string
}

export const INSTALL_TOOL = 'configure_addon_install'

export function installAddonSpec(client: HubClient, fetchFn: FetchFn): GatedToolSpec<InstallArgs> {
  return {
    tool: INSTALL_TOOL,
    async dryRun(args): Promise<DryRunOutcome> {
      const catalog = await readQuery(
        client,
        'addons.searchAvailable',
        { query: args.packageName },
        z.array(CatalogShape),
      )
      if (!catalog.ok) return { confirmable: false, describe: { problem: catalog.reason } }
      const entry = catalog.value.find((c) => c.name === args.packageName)
      if (entry === undefined) {
        return {
          confirmable: false,
          describe: {
            problem: `${args.packageName} is not in the addon catalog (see configure_addons_search)`,
          },
        }
      }
      const protection = await readProtection(client, args.packageName)
      if (protection === null) {
        return {
          confirmable: false,
          describe: { problem: UNREADABLE_PROTECTION_REASON(args.packageName) },
        }
      }
      if (protection.protected) {
        return {
          confirmable: false,
          describe: { problem: PROTECTED_REASON(args.packageName) },
        }
      }
      const where = await installReport(client, args.packageName)
      if (where.hub === 'present') {
        return {
          confirmable: false,
          describe: {
            problem: `${args.packageName} is already installed on the hub; use configure_addon_update`,
            installedOn: where.nodes,
          },
        }
      }
      if (args.version !== undefined) {
        const versions = await readQuery(
          client,
          'addons.getVersions',
          { name: args.packageName },
          VersionsShape,
        )
        if (versions.ok && !versions.value.some((v) => v.version === args.version)) {
          return {
            confirmable: false,
            describe: {
              problem: `${args.packageName}@${args.version} was never published`,
            },
          }
        }
      }
      const compat = await compatibilityOf(entry.name, args.version ?? entry.version, fetchFn)
      return {
        confirmable: true,
        describe: {
          action: 'install addon on the hub',
          packageName: args.packageName,
          version: args.version ?? entry.version,
          capabilities: entry.capabilities,
          compatibility: compat,
        },
      }
    },
    async execute(args) {
      const raw = await client.call('POST', 'addons.installPackage', {
        packageName: args.packageName,
        ...(args.version !== undefined ? { version: args.version } : {}),
      })
      return {
        packageName: args.packageName,
        hubAnswer: summarize(raw),
        ...(await installReport(client, args.packageName)),
      }
    },
  }
}

function summarize(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const json = typeof value === 'string' ? value : JSON.stringify(value)
  return json.length > 300 ? `${json.slice(0, 300)}…` : json
}

// ---------------------------------------------------------------------------
// update

export interface UpdateArgs {
  readonly packageName: string
  readonly version?: string
  readonly nodeId?: string
}

export const UPDATE_TOOL = 'configure_addon_update'

export function updateAddonSpec(client: HubClient): GatedToolSpec<UpdateArgs> {
  return {
    tool: UPDATE_TOOL,
    async dryRun(args): Promise<DryRunOutcome> {
      const protection = await readProtection(client, args.packageName)
      if (protection === null) {
        return {
          confirmable: false,
          describe: { problem: UNREADABLE_PROTECTION_REASON(args.packageName) },
        }
      }
      if (protection.protected) {
        return {
          confirmable: false,
          describe: { problem: PROTECTED_REASON(args.packageName) },
        }
      }
      const updates = await readQuery(
        client,
        'addons.listUpdates',
        args.nodeId !== undefined ? { nodeId: args.nodeId } : {},
        z.array(UpdateShape),
      )
      if (!updates.ok) return { confirmable: false, describe: { problem: updates.reason } }
      const entry = updates.value.find((u) => u.name === args.packageName)
      if (entry === undefined && args.version === undefined) {
        return {
          confirmable: false,
          describe: {
            problem: `${args.packageName} has no update available${args.nodeId ? ` on ${args.nodeId}` : ''}`,
          },
        }
      }
      if (entry !== undefined && (entry.isSystem || entry.category === 'core')) {
        return {
          confirmable: false,
          describe: {
            problem: `${args.packageName} is a framework package; it moves with the server update, not through the addon store`,
          },
        }
      }
      return {
        confirmable: true,
        describe: {
          action: 'update addon',
          packageName: args.packageName,
          ...(args.nodeId !== undefined ? { nodeId: args.nodeId } : { nodeId: 'hub' }),
          from: entry?.currentVersion ?? protection?.hubVersion ?? null,
          to: args.version ?? entry?.latestVersion ?? null,
          requiresRestart: entry?.requiresRestart ?? null,
        },
      }
    },
    async execute(args) {
      const raw = await client.call('POST', 'addons.updatePackage', {
        name: args.packageName,
        ...(args.version !== undefined ? { version: args.version } : {}),
        ...(args.nodeId !== undefined ? { nodeId: args.nodeId } : {}),
      })
      return {
        packageName: args.packageName,
        hubAnswer: summarize(raw),
        ...(await installReport(client, args.packageName)),
      }
    },
  }
}

// ---------------------------------------------------------------------------
// uninstall

export interface UninstallArgs {
  readonly packageName: string
  readonly nodeId?: string
  readonly everywhere?: boolean
}

export const UNINSTALL_TOOL = 'configure_addon_uninstall'

export function uninstallAddonSpec(client: HubClient): GatedToolSpec<UninstallArgs> {
  return {
    tool: UNINSTALL_TOOL,
    async dryRun(args): Promise<DryRunOutcome> {
      const protection = await readProtection(client, args.packageName)
      if (protection === null) {
        return {
          confirmable: false,
          describe: { problem: UNREADABLE_PROTECTION_REASON(args.packageName) },
        }
      }
      if (protection.protected) {
        return {
          confirmable: false,
          describe: { problem: PROTECTED_REASON(args.packageName) },
        }
      }
      const where = await installReport(client, args.packageName)
      if (where.nodes.length === 0) {
        return {
          confirmable: false,
          describe: {
            problem: `${args.packageName} is not installed on any node I could read`,
            unreachable: where.unreachable,
          },
        }
      }
      return {
        confirmable: true,
        describe: {
          action: 'uninstall addon',
          packageName: args.packageName,
          scope: args.everywhere === true ? 'every node' : (args.nodeId ?? 'hub'),
          installedOn: where.nodes,
          addons: protection?.addonIds ?? [],
          note: 'Its runner stops and its capabilities and code are removed; per-device data of the addon stays on disk.',
        },
      }
    },
    async execute(args) {
      const raw = await client.call('POST', 'addons.uninstallPackage', {
        packageName: args.packageName,
        ...(args.nodeId !== undefined ? { nodeId: args.nodeId } : {}),
        ...(args.everywhere !== undefined ? { everywhere: args.everywhere } : {}),
      })
      const parsed = UninstallShape.safeParse(raw)
      return {
        packageName: args.packageName,
        success: parsed.success ? parsed.data.success : null,
        perNode: parsed.success
          ? parsed.data.results.map((r) => ({
              nodeId: r.nodeId,
              outcome: r.outcome,
              ...(r.error !== undefined ? { error: r.error } : {}),
            }))
          : [],
        followUp:
          'An offline node answers pending-reconnect and is cleaned when it registers again; check again in ~1 min with ops_status.',
      }
    },
  }
}

// ---------------------------------------------------------------------------

export async function installAddon(
  ctx: McpContext,
  args: InstallArgs,
  confirmToken: string | undefined,
): Promise<GatedResult | NoSessionResult> {
  return runGatedAdmin(ctx, (client) => installAddonSpec(client, ctx.fetch), args, confirmToken)
}

export async function updateAddon(
  ctx: McpContext,
  args: UpdateArgs,
  confirmToken: string | undefined,
): Promise<GatedResult | NoSessionResult> {
  return runGatedAdmin(ctx, updateAddonSpec, args, confirmToken)
}

export async function uninstallAddon(
  ctx: McpContext,
  args: UninstallArgs,
  confirmToken: string | undefined,
): Promise<GatedResult | NoSessionResult> {
  return runGatedAdmin(ctx, uninstallAddonSpec, args, confirmToken)
}

const TWO_STEP =
  'Two steps: call without confirm_token for a preview and a one-shot token, then again with the SAME arguments and that token. Needs an admin `camstack login`.'

export function registerAddonTools(server: McpServer, ctx: McpContext): void {
  server.tool(
    'configure_addons_search',
    'Search the addon store (the catalog the admin UI uses) with the installed version, an available update, whether the package is protected, and compatibility (placement, @camstack/types peer range, node engine; no addon declares a minimum server version).',
    {
      query: z.string().max(100).optional(),
      capability: z.string().max(100).optional(),
    },
    async ({ query, capability }): Promise<ToolTextResult> =>
      text(
        await configureAddonsSearch(ctx, {
          ...(query !== undefined ? { query } : {}),
          ...(capability !== undefined ? { capability } : {}),
        }),
      ),
  )

  server.tool(
    INSTALL_TOOL,
    `Install an addon package on the hub from the store. ${TWO_STEP} Agents reconcile later; the result says so.`,
    {
      packageName: PackageName,
      version: z.string().max(64).optional(),
      confirm_token: z.string().optional(),
    },
    async ({ packageName, version, confirm_token }): Promise<ToolTextResult> =>
      text(
        await installAddon(
          ctx,
          { packageName, ...(version !== undefined ? { version } : {}) },
          confirm_token,
        ),
      ),
  )

  server.tool(
    UPDATE_TOOL,
    `Update an installed addon package (hub by default, or one node). Protected and framework packages are refused in the preview. ${TWO_STEP}`,
    {
      packageName: PackageName,
      version: z.string().max(64).optional(),
      nodeId: z.string().max(100).optional(),
      confirm_token: z.string().optional(),
    },
    async ({ packageName, version, nodeId, confirm_token }): Promise<ToolTextResult> =>
      text(
        await updateAddon(
          ctx,
          {
            packageName,
            ...(version !== undefined ? { version } : {}),
            ...(nodeId !== undefined ? { nodeId } : {}),
          },
          confirm_token,
        ),
      ),
  )

  server.tool(
    UNINSTALL_TOOL,
    `Uninstall an addon package from the hub, one node, or everywhere. Protected packages (manifest protected / removable:false) are refused in the preview with the reason. ${TWO_STEP}`,
    {
      packageName: PackageName,
      nodeId: z.string().max(100).optional(),
      everywhere: z.boolean().optional(),
      confirm_token: z.string().optional(),
    },
    async ({ packageName, nodeId, everywhere, confirm_token }): Promise<ToolTextResult> =>
      text(
        await uninstallAddon(
          ctx,
          {
            packageName,
            ...(nodeId !== undefined ? { nodeId } : {}),
            ...(everywhere !== undefined ? { everywhere } : {}),
          },
          confirm_token,
        ),
      ),
  )
}
