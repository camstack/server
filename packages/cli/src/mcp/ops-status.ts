/**
 * `ops_status`: a short cluster summary — nodes, their server version, how many
 * capabilities each registered, the active alerts, the addons that have an
 * update. Every part is read on its own, so one refused or failed read leaves a
 * `null` with its reason and never a made-up zero (D393).
 */
import type { HubConnection } from '@camstack/develop'
import { z } from 'zod'
import type { McpContext } from './context.js'
import {
  ADMIN_ONLY_NOTE,
  cap,
  readQuery,
  withHub,
  type NoSessionResult,
  type Read,
} from './ops-hub.js'

export const TopologyNodeSchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  platform: z.string().optional(),
  isHub: z.boolean().optional(),
  isOnline: z.boolean(),
  addons: z.array(z.looseObject({ capabilities: z.array(z.string()) })).optional(),
  /** Agents report it; the hub does not. Absent means "not claimed". */
  capabilitiesRegistered: z.boolean().optional(),
})
export const TopologySchema = z.array(TopologyNodeSchema)

const ServerStatusSchema = z.looseObject({
  runningVersion: z.string(),
  restartRequired: z.boolean().optional(),
  updateAvailable: z.boolean().optional(),
  updateState: z.string().optional(),
})

const AlertSchema = z.looseObject({
  severity: z.string(),
  title: z.string(),
  message: z.string().optional(),
  status: z.string(),
})
const AlertsSchema = z.array(AlertSchema)

const AddonUpdateSchema = z.looseObject({
  name: z.string(),
  currentVersion: z.string(),
  latestVersion: z.string(),
})
const AddonUpdatesSchema = z.array(AddonUpdateSchema)

export const NODE_LIMIT = 40
export const ALERT_LIMIT = 10
export const UPDATE_LIMIT = 20

export interface NodeSummary {
  readonly id: string
  readonly name: string | null
  readonly online: boolean
  readonly platform: string | null
  readonly isHub: boolean
  /** `null` with `versionReason`: the read failed — unknown, not "none". */
  readonly serverVersion: string | null
  readonly versionReason?: string
  readonly restartRequired: boolean | null
  readonly updateAvailable: boolean | null
  readonly capabilityCount: number
  /** `online-but-capless` (D848): the node answers but registered no capability. */
  readonly flags: readonly 'online-but-capless'[]
}

export interface AlertsSummary {
  readonly active: number
  readonly bySeverity: { readonly [severity: string]: number }
  readonly top: readonly {
    readonly severity: string
    readonly title: string
  }[]
  readonly truncated: number
}

export interface OpsStatusResult {
  readonly status: 'ok'
  readonly hub: string
  readonly tier: string
  /** `null` plus a reason in `unavailable` when the node list could not be read. */
  readonly nodes: readonly NodeSummary[] | null
  readonly nodesTruncated: number
  readonly alerts: AlertsSummary | null
  readonly addonsNeedingUpdate: {
    readonly items: readonly {
      readonly name: string
      readonly from: string
      readonly to: string
    }[]
    readonly truncated: number
  } | null
  /** What could not be read, by part, with the reason. Empty when everything answered. */
  readonly unavailable: { readonly [part: string]: string }
}

export function distinctCaps(node: z.infer<typeof TopologyNodeSchema>): number {
  const names = new Set<string>()
  for (const addon of node.addons ?? []) for (const c of addon.capabilities) names.add(c)
  return names.size
}

export function isCapless(node: z.infer<typeof TopologyNodeSchema>, count: number): boolean {
  if (!node.isOnline) return false
  return (
    node.capabilitiesRegistered === false ||
    (node.capabilitiesRegistered === undefined && count === 0)
  )
}

async function nodeSummary(
  connection: HubConnection,
  node: z.infer<typeof TopologyNodeSchema>,
): Promise<NodeSummary> {
  const count = distinctCaps(node)
  const base = {
    id: node.id,
    name: node.name ?? null,
    online: node.isOnline,
    platform: node.platform ?? null,
    isHub: node.isHub === true,
    capabilityCount: count,
    flags: isCapless(node, count) ? ['online-but-capless' as const] : [],
  }
  if (!node.isOnline) {
    return {
      ...base,
      serverVersion: null,
      versionReason: 'node is offline',
      restartRequired: null,
      updateAvailable: null,
    }
  }
  const input = node.isHub === true ? undefined : { nodeId: node.id }
  const status = await readQuery(
    connection.client,
    'serverManagement.getServerPackageStatus',
    input,
    ServerStatusSchema,
  )
  if (!status.ok) {
    return {
      ...base,
      serverVersion: null,
      versionReason: status.reason,
      restartRequired: null,
      updateAvailable: null,
    }
  }
  return {
    ...base,
    serverVersion: status.value.runningVersion,
    restartRequired: status.value.restartRequired ?? null,
    updateAvailable: status.value.updateAvailable ?? null,
  }
}

function summariseAlerts(alerts: z.infer<typeof AlertsSchema>): AlertsSummary {
  const active = alerts.filter((a) => a.status === 'active')
  const bySeverity: { [severity: string]: number } = {}
  for (const a of active) bySeverity[a.severity] = (bySeverity[a.severity] ?? 0) + 1
  const order = ['critical', 'error', 'warning', 'warn', 'info']
  const rank = (s: string): number => {
    const i = order.indexOf(s)
    return i === -1 ? order.length : i
  }
  const sorted = [...active].sort((a, b) => rank(a.severity) - rank(b.severity))
  const top = cap(sorted, ALERT_LIMIT)
  return {
    active: active.length,
    bySeverity,
    top: top.items.map((a) => ({ severity: a.severity, title: a.title })),
    truncated: top.truncated,
  }
}

export async function opsStatus(ctx: McpContext): Promise<OpsStatusResult | NoSessionResult> {
  return withHub(ctx, async (connection) => {
    const unavailable: { [part: string]: string } = {}
    const admin = connection.tier === 'admin'
    const client = connection.client

    const topology: Read<z.infer<typeof TopologySchema>> = admin
      ? await readQuery(client, 'nodes.topology', undefined, TopologySchema)
      : {
          ok: false,
          reason: ADMIN_ONLY_NOTE('nodes.topology', connection.adminHint),
        }
    const [alertsRead, updatesRead] = await Promise.all([
      readQuery(client, 'alerts.list', {}, AlertsSchema),
      admin
        ? readQuery(client, 'addons.listUpdates', {}, AddonUpdatesSchema)
        : Promise.resolve<Read<z.infer<typeof AddonUpdatesSchema>>>({
            ok: false,
            reason: ADMIN_ONLY_NOTE('addons.listUpdates', connection.adminHint),
          }),
    ])

    let nodes: readonly NodeSummary[] | null = null
    let nodesTruncated = 0
    if (topology.ok) {
      const capped = cap(topology.value, NODE_LIMIT)
      nodesTruncated = capped.truncated
      nodes = await Promise.all(capped.items.map((n) => nodeSummary(connection, n)))
    } else {
      unavailable['nodes'] = topology.reason
    }

    let alerts: AlertsSummary | null = null
    if (alertsRead.ok) alerts = summariseAlerts(alertsRead.value)
    else unavailable['alerts'] = alertsRead.reason

    let addonsNeedingUpdate: OpsStatusResult['addonsNeedingUpdate'] = null
    if (updatesRead.ok) {
      const capped = cap(updatesRead.value, UPDATE_LIMIT)
      addonsNeedingUpdate = {
        items: capped.items.map((u) => ({
          name: u.name,
          from: u.currentVersion,
          to: u.latestVersion,
        })),
        truncated: capped.truncated,
      }
    } else {
      unavailable['addonsNeedingUpdate'] = updatesRead.reason
    }

    return {
      status: 'ok' as const,
      hub: connection.server,
      tier: connection.tier,
      nodes,
      nodesTruncated,
      alerts,
      addonsNeedingUpdate,
      unavailable,
    }
  })
}
