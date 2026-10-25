/**
 * Where each section of a STATE SUMMARY reads its state (D647) — the same
 * mirrors the instant raises read, and nothing else:
 *
 * | section | mirror |
 * | --- | --- |
 * | battery, consumables | the open alert episodes (`NcDeviceAlerts`, durable rows) |
 * | device-state | the liveness ledger (offline) + the system-state ledger (switched off) |
 * | streams, detection-blind, addons, addon-updates, updates | the system-state ledger |
 * | nodes | the liveness ledger (offline) + the system-state ledger (cannot infer) |
 *
 * Every source is RAM. A source that has not answered (its durable store never
 * read) makes the section UNAVAILABLE — never empty (D49/D315).
 *
 * A device offline for less than the liveness hold-off is left out: the instant
 * path would not have announced it yet either, and a summary must not report a
 * blip the rule itself would have stayed silent about.
 */
import { isAccessoryIdentity, type NcDeviceIdentity } from '../device-directory.js'
import type { NcLivenessRow } from '../liveness-ledger.js'
import type { NcSystemEventSubject } from '../rule-engine.js'
import type { NcOpenAlert } from '../alerts/open-alert.js'
import { HUB_NODE, type NcSystemStateRow } from './system-state-ledger.js'
import type {
  NcStateItem,
  NcStateItemNode,
  NcStateSectionId,
  NcStateSectionRead,
  NcStateSources,
} from './state-model.js'

export interface NcStateSourcePorts {
  /** `NcDeviceAlerts.openEpisodes`. */
  readonly alerts: () => readonly NcOpenAlert[] | null
  /** The liveness ledger's rows, or `null` while it has not loaded. */
  readonly liveness: () => readonly NcLivenessRow[] | null
  /** `NcSystemStateLedger.openRows`. */
  readonly state: () => readonly NcSystemStateRow[] | null
  readonly lookup: (deviceId: number) => NcDeviceIdentity | undefined
  /** Has the device directory ANSWERED once? Until then no device item is listed. */
  readonly devicesAnswered: () => boolean
  /**
   * The node directory, read for THIS summary (the D8 reconcile read), or
   * `null` when the read failed. Only a COMPLETE answer can say a node was
   * forgotten; an incomplete one makes the node sections unavailable.
   */
  readonly nodes: NcNodeView | null
  /** `DEVICE_LIVENESS_HOLDOFF_MS` in production. */
  readonly livenessHoldoffMs: number
}

/** The node directory as the summary reconciles against it. */
export interface NcNodeView {
  readonly complete: boolean
  /** `true`/`false` = the node is known and online/offline; `undefined` = not known (forgotten). */
  readonly online: (nodeId: string) => boolean | undefined
  /**
   * The node's name and whether it is the hub — the heading of a per-node
   * section (D708). Absent, or `undefined` for a node: the id is the name and
   * the hub is the node named `hub`.
   */
  readonly describe?: (
    nodeId: string,
  ) => { readonly name: string; readonly isHub: boolean } | undefined
}

const UNREAD_ALERTS = 'the battery / consumable ledger has not been read yet'
const UNREAD_LIVENESS = 'the liveness ledger has not been read yet'
const UNREAD_STATE = 'the system-state ledger has not been read yet'
const UNREAD_DEVICES = 'the device directory has not answered yet'
const UNREAD_NODES = 'the node directory did not answer completely'

/** Sections whose items name a node: the node directory must have answered. */
const NODE_SECTIONS: readonly NcStateSectionId[] = ['nodes', 'addons', 'addon-updates', 'updates']

/**
 * Sections worded ONE HEADING PER NODE (D708): an update is applied per node,
 * so "what is behind on the hub" and "what is behind on the agent" are read
 * as two lists. The lines under a heading no longer name the node.
 */
const PER_NODE_SECTIONS: readonly NcStateSectionId[] = ['addon-updates', 'updates']

function deviceParams(
  deviceId: number,
  identity: NcDeviceIdentity | undefined,
): Readonly<Record<string, string>> {
  const name = identity?.name ?? ''
  return { deviceId: String(deviceId), deviceName: name.length > 0 ? name : String(deviceId) }
}

function consumableSummaryLineKey(
  params: Readonly<Record<string, string>>,
  measured: boolean,
): string {
  const form = params['form'] ?? 'part'
  if (form === 'part') {
    return measured && params['percentage'] !== undefined
      ? 'summary.line.consumable.part'
      : 'summary.line.consumable.part.unmeasured'
  }
  if (form === 'tank') {
    return params['attention'] === 'full'
      ? 'summary.line.consumable.tank-full'
      : 'summary.line.consumable.tank'
  }
  if (form === 'product') return 'summary.line.consumable.product'
  return 'summary.line.consumable.bin'
}

function alertItem(
  section: NcStateSectionId,
  open: NcOpenAlert,
  lookup: NcStateSourcePorts['lookup'],
): NcStateItem {
  const params = open.subject.textParams ?? {}
  const lineKey =
    section === 'consumables'
      ? consumableSummaryLineKey(params, open.measured)
      : (open.subject.bodyKey ?? '')
  const lineParams =
    section === 'consumables' ? (({ deviceName: _deviceName, ...rest }) => rest)(params) : params
  const deviceId = open.subject.deviceId
  const identity = deviceId !== undefined ? lookup(deviceId) : undefined
  const deviceName =
    params['deviceName'] ??
    (identity !== undefined && identity.name.length > 0
      ? identity.name
      : deviceId !== undefined
        ? String(deviceId)
        : undefined)
  return {
    section,
    subject: open.subject,
    lineKey,
    params: lineParams,
    since: open.since,
    ...(section === 'consumables' && deviceId !== undefined && deviceName !== undefined
      ? { device: { id: deviceId, name: deviceName } }
      : {}),
  }
}

function livenessItem(
  row: NcLivenessRow,
  lookup: NcStateSourcePorts['lookup'],
): NcStateItem | null {
  if (row.subject.startsWith('node:')) {
    // A pre-R1-H1 build folded `worker.*` into `node-*` under
    // `node:<node>/<child>`. Those rows are never cleared by a later
    // `worker.online` (intake now produces no subject). Skip them here and
    // drop them from the ledger on hydrate (`forgetWorkerNodeSubjects`).
    if (row.subject.includes('/')) return null
    const nodeId = row.subject.slice('node:'.length)
    const subject: NcSystemEventSubject = {
      kind: 'node-offline',
      subject: row.subject,
      nodeId,
      textParams: { nodeId },
      data: {},
    }
    return {
      section: 'nodes',
      subject,
      lineKey: 'summary.line.node-offline',
      params: { nodeId },
      since: row.updatedAt,
    }
  }
  if (row.deviceId === undefined) return null
  const identity = lookup(row.deviceId)
  const params = deviceParams(row.deviceId, identity)
  const subject: NcSystemEventSubject = {
    kind: 'device-offline',
    subject: row.subject,
    deviceId: row.deviceId,
    ...(identity !== undefined ? { deviceType: identity.type } : {}),
    textParams: params,
    data: {},
  }
  return {
    section: 'device-state',
    subject,
    lineKey: 'summary.line.device-offline',
    params,
    since: row.updatedAt,
  }
}

/** The section and the line of an open system-state row. */
function stateLine(row: NcSystemStateRow): {
  readonly section: NcStateSectionId
  readonly lineKey: string
} {
  switch (row.kind) {
    case 'device-disabled':
      return { section: 'device-state', lineKey: 'summary.line.device-disabled' }
    case 'stream-offline':
      return {
        section: 'streams',
        lineKey:
          row.params['profile'] !== undefined
            ? 'summary.line.stream-offline.profiled'
            : 'summary.line.stream-offline',
      }
    case 'detection-blind':
      return { section: 'detection-blind', lineKey: 'summary.line.detection-blind' }
    case 'node-inference-unavailable':
      return { section: 'nodes', lineKey: 'summary.line.node-inference-unavailable' }
    case 'addon-crash-loop':
      return { section: 'addons', lineKey: 'summary.line.addon-crash-loop' }
    case 'wrapper-update-available':
      return { section: 'updates', lineKey: 'summary.line.wrapper-update' }
    case 'addon-update-available':
      // The node is the line's HEADING (D708), never part of the line.
      return { section: 'addon-updates', lineKey: 'summary.line.update' }
    default:
      return { section: 'updates', lineKey: 'summary.line.update' }
  }
}

/** The heading an item of a per-node section is listed under. */
function itemNode(nodeId: string | undefined, nodes: NcNodeView | null): NcStateItemNode {
  const id = nodeId ?? HUB_NODE
  const known = nodes?.describe?.(id)
  const name = known !== undefined && known.name.length > 0 ? known.name : id
  return { id, name, isHub: known?.isHub ?? id === HUB_NODE }
}

function stateItem(
  row: NcSystemStateRow,
  lookup: NcStateSourcePorts['lookup'],
  nodes: NcNodeView | null,
): NcStateItem {
  const identity = row.deviceId !== undefined ? lookup(row.deviceId) : undefined
  // The NAME is read again now — a device renamed since the state opened is
  // reported under the name the reader knows today.
  const params =
    row.deviceId !== undefined
      ? { ...row.params, ...deviceParams(row.deviceId, identity) }
      : row.params
  const deviceType = identity?.type ?? row.deviceType
  const subject: NcSystemEventSubject = {
    kind: row.kind,
    subject: row.key,
    ...(row.deviceId !== undefined ? { deviceId: row.deviceId } : {}),
    ...(deviceType !== undefined ? { deviceType } : {}),
    ...(row.nodeId !== undefined ? { nodeId: row.nodeId } : {}),
    ...(row.packageName !== undefined
      ? { packageName: row.packageName, packageNames: [row.packageName] }
      : {}),
    textParams: params,
    data: {},
  }
  const line = stateLine(row)
  return {
    ...line,
    subject,
    params,
    since: row.since,
    ...(PER_NODE_SECTIONS.includes(line.section) ? { node: itemNode(row.nodeId, nodes) } : {}),
  }
}

/**
 * THE RECONCILE (D647 review I2, D8): a ledger row is a memory, never the
 * truth. A device item is listed only while the device EXISTS in the directory
 * — and an "offline" one only while the device manager does not call it
 * online. A node item only while the node is known to a complete node
 * directory (a forgotten node is gone), and an "offline" one only while the
 * directory does not call it online.
 *
 * Accessories are silenced only on the liveness / switched-off section
 * (`device-state`). Battery and consumable alerts ride the SAME reconcile, and
 * a vacuum that is a child of its Dreame container (`parentDeviceId` set) still
 * owns those alerts — filtering every accessory here dropped consumable lines
 * on the 2026-10-05 evening summary for deviceId 4385 while the episode was
 * open.
 */
function stillTrue(item: NcStateItem, ports: NcStateSourcePorts): boolean {
  const deviceId = item.subject.deviceId
  if (deviceId !== undefined) {
    const identity = ports.lookup(deviceId)
    if (identity === undefined) return false
    if (item.section === 'device-state' && isAccessoryIdentity(identity)) return false
    if (item.subject.kind === 'device-offline' && identity.online === true) return false
  }
  const nodeId = item.subject.nodeId
  if (nodeId !== undefined && ports.nodes !== null) {
    const online = ports.nodes.online(nodeId)
    if (online === undefined) return false
    if (item.subject.kind === 'node-offline' && online) return false
  }
  return true
}

/** Why a section cannot be reconciled right now, or `null` when it can. */
function unreconcilable(section: NcStateSectionId, ports: NcStateSourcePorts): string | null {
  if (NODE_SECTIONS.includes(section) && (ports.nodes === null || !ports.nodes.complete)) {
    return UNREAD_NODES
  }
  if (!NODE_SECTIONS.includes(section) && !ports.devicesAnswered()) return UNREAD_DEVICES
  return null
}

/** The section, read and reconciled. */
function readSection(
  section: NcStateSectionId,
  ports: NcStateSourcePorts,
  nowMs: number,
): NcStateSectionRead {
  const blocked = unreconcilable(section, ports)
  if (blocked !== null) return { answered: false, reason: blocked }
  const read = readRaw(section, ports, nowMs)
  if (!read.answered) return read
  return { answered: true, items: read.items.filter((item) => stillTrue(item, ports)) }
}

/** Which ports a section needs, and why each one is unavailable. */
function readRaw(
  section: NcStateSectionId,
  ports: NcStateSourcePorts,
  nowMs: number,
): NcStateSectionRead {
  const needsAlerts = section === 'battery' || section === 'consumables'
  if (needsAlerts) {
    const alerts = ports.alerts()
    if (alerts === null) return { answered: false, reason: UNREAD_ALERTS }
    const family = section === 'battery' ? 'battery' : 'consumable'
    return {
      answered: true,
      items: alerts
        .filter((open) => open.family === family)
        .map((open) => alertItem(section, open, ports.lookup)),
    }
  }
  const state = ports.state()
  if (state === null) return { answered: false, reason: UNREAD_STATE }
  const items: NcStateItem[] = []
  if (section === 'device-state' || section === 'nodes') {
    const liveness = ports.liveness()
    if (liveness === null) return { answered: false, reason: UNREAD_LIVENESS }
    for (const row of liveness) {
      if (row.state !== 'offline' || nowMs - row.updatedAt < ports.livenessHoldoffMs) continue
      const item = livenessItem(row, ports.lookup)
      if (item !== null && item.section === section) items.push(item)
    }
  }
  for (const row of state) {
    const item = stateItem(row, ports.lookup, ports.nodes)
    if (item.section === section) items.push(item)
  }
  return { answered: true, items }
}

export function stateSources(ports: NcStateSourcePorts): NcStateSources {
  return { read: (section, nowMs) => readSection(section, ports, nowMs) }
}
