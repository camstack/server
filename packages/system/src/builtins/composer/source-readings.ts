/**
 * What the source tracker reads and holds (D659, D663): the hub ports it reads
 * through, the requests it tracks, and one reading per (cap, view) — plus the
 * pure helpers over them. Split from `source-tracker.ts` so that file holds the
 * behaviour; every public name is re-exported from there.
 */
import {
  type CompositionSourceRef,
  type DeviceType,
  type EventCatalog,
  type IScopedLogger,
} from '@camstack/types'
import { isRecord } from '../shared/device-state-changed.js'

/** One row of the slim device listing: what resolves a `(addonId, stableId)` ref and types an existing target. */
export interface SourceRow {
  readonly id: number
  readonly stableId: string
  readonly type: DeviceType
}
export interface SourceRowsRead {
  readonly kind: 'rows'
  readonly rows: readonly SourceRow[]
}
export interface SourceUnreadable {
  readonly kind: 'unreadable'
  readonly error: string
}
export type SourceListRead = SourceRowsRead | SourceUnreadable
export interface SliceFound {
  readonly kind: 'slice'
  readonly slice: Readonly<Record<string, unknown>>
}
export interface SliceNone {
  readonly kind: 'none'
}
export type SliceRead = SliceFound | SliceNone | SourceUnreadable
/** The caps bound on a device, each with the addon serving it natively (`getBindings`, one read). */
export interface BoundCaps {
  readonly kind: 'caps'
  readonly caps: ReadonlyMap<string, string>
}
export type BoundCapsRead = BoundCaps | SourceUnreadable

/** Which slice of a cap is read: what every consumer sees, or what the provider wrote (the shadow under a claim, D663). */
export type SliceView = 'effective' | 'native'

export interface SourceTrackerPorts {
  readonly logger: IScopedLogger
  /** `deviceManager.listAll({ addonId, projection: 'slim' })`: one call per owning addon per pass. */
  readonly listDevicesOf: (addonId: string) => Promise<SourceListRead>
  /** `deviceState.getCapSlice` for the effective view; `deviceState.getNativeCapSlice` for the native one. */
  readonly readSlice: (deviceId: number, capName: string, view: SliceView) => Promise<SliceRead>
  readonly readBoundCaps: (deviceId: number) => Promise<BoundCapsRead>
}

/** Why a `device.bindings-changed` fired — the catalog's own closed union. */
export type SourceBindingsChangeReason = EventCatalog['device.bindings-changed']['reason']

export interface TrackedSourceRequest {
  readonly ref: CompositionSourceRef
  /** Caps read in the effective view — what every consumer sees. */
  readonly caps: readonly string[]
  /** Caps of the REF read in the NATIVE view: the target's own replaced or uncomposed fields (rule 6). */
  readonly nativeCaps?: readonly string[]
  /** The block whose own claims decide whether `device.state-changed` of a native cap is the native (N-7). */
  readonly nativeOwner?: string
}

/** How a `(addonId, stableId)` ref resolves against the device index. */
export interface SourceFound {
  readonly kind: 'found'
  readonly deviceId: number
  readonly type: DeviceType
}
export interface SourceMissing {
  readonly kind: 'missing'
  readonly reason: string
}
export interface SourceUnknown {
  readonly kind: 'unknown'
  readonly error: string
}
export type SourceResolution = SourceFound | SourceMissing | SourceUnknown

export interface CapSlice {
  readonly kind: 'slice'
  readonly slice: Readonly<Record<string, unknown>>
  readonly staleReason: string | null
}
export interface CapNoValue {
  readonly kind: 'none'
  readonly reason: string
  /** An ANSWER — the provider unregistered the cap and a bindings re-read agreed — not an empty or first read (D49). */
  readonly confirmed: boolean
}
/** Not bound on a device whose row exists: non-fatal, healed by `native-registered` (R7b). */
export interface CapUnbound {
  readonly kind: 'unbound'
  readonly reason: string
}
/** Nothing is known: the read failed with no value held, or read empty under a held claim. Re-read by the next `sync` (D49). */
export interface CapUnread {
  readonly kind: 'unread'
  readonly reason: string
}
export type CapReading = CapSlice | CapNoValue | CapUnbound | CapUnread

/** One cap in one view — the unit a reading is held for. */
export interface CapEntry {
  readonly cap: string
  readonly view: SliceView
}

export interface TrackedSource {
  readonly ref: CompositionSourceRef
  readonly deviceId: number | null
  readonly type: DeviceType | null
  readonly missingReason: string | null
  /** The index could not be read the last time: retried on the next apply. */
  readonly indexError: string | null
  readonly online: boolean | null
  /** Keyed by `entryKey`: an effective and a native reading of one cap are two entries. */
  readonly caps: ReadonlyMap<string, CapReading>
  /** Whose claims decide what a `device.state-changed` is for the native-view caps; null: nobody claims here. */
  readonly nativeOwner: string | null
}

export interface Absent {
  readonly kind: 'absent'
}
export type RowVerdict = SourceFound | Absent | SourceUnknown
export type Resolution = SourceFound | SourceMissing | SourceUnknown
export type BindingVerdict = 'bound' | 'unbound' | 'unknown'

export const DEVICE_STATUS_CAP = 'device-status'
export const NATIVE_SUFFIX = '@native'
export const NO_CAPS: readonly string[] = []

export function entryKey(entry: CapEntry): string {
  return entry.view === 'native' ? `${entry.cap}${NATIVE_SUFFIX}` : entry.cap
}

export function entryOf(key: string): CapEntry {
  return key.endsWith(NATIVE_SUFFIX)
    ? { cap: key.slice(0, -NATIVE_SUFFIX.length), view: 'native' }
    : { cap: key, view: 'effective' }
}

export function entriesOf(request: TrackedSourceRequest): readonly CapEntry[] {
  return [
    ...request.caps.map((cap): CapEntry => ({ cap, view: 'effective' })),
    ...(request.nativeCaps ?? NO_CAPS).map((cap): CapEntry => ({ cap, view: 'native' })),
  ]
}

export function valueAtPath(slice: Readonly<Record<string, unknown>>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((node, segment) => (isRecord(node) ? node[segment] : undefined), slice)
}

export function onlineOf(slice: Readonly<Record<string, unknown>>): boolean | null {
  const online = slice['online']
  return typeof online === 'boolean' ? online : null
}

export function findRow(read: SourceListRead, stableId: string): RowVerdict {
  if (read.kind === 'unreadable') return { kind: 'unknown', error: read.error }
  const row = read.rows.find((r) => r.stableId === stableId)
  return row === undefined
    ? { kind: 'absent' }
    : { kind: 'found', deviceId: row.id, type: row.type }
}

export function resolutionOf(source: TrackedSource): SourceResolution {
  if (source.missingReason !== null) return { kind: 'missing', reason: source.missingReason }
  if (source.deviceId !== null && source.type !== null)
    return { kind: 'found', deviceId: source.deviceId, type: source.type }
  return {
    kind: 'unknown',
    error: source.indexError ?? 'the device index has not been read for it yet',
  }
}
