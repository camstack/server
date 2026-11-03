/**
 * The two per-instance settings of the export, `exportTo` and `mediaRole` (D985), and how the
 * addon's settings form reaches them. The form still names them as the dynamic keys
 * `exportTo:<brokerId>` / `mediaRole:<brokerId>`; a write peels those keys off and sends each to
 * the integration that links its broker, and a read overlays the integration's values on the form.
 * A key whose broker has no integration stays in the addon store, so a switch always has somewhere
 * to land.
 */
import type { HaInstanceRow } from '../ha-instance-settings.js'
import { mediaRoleKey } from './media-url.js'

export type InstanceFlag = 'exportTo' | 'mediaRole'

const exportKey = (brokerId: string): string => `exportTo:${brokerId}`
const KEYS: readonly { readonly flag: InstanceFlag; readonly keyOf: (id: string) => string }[] = [
  { flag: 'exportTo', keyOf: exportKey },
  { flag: 'mediaRole', keyOf: mediaRoleKey },
]

export interface SplitPatch {
  /** integrationId → the flags to merge into its settings. */
  readonly toInstances: ReadonlyMap<string, Readonly<Record<string, unknown>>>
  /** Everything else, including the keys of a broker without an integration. */
  readonly rest: Readonly<Record<string, unknown>>
}

export function splitInstanceKeys(
  patch: Readonly<Record<string, unknown>>,
  instances: readonly HaInstanceRow[],
): SplitPatch {
  const claimed = new Set<string>()
  const toInstances = new Map<string, Record<string, unknown>>()
  for (const row of instances) {
    if (row.brokerId === null) continue
    for (const { flag, keyOf } of KEYS) {
      const key = keyOf(row.brokerId)
      if (!(key in patch)) continue
      claimed.add(key)
      toInstances.set(row.integrationId, {
        ...toInstances.get(row.integrationId),
        [flag]: patch[key],
      })
    }
  }
  return {
    toInstances,
    rest: Object.fromEntries(Object.entries(patch).filter(([key]) => !claimed.has(key))),
  }
}

/** The form's dynamic keys carrying each instance's own value. */
export function instanceOverlay(instances: readonly HaInstanceRow[]): Record<string, unknown> {
  const overlay: Record<string, unknown> = {}
  for (const row of instances) {
    if (row.brokerId === null) continue
    for (const { flag, keyOf } of KEYS) {
      const value = row.settings[flag]
      if (value !== undefined) overlay[keyOf(row.brokerId)] = value
    }
  }
  return overlay
}
