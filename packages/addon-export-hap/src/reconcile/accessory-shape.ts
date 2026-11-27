/**
 * The SHAPE of a HomeKit accessory: every input that decides what the accessory
 * advertises, reduced to one key.
 *
 * An accessory is built once and rebuilt only when its key moves. Until now the
 * key covered the device TYPE, its persisted FEATURES and the recording slot —
 * but the camera builder picks the HAP category and the Doorbell service from
 * the device's BINDINGS (`capNames.has('doorbell')`). A doorbell grafted by a
 * composition block binds after a hub boot built the accessory, the persisted
 * features already said `doorbell-button`, so the key never moved and the
 * accessory stayed a plain IP camera that dropped every ring (615, 2026-11).
 *
 * The rule this module carries: **whatever a mapper branches on is an input of
 * {@link accessoryShapeKey}, and the live accessory keeps the inputs it was BUILT
 * from**, so a later change of any of them — a cap bound or unbound, a role, a
 * rename — rebuilds it, and nothing else does.
 */
import { canonicalHash } from '@camstack/types/node'

import { withRecordabilityToken } from '../hksv/recordability-token.js'
import { hapExportableCapNames } from '../mappers/builders/generic/cap-service-table.js'
import type { MapperKind } from '../mappers/kind.js'

/**
 * Every binding a camera accessory branches on (`mappers/camera-accessory.ts`):
 * the category and Doorbell service, the intercom, HKSV motion + the motion
 * sensor, the PTZ switches, the battery service and the privacy switch.
 * A cap added there and not here is a shape the accessory never rebuilds into.
 */
export const CAMERA_SHAPE_CAPS: ReadonlySet<string> = new Set([
  'doorbell',
  'intercom',
  'motion-detection',
  'ptz',
  'ptz-autotrack',
  'battery',
  'privacy-mask',
])

/** What a mapper reports about the accessory it built — the inputs only the build saw. */
export interface MapperShapeReport {
  /** The bound caps the build branched on, already narrowed by {@link shapeCapsFor}. */
  readonly caps: readonly string[]
  /** The role the build read (generic accessories only; `null` for a camera). */
  readonly role: string | null
}

/** Every input of an accessory's shape. */
export interface AccessoryShapeInputs {
  readonly kind: MapperKind
  readonly deviceType: string
  readonly features: readonly string[]
  /** Shape-relevant bound caps ({@link shapeCapsFor}). */
  readonly caps: readonly string[]
  readonly role: string | null
  /** The accessory's HomeKit name (the bridge's exposed name, else the device name). */
  readonly name: string
}

/** A shape with its recording token: what one accessory was (or would be) built from. */
export interface AccessoryShape {
  readonly inputs: AccessoryShapeInputs
  /** `recordabilityTokenFor`'s answer; `null` = the profiles were unreadable. */
  readonly recordability: string | null
}

/** What one live accessory was built from, with the key that shape had then. */
export interface BuiltAccessoryShape {
  readonly shape: AccessoryShape
  readonly key: string
}

/** The caps of `bound` that change a `kind` accessory's shape, sorted. */
export function shapeCapsFor(kind: MapperKind, bound: Iterable<string>): readonly string[] {
  const relevant = kind === 'camera' ? CAMERA_SHAPE_CAPS : hapExportableCapNames()
  return [...new Set([...bound].filter((cap) => relevant.has(cap)))].toSorted()
}

/** Normalise the inputs: order and duplicates never move the key. */
export function normaliseShapeInputs(inputs: AccessoryShapeInputs): AccessoryShapeInputs {
  return {
    ...inputs,
    features: [...new Set(inputs.features)].toSorted(),
    caps: [...new Set(inputs.caps)].toSorted(),
  }
}

/**
 * The key of a shape. `persisted` is the key last advertised for the device:
 * an unreadable recording token is carried forward from it (see
 * `withRecordabilityToken`), never invented.
 */
export function accessoryShapeKey(shape: AccessoryShape, persisted?: string): string {
  return withRecordabilityToken({
    base: canonicalHash(normaliseShapeInputs(shape.inputs)),
    token: shape.recordability,
    persisted,
  })
}

/**
 * Which inputs differ between the shape an accessory was built from and the
 * shape it would be built from now, named for the log line (`caps +doorbell`,
 * `name`, …). Empty when only the key moved without a named input (never in
 * practice: every input is listed).
 */
export function describeShapeChange(built: AccessoryShape, current: AccessoryShape): string[] {
  const a = normaliseShapeInputs(built.inputs)
  const b = normaliseShapeInputs(current.inputs)
  const changes: string[] = []
  if (a.kind !== b.kind) changes.push(`kind ${a.kind}→${b.kind}`)
  if (a.deviceType !== b.deviceType) changes.push(`deviceType ${a.deviceType}→${b.deviceType}`)
  changes.push(...listDelta('features', a.features, b.features))
  changes.push(...listDelta('caps', a.caps, b.caps))
  if (a.role !== b.role) changes.push(`role ${a.role ?? 'none'}→${b.role ?? 'none'}`)
  if (a.name !== b.name) changes.push('name')
  if (current.recordability !== null && built.recordability !== current.recordability) {
    changes.push(`recordability ${built.recordability ?? 'unread'}→${current.recordability}`)
  }
  return changes
}

function listDelta(label: string, from: readonly string[], to: readonly string[]): string[] {
  const added = to.filter((x) => !from.includes(x)).map((x) => `+${x}`)
  const removed = from.filter((x) => !to.includes(x)).map((x) => `-${x}`)
  const delta = [...added, ...removed]
  return delta.length === 0 ? [] : [`${label} ${delta.join(',')}`]
}

/**
 * True when the only difference between the built shape and the current one is
 * features or caps that are GONE now (a recordability change may ride along: the
 * profiles of a device whose graft is down read differently) — nothing added,
 * renamed or re-roled. A
 * composed cap that is briefly unbound at a boot looks exactly like this, so
 * the reconcile confirms it before it strips a live accessory.
 */
export function isRemovalOnly(built: AccessoryShape, current: AccessoryShape): boolean {
  const a = normaliseShapeInputs(built.inputs)
  const b = normaliseShapeInputs(current.inputs)
  if (a.kind !== b.kind || a.deviceType !== b.deviceType) return false
  if (a.role !== b.role || a.name !== b.name) return false
  const keeps = (from: readonly string[], to: readonly string[]): boolean =>
    to.every((x) => from.includes(x))
  const removed = a.features.length - b.features.length + (a.caps.length - b.caps.length) > 0
  return keeps(a.features, b.features) && keeps(a.caps, b.caps) && removed
}
