/**
 * Pure model behind the cluster's per-node LOAD PROSPECTUS.
 *
 * Joins the three reads the balancer itself uses — `getAgentLoad` (live per-node
 * and per-accelerator session counts + the capacity score it minimises),
 * `listAgentSettings` (the operator's per-node `detectWeight` / `maxCameras`)
 * and `getNodeInferenceDevices` (each accelerator with the dispatcher's own
 * `exclusion` verdict) — into one row per node.
 *
 * Three honesty rules it exists to enforce:
 *
 *  1. **A node the load snapshot does not carry is `reported: false`, never
 *     zeros.** `getAgentLoad` returns only runners that answered; rendering a
 *     silent node as "0 cameras, idle" reads as capacity that is not there.
 *  2. **The weight share is normalised over the nodes that actually compete** —
 *     online ∧ detect-enabled — because that is the set `balance()` ranks. A
 *     share computed over every configured node is a number the balancer never
 *     applies.
 *  3. **An excluded accelerator stays visible, out of the share, carrying its
 *     REASON.** The reason comes from the server (`NodeInferenceDevice.exclusion`,
 *     computed by the same `resolveInferenceDeviceEligibility` the dispatcher
 *     runs); it is never re-derived here, because two of the four reasons —
 *     `accelerator-preferred` (D215) and `cannot-host-camera-root` — are not
 *     visible in the row's own `enabled`/`available` bits.
 */
import type {
  AgentLoadSummary,
  InferenceDeviceExclusionReason,
  NodeInferenceDevice,
} from '@camstack/types'
import { acceleratorLabel } from '@camstack/ui-library'

/** The per-node facts the prospectus needs that do NOT come from the load snapshot. */
export interface ClusterNodeFacts {
  readonly id: string
  readonly name: string
  readonly isOnline: boolean
  /** Whether this node participates in detection placement at all. */
  readonly detectEnabled: boolean
  /** Operator's `detectWeight` (absent/invalid ⇒ 1, matching the balancer). */
  readonly weight: number
  /** Operator's `maxCameras` hard ceiling; null = unlimited. */
  readonly maxCameras: number | null
}

/** One accelerator on one node, as the balancer sees it. */
export interface AcceleratorLoad {
  readonly key: string
  readonly label: string
  readonly format: string
  /**
   * Live sessions attached to this device pool (`RunnerLocalLoad.devices`).
   * null when it is not known: the node did not report, or it carries sessions
   * that no device accounts for (a default-pool session the census could not
   * attribute) — a device absent from the snapshot then holds an unknown share
   * of them, not 0 (D393).
   */
  readonly sessions: number | null
  readonly weight: number
  /** Share of this node's dispatches this device should take; null when excluded. */
  readonly weightSharePct: number | null
  readonly maxSessions: number | null
  /** True when the device is KNOWN to be at/over its concurrent-session cap (balancer skips it). */
  readonly atCap: boolean
  readonly available: boolean
  readonly enabled: boolean
  /** Why the dispatcher drops it, or null when it is a camera-root candidate. */
  readonly exclusion: InferenceDeviceExclusionReason | null
}

/** One node's load row. */
export interface NodeLoadRow {
  readonly nodeId: string
  readonly name: string
  readonly isOnline: boolean
  readonly detectEnabled: boolean
  /** False when `getAgentLoad` carried no snapshot for this node. */
  readonly reported: boolean
  /** null when unreported — never 0, which would read as spare capacity. */
  readonly attachedCameras: number | null
  readonly activeCameras: number | null
  readonly maxCameras: number | null
  /** attached/maxCameras as a percentage; null when uncapped or unreported. */
  readonly capacityPct: number | null
  readonly queueDepthTotal: number | null
  readonly avgInferenceTimeMs: number | null
  /** The value `balance()` minimises (`attached + queueDepth`), weight-unadjusted. */
  readonly score: number | null
  readonly weight: number
  /** Share of unpinned dispatches this node should take; null when it does not compete. */
  readonly weightSharePct: number | null
  readonly decodeHwaccel: string | null
  readonly devices: readonly AcceleratorLoad[]
  /** How many accelerators are camera-root candidates (0 ⇒ the runner default pool serves it). */
  readonly eligibleDeviceCount: number
}

export interface NodeLoadInput {
  readonly nodes: readonly ClusterNodeFacts[]
  readonly loads: readonly AgentLoadSummary[]
  /** `nodeId → getNodeInferenceDevices(...).devices`; a node absent = not loaded yet. */
  readonly devicesByNode: Readonly<Record<string, readonly NodeInferenceDevice[]>>
}

/** i18n key of the operator-facing sentence for each exclusion reason. */
export const EXCLUSION_TEXT_KEY: Readonly<Record<InferenceDeviceExclusionReason, string>> = {
  disabled: 'pipeline.nodeLoadOverview.exclusion.disabled',
  unavailable: 'pipeline.nodeLoadOverview.exclusion.unavailable',
  'cannot-host-camera-root': 'pipeline.nodeLoadOverview.exclusion.cannotHostCameraRoot',
  'accelerator-preferred': 'pipeline.nodeLoadOverview.exclusion.acceleratorPreferred',
}

function pct(part: number, whole: number): number {
  if (whole <= 0) return 0
  return Math.round((part / whole) * 1000) / 10
}

/**
 * Whether a device the load snapshot does not list really holds 0 sessions.
 * Only when the node reported AND every attached session is attributed to some
 * device: then absence is a measured 0. Otherwise the absent device's count is
 * unknown.
 */
function absenceMeansZero(summary: AgentLoadSummary | undefined): boolean {
  if (summary === undefined) return false
  const attributed = summary.load.devices.reduce((sum, d) => sum + d.attachedCameras, 0)
  return attributed >= summary.load.attachedCameras
}

function buildDevices(
  devices: readonly NodeInferenceDevice[],
  sessionsByKey: ReadonlyMap<string, number>,
  absentIsZero: boolean,
): readonly AcceleratorLoad[] {
  const eligible = devices.filter((d) => d.exclusion === null)
  const eligibleWeight = eligible.reduce((sum, d) => sum + (d.weight > 0 ? d.weight : 1), 0)
  const rows = devices.map((d): AcceleratorLoad => {
    const sessions = sessionsByKey.get(d.key) ?? (absentIsZero ? 0 : null)
    const weight = d.weight > 0 ? d.weight : 1
    return {
      key: d.key,
      label: acceleratorLabel(d),
      format: d.format,
      sessions,
      weight,
      weightSharePct: d.exclusion === null ? pct(weight, eligibleWeight) : null,
      maxSessions: d.maxSessions,
      atCap: d.maxSessions !== null && sessions !== null && sessions >= d.maxSessions,
      available: d.available,
      enabled: d.enabled,
      exclusion: d.exclusion,
    }
  })
  // In-rotation devices first (that is what the operator is reading for), then
  // the excluded ones with their reason — never hidden, they are the answer to
  // "why is my Coral idle".
  return rows.toSorted((a, b) => {
    if ((a.exclusion === null) !== (b.exclusion === null)) return a.exclusion === null ? -1 : 1
    return a.key.localeCompare(b.key)
  })
}

export function buildNodeLoadRows(input: NodeLoadInput): readonly NodeLoadRow[] {
  const loadByNode = new Map(input.loads.map((l) => [l.nodeId, l]))
  // Only the nodes `balance()` would rank share the weight denominator.
  const competing = input.nodes.filter((n) => n.isOnline && n.detectEnabled)
  const totalWeight = competing.reduce((sum, n) => sum + (n.weight > 0 ? n.weight : 1), 0)

  return input.nodes.map((node): NodeLoadRow => {
    const summary = loadByNode.get(node.id)
    const devices = input.devicesByNode[node.id] ?? []
    const sessionsByKey = new Map(
      (summary?.load.devices ?? []).map((d) => [d.deviceKey, d.attachedCameras]),
    )
    const deviceRows = buildDevices(devices, sessionsByKey, absenceMeansZero(summary))
    const competes = node.isOnline && node.detectEnabled
    const weight = node.weight > 0 ? node.weight : 1
    const attached = summary?.load.attachedCameras ?? null

    return {
      nodeId: node.id,
      name: node.name,
      isOnline: node.isOnline,
      detectEnabled: node.detectEnabled,
      reported: summary !== undefined,
      attachedCameras: attached,
      activeCameras: summary?.load.activeCameras ?? null,
      maxCameras: node.maxCameras,
      capacityPct:
        attached !== null && node.maxCameras !== null && node.maxCameras > 0
          ? pct(attached, node.maxCameras)
          : null,
      queueDepthTotal: summary?.load.queueDepthTotal ?? null,
      avgInferenceTimeMs: summary?.load.avgInferenceTimeMs ?? null,
      score: summary?.score ?? null,
      weight,
      weightSharePct: competes ? pct(weight, totalWeight) : null,
      decodeHwaccel: summary?.decodeHwaccel ?? null,
      devices: deviceRows,
      eligibleDeviceCount: deviceRows.filter((d) => d.exclusion === null).length,
    }
  })
}
