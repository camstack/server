/**
 * OSD field pick whitelist — only sensor/state caps an overlay can usefully
 * show. Gateway metadata (broker, mqtt, deviceExport, featureProbe, …) is
 * never offered; climate exposes readouts, not every schema leaf.
 *
 * Containers may appear in DevicePicker, but their own runtime leaves are
 * never catalogued — the operator must pick an OSD-supported child first.
 */

import type { CapabilityDefinition } from '@camstack/types'
import { CAP_STATE_LEAVES } from '@camstack/types/addon'
import { type StateLeaf, stateLeavesOf } from './state-leaves.js'

/** Caps the OSD source picker may bind. */
export const OSD_SOURCE_CAP_NAMES: ReadonlySet<string> = new Set([
  'temperature-sensor',
  'humidity-sensor',
  'climate-control',
  'numeric-sensor',
  'weather',
  'air-quality-sensor',
  'lock-control',
  'contact',
  'binary',
  'battery',
])

/**
 * Per-cap leaf allowlist. Absent entry ⇒ every leaf from `stateLeavesOf`
 * that survives bookkeeping (single-metric sensors). Present ⇒ only these
 * paths (climate / weather / battery).
 */
const OSD_SOURCE_PATHS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    'climate-control',
    new Set(['currentTemp', 'currentHumidity', 'target', 'targetHumidity', 'mode']),
  ],
  [
    'weather',
    new Set(['condition', 'temperature', 'humidity', 'pressure', 'windSpeed', 'windBearing']),
  ],
  ['battery', new Set(['percentage'])],
  ['temperature-sensor', new Set(['celsius'])],
  ['humidity-sensor', new Set(['percent'])],
  ['numeric-sensor', new Set(['value'])],
  ['air-quality-sensor', new Set(['co2Ppm', 'vocPpb', 'pm25', 'pm10', 'aqi'])],
  ['binary', new Set(['on'])],
  ['contact', new Set(['entryOpen'])],
  ['lock-control', new Set(['state'])],
])

export function isOsdSourceCap(capName: string): boolean {
  return OSD_SOURCE_CAP_NAMES.has(capName)
}

/** The per-cap allowlist applied to a cap's state leaves. */
function allowedOsdLeaves(capName: string, leaves: readonly StateLeaf[]): readonly StateLeaf[] {
  if (!isOsdSourceCap(capName)) return []
  const allowed = OSD_SOURCE_PATHS.get(capName)
  if (allowed === undefined) return leaves
  return leaves.filter((leaf) => allowed.has(leaf.path))
}

/** Bindable OSD leaves for one cap — empty when the cap is not OSD-relevant. */
export function osdStateLeavesOf(cap: CapabilityDefinition): readonly StateLeaf[] {
  return allowedOsdLeaves(cap.name, stateLeavesOf(cap))
}

/**
 * Bindable OSD leaves by cap NAME, from the codegen'd schema-free table. This is
 * what the picker runs: reaching the leaves through a `CapabilityDefinition`
 * meant importing `ALL_CAPABILITY_DEFINITIONS`, i.e. the whole cap schema graph
 * (~+100 MB heap in the OSD runner, D28).
 */
export function osdStateLeavesByName(capName: string): readonly StateLeaf[] {
  return allowedOsdLeaves(capName, CAP_STATE_LEAVES[capName] ?? [])
}

/** Device types that never contribute their OWN catalog leaves. */
export const OSD_NON_LEAF_TYPES: ReadonlySet<string> = new Set(['container'])

/** True when this device type may expose OSD leaves (not a container gateway). */
export function isOsdLeafDeviceType(type: string | null | undefined): boolean {
  if (type === null || type === undefined) return true
  return !OSD_NON_LEAF_TYPES.has(type)
}

/** @deprecated Prefer {@link isOsdLeafDeviceType}. */
export const OSD_PICKER_EXCLUDED_TYPES = OSD_NON_LEAF_TYPES

/** @deprecated Prefer {@link isOsdLeafDeviceType}. */
export function isOsdPickerDeviceType(type: string | null | undefined): boolean {
  return isOsdLeafDeviceType(type)
}

export function isContainerDeviceType(type: string | null | undefined): boolean {
  return type === 'container'
}
