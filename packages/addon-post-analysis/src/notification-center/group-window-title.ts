/**
 * The title of a group-window burst: how many of one kind, not the rule's name.
 *
 * A burst that is only devices coming back, only devices going offline, or both,
 * and the same three shapes for nodes, and a burst that is only updates becoming
 * available, each has its own catalog key. Anything else keeps the state-summary
 * title, which names the sections.
 */

export interface GroupWindowTitleChoice {
  readonly titleKey: string
  readonly count: number
  readonly offlineCount: number
  readonly onlineCount: number
}

const DEVICE_ONLINE: ReadonlySet<string> = new Set(['device-online', 'camera-online'])
const DEVICE_OFFLINE: ReadonlySet<string> = new Set(['device-offline', 'camera-offline'])
const UPDATE_AVAILABLE: ReadonlySet<string> = new Set([
  'addon-update-available',
  'server-update-available',
  'wrapper-update-available',
])

interface KindTally {
  readonly deviceOnline: number
  readonly deviceOffline: number
  readonly nodeOnline: number
  readonly nodeOffline: number
  readonly updates: number
  readonly other: number
}

function tallyOf(kinds: readonly string[]): KindTally {
  let deviceOnline = 0
  let deviceOffline = 0
  let nodeOnline = 0
  let nodeOffline = 0
  let updates = 0
  let other = 0
  for (const kind of kinds) {
    if (DEVICE_ONLINE.has(kind)) deviceOnline += 1
    else if (DEVICE_OFFLINE.has(kind)) deviceOffline += 1
    else if (kind === 'node-online') nodeOnline += 1
    else if (kind === 'node-offline') nodeOffline += 1
    else if (UPDATE_AVAILABLE.has(kind)) updates += 1
    else other += 1
  }
  return { deviceOnline, deviceOffline, nodeOnline, nodeOffline, updates, other }
}

/** `null` when the burst is not one of the titled shapes. */
export function groupWindowTitleChoice(kinds: readonly string[]): GroupWindowTitleChoice | null {
  const tally = tallyOf(kinds)
  if (tally.other > 0) return null
  const devices = tally.deviceOnline + tally.deviceOffline
  const nodes = tally.nodeOnline + tally.nodeOffline
  const busy = [devices > 0, nodes > 0, tally.updates > 0].filter(Boolean).length
  if (busy !== 1) return null
  if (tally.updates > 0) {
    return {
      titleKey: 'group.window.updates',
      count: tally.updates,
      offlineCount: 0,
      onlineCount: 0,
    }
  }
  if (nodes > 0) {
    const mixed = tally.nodeOnline > 0 && tally.nodeOffline > 0
    return {
      titleKey: mixed
        ? 'group.window.node-mixed'
        : tally.nodeOnline > 0
          ? 'group.window.node-online'
          : 'group.window.node-offline',
      count: nodes,
      offlineCount: tally.nodeOffline,
      onlineCount: tally.nodeOnline,
    }
  }
  const mixed = tally.deviceOnline > 0 && tally.deviceOffline > 0
  return {
    titleKey: mixed
      ? 'group.window.device-mixed'
      : tally.deviceOnline > 0
        ? 'group.window.device-online'
        : 'group.window.device-offline',
    count: devices,
    offlineCount: tally.deviceOffline,
    onlineCount: tally.deviceOnline,
  }
}
