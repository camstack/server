/**
 * `ops_update_check`: read-only. Every node comes from `nodes.topology`; per
 * node the server closure (running / installed / latest), the wrapper (image
 * or app) verdict from the node's own `imageContract`, and whether its addon
 * versions match the hub's. Plus the hub's addon updates and the CLI itself.
 */
import { z } from 'zod'
import type { McpContext } from './context.js'
import { cap, readQuery, type Read } from './ops-hub.js'
import { withAdminHub } from './configure-support.js'
import {
  addonDrift,
  AddonUpdateShape,
  capState,
  needsServerUpdate,
  readInstallations,
  readNodeStatus,
  readTopology,
  serverVerdict,
  wrapperVerdict,
  type AddonDrift,
  type ServerVerdict,
  type TopologyNode,
  type WrapperVerdict,
} from './ops-update-model.js'
import { cliVerdict, type CliVersionVerdict } from './ops-update-cli.js'

export interface UpdateCheckNode {
  readonly id: string
  readonly name: string | null
  readonly isHub: boolean
  readonly online: boolean
  readonly platform: string | null
  readonly capabilityCount: number
  readonly flags: readonly 'online-but-capless'[]
  readonly server: ServerVerdict | null
  readonly serverNeedsUpdate: boolean | null
  readonly wrapper: WrapperVerdict | null
  /** Why `server`/`wrapper` are null: offline or the read failed. */
  readonly unreadable?: string
  readonly addonsBehindHub: readonly AddonDrift[]
}

export interface UpdateCheckDeps {
  /** Resolved path of the running CLI entry (default `process.argv[1]`). */
  readonly entryPath?: string
}

export const ADDON_LIMIT = 30

export async function opsUpdateCheck(ctx: McpContext, deps: UpdateCheckDeps = {}) {
  return withAdminHub(ctx, async ({ client, server }) => {
    const unavailable: { [part: string]: string } = {}
    const [topology, updates, installs, cli] = await Promise.all([
      readTopology(client),
      readQuery(client, 'addons.listUpdates', {}, z.array(AddonUpdateShape)),
      readInstallations(client),
      cliVerdict(ctx.cliVersion, ctx.fetch, deps.entryPath ?? process.argv[1] ?? ''),
    ])
    if (!topology.ok) {
      return { status: 'unavailable' as const, reason: topology.reason, cli }
    }
    const drift = installs.ok ? addonDrift(installs.value) : []
    if (!installs.ok) unavailable['addonVersionsPerNode'] = installs.reason
    else if (installs.value.unreachable.length > 0) {
      unavailable['addonVersionsPerNode'] =
        `no answer from ${installs.value.unreachable.map((u) => u.nodeId).join(', ')}`
    }
    const nodes = await Promise.all(topology.value.map((n) => checkNode(client, n, drift)))
    let hubAddons: {
      readonly items: readonly {
        name: string
        from: string
        to: string
        framework: boolean
      }[]
      readonly truncated: number
    } | null = null
    if (updates.ok) {
      const capped = cap(updates.value, ADDON_LIMIT)
      hubAddons = {
        items: capped.items.map((u) => ({
          name: u.name,
          from: u.currentVersion,
          to: u.latestVersion,
          framework: u.isSystem || u.category === 'core',
        })),
        truncated: capped.truncated,
      }
    } else unavailable['hubAddonUpdates'] = updates.reason
    return {
      status: 'ok' as const,
      hub: server,
      nodes,
      hubAddons,
      cli,
      viewer: {
        status: 'not-exposed' as const,
        note: 'No hub API reports the viewer version; the web viewer is served by the hub and the mobile apps update through their stores.',
      },
      summary: {
        serverUpdateNeeded: nodes.filter((n) => n.serverNeedsUpdate === true).map((n) => n.id),
        wrapperUpdateNeeded: nodes.filter((n) => n.wrapper?.behind === true).map((n) => n.id),
        offline: nodes.filter((n) => !n.online).map((n) => n.id),
        capless: nodes.filter((n) => n.flags.length > 0).map((n) => n.id),
        nodesWithAddonDrift: [...new Set(drift.map((d) => d.nodeId))],
        cliUpdateNeeded: cli.updateAvailable,
      },
      unavailable,
      note: "Latest versions come from the hub's last registry check (`latestCheckedAt`), not a fresh one; a version just published may not show yet.",
    }
  })
}

async function checkNode(
  client: Parameters<typeof readNodeStatus>[0],
  node: TopologyNode,
  drift: readonly AddonDrift[],
): Promise<UpdateCheckNode> {
  const caps = capState(node)
  const base = {
    id: node.id,
    name: node.name ?? null,
    isHub: node.isHub === true,
    online: node.isOnline,
    platform: node.platform ?? null,
    capabilityCount: caps.count,
    flags: caps.capless && node.isOnline ? ['online-but-capless' as const] : [],
    addonsBehindHub: drift.filter((d) => d.nodeId === node.id),
  }
  if (!node.isOnline) {
    return {
      ...base,
      server: null,
      serverNeedsUpdate: null,
      wrapper: null,
      unreadable: 'node is offline',
    }
  }
  const status: Read<Parameters<typeof serverVerdict>[0]> = await readNodeStatus(client, node)
  if (!status.ok) {
    return {
      ...base,
      server: null,
      serverNeedsUpdate: null,
      wrapper: null,
      unreadable: status.reason,
    }
  }
  const server = serverVerdict(status.value)
  return {
    ...base,
    server,
    serverNeedsUpdate: needsServerUpdate(server),
    wrapper: wrapperVerdict(status.value),
  }
}
