/**
 * The title of a group-window burst: how many of one kind, not the rule's name
 * and not the state-summary section.
 *
 * A section name describes the problem ("Offline or off", "Nodes with
 * problems") for both edges of that section. A burst whose members are all
 * one kind is titled from that kind, so a recovery (devices or nodes back
 * online) is never named as the outage. A mix of the two device edges, or of
 * the two node edges, keeps the mixed count. Anything else keeps the
 * state-summary title (the section names, or the rule name when the kind has
 * no section).
 */

export interface GroupWindowTitleChoice {
  readonly titleKey: string
  readonly count: number
  readonly offlineCount: number
  readonly onlineCount: number
}

/** One catalog key per kind a burst may be made of. Updates share one key. */
const KIND_TITLE: Readonly<Record<string, string>> = {
  'device-online': 'group.window.device-online',
  'camera-online': 'group.window.device-online',
  'device-offline': 'group.window.device-offline',
  'camera-offline': 'group.window.device-offline',
  'node-online': 'group.window.node-online',
  'node-offline': 'group.window.node-offline',
  'device-battery-low': 'group.window.device-battery-low',
  'device-consumable-low': 'group.window.device-consumable-low',
  'alert-critical': 'group.window.alert-critical',
  'alert-critical-resolved': 'group.window.alert-critical-resolved',
  'alert-error': 'group.window.alert-error',
  'addon-update-available': 'group.window.updates',
  'server-update-available': 'group.window.updates',
  'wrapper-update-available': 'group.window.updates',
}

const DEVICE_ONLINE_KEY = 'group.window.device-online'
const DEVICE_OFFLINE_KEY = 'group.window.device-offline'
const NODE_ONLINE_KEY = 'group.window.node-online'
const NODE_OFFLINE_KEY = 'group.window.node-offline'

/** `null` when any member has no per-kind title — the burst is not one shape. */
function titleKeysOf(kinds: readonly string[]): readonly string[] | null {
  const keys: string[] = []
  for (const kind of kinds) {
    const key = KIND_TITLE[kind]
    if (key === undefined) return null
    keys.push(key)
  }
  return keys
}

function sameKey(keys: readonly string[]): string | null {
  const first = keys[0]
  if (first === undefined) return null
  return keys.every((key) => key === first) ? first : null
}

function counted(titleKey: string, kinds: readonly string[]): GroupWindowTitleChoice {
  let offlineCount = 0
  let onlineCount = 0
  for (const kind of kinds) {
    const key = KIND_TITLE[kind]
    if (key === DEVICE_OFFLINE_KEY || key === NODE_OFFLINE_KEY) offlineCount += 1
    if (key === DEVICE_ONLINE_KEY || key === NODE_ONLINE_KEY) onlineCount += 1
  }
  return { titleKey, count: kinds.length, offlineCount, onlineCount }
}

function deviceEdgesOnly(keys: readonly string[]): boolean {
  return keys.every((key) => key === DEVICE_ONLINE_KEY || key === DEVICE_OFFLINE_KEY)
}

function nodeEdgesOnly(keys: readonly string[]): boolean {
  return keys.every((key) => key === NODE_ONLINE_KEY || key === NODE_OFFLINE_KEY)
}

/** `null` when the burst is not one of the titled shapes. */
export function groupWindowTitleChoice(kinds: readonly string[]): GroupWindowTitleChoice | null {
  const keys = titleKeysOf(kinds)
  if (keys === null || keys.length === 0) return null
  const uniform = sameKey(keys)
  if (uniform !== null) return counted(uniform, kinds)
  if (deviceEdgesOnly(keys)) return counted('group.window.device-mixed', kinds)
  if (nodeEdgesOnly(keys)) return counted('group.window.node-mixed', kinds)
  return null
}
