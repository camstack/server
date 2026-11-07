/**
 * The Environment section of `report_issue`: typed, built ONLY from fields on
 * an allow list. Nothing is copied from a hub answer as a whole, so a token, a
 * hostname or an address that a settings page or a node row happens to carry
 * has no way in. What goes in:
 *
 *  - per node: a position label (`node#1`, never its id or name), whether it is
 *    the hub, platform and arch, the server version;
 *  - per critical addon, per node: installed version and state;
 *  - per camera device: the numeric id and its type word.
 *
 * A value must also match a strict shape for its field (a version is digits,
 * letters, dots, plus and dash). One that does not is dropped as `unknown`.
 */
import type { HubClient } from '@camstack/develop'
import { z } from 'zod'
import type { McpContext } from './context.js'
import { readQuery, type Read } from './ops-hub.js'
import { opsStatus, type NodeSummary } from './ops-status.js'
import { mapLimit, READ_CONCURRENCY } from './setup-assist-common.js'
import { readProbe } from './support-accelerator.js'
import type { KnownName } from './report-scrub.js'

export interface CriticalAddon {
  readonly id: string
  readonly group: string
}

/** The addons whose state decides most issues. Fixed: a new one is a code change, not a config read. */
export const CRITICAL_ADDONS: readonly CriticalAddon[] = [
  { id: 'cloudflare-tunnel', group: 'cloudflare tunnel' },
  { id: 'cloudflare-turn', group: 'turn' },
  { id: 'static-turn', group: 'turn' },
  { id: 'tailscale-ingress', group: 'remote access' },
  { id: 'tailscale-client', group: 'remote access' },
  { id: 'remote-access-orchestrator', group: 'remote access' },
  { id: 'notifiers', group: 'notifiers' },
  { id: 'smtp-nodemailer', group: 'notifiers' },
  { id: 'export-hap', group: 'exporters (homekit)' },
  { id: 'export-alexa', group: 'exporters (alexa)' },
  { id: 'export-google', group: 'exporters (google)' },
  { id: 'matter-broker', group: 'exporters (matter)' },
  { id: 'homeassistant-export', group: 'exporters (home assistant)' },
  { id: 'provider-homeassistant', group: 'exporters (home assistant)' },
  { id: 'recorder', group: 'recording / storage' },
  { id: 'storage-orchestrator', group: 'recording / storage' },
  { id: 'filesystem-storage', group: 'recording / storage' },
  { id: 'sftp-storage', group: 'recording / storage' },
  { id: 's3-storage', group: 'recording / storage' },
  { id: 'webdav-storage', group: 'recording / storage' },
  { id: 'smb-storage', group: 'recording / storage' },
  { id: 'pipeline-orchestrator', group: 'pipeline' },
  { id: 'pipeline-runner', group: 'pipeline' },
  { id: 'detection-pipeline', group: 'pipeline' },
  { id: 'pipeline-analytics', group: 'pipeline' },
  { id: 'stream-broker', group: 'stream broker' },
  { id: 'webrtc-native', group: 'webrtc' },
]

export const NODE_CAP = 12

export type AddonState = 'installed' | 'configured' | 'enabled' | 'running'

export interface NodeFact {
  readonly label: string
  readonly isHub: boolean
  readonly online: boolean
  readonly platform: string
  readonly arch: string
  readonly serverVersion: string
}

export interface AddonFact {
  readonly id: string
  readonly group: string
  readonly node: string
  readonly version: string
  /** The highest rung reached: installed < configured < enabled < running. */
  readonly state: AddonState
  /** The runner's own word (`running`, `failed`, `stopped`, `starting`) when it is a plain word. */
  readonly runner: string
}

export interface DeviceFact {
  readonly id: number
  readonly type: string
}

export interface EnvironmentFacts {
  readonly cliVersion: string
  readonly nodeCount: number
  readonly nodes: readonly NodeFact[]
  readonly addons: readonly AddonFact[]
  /** Critical addons found on no node. */
  readonly absent: readonly string[]
  readonly viewerVersion: string | null
  readonly device: DeviceFact | null
  /** What could not be read, by part: unknown, never "absent". */
  readonly unavailable: { readonly [part: string]: string }
  /** Names to hide in every other section; never rendered. */
  readonly knownNames: readonly KnownName[]
}

const VERSION = /^[0-9A-Za-z.+-]{1,40}$/
const WORD = /^[a-z0-9-]{1,24}$/

export const safeVersion = (value: string | null | undefined): string =>
  value !== null && value !== undefined && VERSION.test(value) ? value : 'unknown'

export const safeWord = (value: string | null | undefined): string => {
  const lower = value?.toLowerCase()
  return lower !== undefined && WORD.test(lower) ? lower : 'unknown'
}

const NodeAddonsSchema = z.array(
  z.looseObject({
    id: z.string(),
    status: z.string(),
    version: z.string().optional(),
  }),
)

const ScopedValuesSchema = z.record(z.string(), z.unknown()).nullable()

type ScopeName = 'cluster' | 'node'

interface ScopedForm {
  readonly cap: string
  readonly scope: ScopeName
}

/**
 * The scoped forms each critical addon declares (`clusterSettingsSchema` /
 * `nodeSettingsSchema`). An addon absent here declares none, so it has no stored
 * settings to be "configured" by. A node form is read on the hub's own node.
 */
export const SCOPED_FORMS: Readonly<Record<string, readonly ScopedForm[]>> = {
  'cloudflare-tunnel': [{ cap: 'network-access', scope: 'node' }],
  'tailscale-ingress': [{ cap: 'network-access', scope: 'node' }],
  'tailscale-client': [{ cap: 'mesh-network', scope: 'node' }],
  'pipeline-orchestrator': [{ cap: 'pipeline-orchestrator', scope: 'cluster' }],
  'pipeline-runner': [{ cap: 'pipeline-runner', scope: 'node' }],
  'detection-pipeline': [
    { cap: 'detection-pipeline', scope: 'cluster' },
    { cap: 'pipeline-executor', scope: 'node' },
  ],
  'pipeline-analytics': [
    { cap: 'pipeline-analytics', scope: 'cluster' },
    { cap: 'face-gallery', scope: 'cluster' },
  ],
  'stream-broker': [
    { cap: 'stream-broker', scope: 'cluster' },
    { cap: 'stream-broker', scope: 'node' },
  ],
  recorder: [{ cap: 'recording', scope: 'cluster' }],
}

const DeviceRowSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  type: z.string().optional(),
})

/** Whether the stored values hold ANY saved value. The values themselves are dropped here. */
export function hasSavedValues(values: z.infer<typeof ScopedValuesSchema>): boolean {
  if (values === null) return false
  return Object.values(values).some((v) => v !== undefined && v !== null && v !== '')
}

function stateOf(status: string, configured: boolean | null): AddonState {
  if (status === 'running') return 'running'
  if (status === 'starting' || status === 'failed') return 'enabled'
  return configured === true ? 'configured' : 'installed'
}

async function readConfigured(client: HubClient, addonId: string): Promise<boolean | null> {
  const forms = SCOPED_FORMS[addonId] ?? []
  const reads = await Promise.all(
    forms.map((form) =>
      readQuery(
        client,
        'addonSettings.readScopedValues',
        { addonId, cap: form.cap, scope: form.scope },
        ScopedValuesSchema,
      ),
    ),
  )
  if (reads.length > 0 && reads.every((r) => !r.ok)) return null
  return reads.some((r) => r.ok && hasSavedValues(r.value))
}

async function nodeFacts(
  client: HubClient,
  nodes: readonly NodeSummary[],
  unavailable: { [part: string]: string },
): Promise<NodeFact[]> {
  return mapLimit(nodes.slice(0, NODE_CAP), READ_CONCURRENCY, async (n) => {
    const probe: Read<{ platform: string; arch: string }> = n.online
      ? await readProbe(client, n.id)
      : { ok: false, reason: 'node is offline' }
    if (!probe.ok && n.online) unavailable[`probe:${n.id}`] = probe.reason
    return {
      label: '',
      isHub: n.isHub,
      online: n.online,
      platform: safeWord(probe.ok ? probe.value.platform : n.platform),
      arch: safeWord(probe.ok ? probe.value.arch : null),
      serverVersion: safeVersion(n.serverVersion),
    }
  }).then((rows) => rows.map((r, idx) => ({ ...r, label: `node#${String(idx + 1)}` })))
}

export async function collectEnvironment(
  ctx: McpContext,
  client: HubClient,
  args: {
    readonly deviceId?: number
    readonly viewerAppVersion?: string | null
  },
): Promise<EnvironmentFacts> {
  const unavailable: { [part: string]: string } = {}
  const status = await opsStatus(ctx)
  const summaries: readonly NodeSummary[] =
    status.status === 'ok' && status.nodes !== null ? status.nodes : []
  if (status.status !== 'ok') unavailable['nodes'] = status.message
  else if (status.nodes === null) unavailable['nodes'] = status.unavailable['nodes'] ?? 'unreadable'

  const nodes = await nodeFacts(client, summaries, unavailable)
  const knownNames: KnownName[] = []
  summaries.slice(0, NODE_CAP).forEach((n, i) => {
    const label = `node#${String(i + 1)}`
    knownNames.push({ name: n.id, label })
    if (n.name !== null) knownNames.push({ name: n.name, label })
  })

  const criticalIds = new Set(CRITICAL_ADDONS.map((a) => a.id))
  const perNode = await mapLimit(
    summaries.slice(0, NODE_CAP).map((n, i) => ({
      n,
      label: nodes[i]?.label ?? `node#${String(i + 1)}`,
    })),
    READ_CONCURRENCY,
    async ({ n, label }) => {
      if (!n.online) return { label, rows: [] as z.infer<typeof NodeAddonsSchema> }
      const read = await readQuery(
        client,
        'nodes.getNodeAddons',
        { nodeId: n.id },
        NodeAddonsSchema,
      )
      if (!read.ok) {
        unavailable[`addons:${label}`] = read.reason
        return { label, rows: [] as z.infer<typeof NodeAddonsSchema> }
      }
      return { label, rows: read.value.filter((a) => criticalIds.has(a.id)) }
    },
  )

  const installedIds = [...new Set(perNode.flatMap((p) => p.rows.map((r) => r.id)))]
  const configuredBy = new Map<string, boolean | null>()
  await mapLimit(installedIds, READ_CONCURRENCY, async (id) => {
    configuredBy.set(id, await readConfigured(client, id))
  })

  const addons: AddonFact[] = perNode.flatMap(({ label, rows }) =>
    rows.flatMap((row): AddonFact[] => {
      const meta = CRITICAL_ADDONS.find((a) => a.id === row.id)
      if (meta === undefined) return []
      return [
        {
          id: meta.id,
          group: meta.group,
          node: label,
          version: safeVersion(row.version),
          state: stateOf(row.status, configuredBy.get(row.id) ?? null),
          runner: safeWord(row.status),
        },
      ]
    }),
  )
  const seen = new Set(addons.map((a) => a.id))
  const absent =
    Object.keys(unavailable).some((k) => k.startsWith('addons:')) || summaries.length === 0
      ? []
      : CRITICAL_ADDONS.filter((a) => !seen.has(a.id)).map((a) => a.id)

  let device: DeviceFact | null = null
  const rows = await readQuery(
    client,
    'deviceManager.listAll',
    { projection: 'slim' },
    z.array(DeviceRowSchema),
  )
  if (rows.ok) {
    for (const d of rows.value) knownNames.push({ name: d.name, label: `device#${String(d.id)}` })
    const hit =
      args.deviceId === undefined ? undefined : rows.value.find((d) => d.id === args.deviceId)
    if (hit !== undefined) device = { id: hit.id, type: safeWord(hit.type) }
  } else unavailable['devices'] = rows.reason
  if (args.deviceId !== undefined && device === null) {
    device = { id: args.deviceId, type: 'unknown' }
  }

  return {
    cliVersion: safeVersion(ctx.cliVersion),
    nodeCount: summaries.length,
    nodes,
    addons,
    absent,
    viewerVersion:
      args.viewerAppVersion === null || args.viewerAppVersion === undefined
        ? null
        : safeVersion(args.viewerAppVersion),
    device,
    unavailable,
    knownNames,
  }
}

export interface AddonRow {
  readonly id: string
  readonly group: string
  readonly nodes: readonly string[]
  readonly version: string
  readonly state: AddonState
  readonly runner: string
}

/** Identical addon + version + state + runner on several nodes is one row listing them. */
export function collapseAddons(addons: readonly AddonFact[]): AddonRow[] {
  const rows = new Map<string, { row: AddonFact; nodes: string[] }>()
  for (const a of addons) {
    const key = [a.id, a.version, a.state, a.runner].join('|')
    const hit = rows.get(key)
    if (hit) hit.nodes.push(a.node)
    else rows.set(key, { row: a, nodes: [a.node] })
  }
  return [...rows.values()].map(({ row, nodes }) => ({
    id: row.id,
    group: row.group,
    nodes,
    version: row.version,
    state: row.state,
    runner: row.runner,
  }))
}

/** The markdown of the section. Only allow-listed facts reach it. */
export function renderEnvironment(env: EnvironmentFacts): string {
  const lines: string[] = [
    '## Environment',
    `- camstack CLI: ${env.cliVersion}`,
    `- nodes: ${String(env.nodeCount)}`,
  ]
  for (const n of env.nodes) {
    lines.push(
      `- ${n.label}${n.isHub ? ' (hub)' : ''}: server ${n.serverVersion}, ${n.platform}/${n.arch}${n.online ? '' : ', offline'}`,
    )
  }
  lines.push(`- viewer app: ${env.viewerVersion ?? 'unknown'}`)
  if (env.device !== null) lines.push(`- device#${String(env.device.id)}: type ${env.device.type}`)
  if (env.addons.length > 0) {
    lines.push(
      '',
      '| addon | group | nodes | version | state | runner |',
      '| --- | --- | --- | --- | --- | --- |',
    )
    for (const row of collapseAddons(env.addons)) {
      lines.push(
        `| ${row.id} | ${row.group} | ${row.nodes.join(', ')} | ${row.version} | ${row.state} | ${row.runner} |`,
      )
    }
  }
  if (env.absent.length > 0) lines.push('', `Not installed on any node: ${env.absent.join(', ')}`)
  const missing = Object.keys(env.unavailable)
  if (missing.length > 0) {
    lines.push(
      '',
      `Could not be read (unknown, not absent): ${missing.map((m) => m.split(':')[0]).join(', ')}`,
    )
  }
  return lines.join('\n')
}
