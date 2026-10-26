/**
 * Describe what a composition reads and writes for SAVE-time validation
 * (D659, D663): one `listAll` per owning addon, one `getBindings` per found
 * device — shared by a device that is both a source and a target. A read that
 * fails makes the device `unreadable`, and the save is REFUSED rather than
 * stored unchecked. Refusing a save destroys nothing (D49).
 *
 * A SOURCE is described by the caps bound to it; an EXISTING TARGET by its row
 * type and each bound cap with the addon serving it — what `planComposition`
 * needs to tell a replace from an add (the composer reads it the same way, from
 * the same two reads: the slim row and `getBindings`).
 *
 * Devices are keyed by `{addonId, stableId}` — never a numeric device id,
 * which is this node's allocation and not the composition's identity.
 */
import {
  type CompositionSourceDescription,
  type CompositionSourceRef,
  type CompositionTargetDescription,
  compositionSourceKey,
  type DeviceType,
  errMsg,
  type ReadingQuantity,
} from '@camstack/types'

export interface SourceRowView {
  readonly id: number
  readonly stableId: string
  readonly type: DeviceType
  /** The device's stored quantity, when it declares one (D944 §4). */
  readonly quantity?: ReadingQuantity
}

/** One `getBindings` entry: the cap, and the addon serving it natively. */
export interface BoundCapView {
  readonly capName: string
  readonly nativeAddonId?: string | null
}

export interface CompositionSourcePorts {
  readonly listByAddon: (addonId: string) => Promise<readonly SourceRowView[]>
  readonly bindings: (deviceId: number) => Promise<readonly BoundCapView[]>
}

/** Every device a save reads, described once. Both maps are keyed by `compositionSourceKey`. */
export interface CompositionDescriptions {
  readonly sources: ReadonlyMap<string, CompositionSourceDescription>
  readonly targets: ReadonlyMap<string, CompositionTargetDescription>
}

type AddonListing = readonly SourceRowView[] | { readonly error: string }
type BindingsRead = readonly BoundCapView[] | { readonly error: string }

/** Blank binding owners are not native providers and must not turn ADD into REPLACE. */
export function normalizedNativeOwner(owner: string | null | undefined): string | null {
  const trimmed = owner?.trim()
  return trimmed ? trimmed : null
}

/** A device's row, or why there is none to describe. */
type RowLookup =
  | { readonly kind: 'row'; readonly row: SourceRowView }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly error: string }

async function listOwners(
  ports: CompositionSourcePorts,
  refs: readonly CompositionSourceRef[],
): Promise<ReadonlyMap<string, AddonListing>> {
  const addons = [...new Set(refs.map((r) => r.addonId))]
  const listed = await Promise.all(
    addons.map(async (addonId): Promise<readonly [string, AddonListing]> => {
      try {
        return [addonId, await ports.listByAddon(addonId)]
      } catch (err: unknown) {
        return [addonId, { error: errMsg(err) }]
      }
    }),
  )
  return new Map(listed)
}

function rowOf(ref: CompositionSourceRef, listing: AddonListing | undefined): RowLookup {
  if (listing === undefined)
    return { kind: 'unreadable', error: `\`${ref.addonId}\` was not listed` }
  if ('error' in listing) return { kind: 'unreadable', error: listing.error }
  const row = listing.find((r) => r.stableId === ref.stableId)
  return row === undefined ? { kind: 'absent' } : { kind: 'row', row }
}

/** ONE `getBindings` per found device, whether it is read as a source, a target, or both. */
async function readBindings(
  ports: CompositionSourcePorts,
  deviceIds: readonly number[],
): Promise<ReadonlyMap<number, BindingsRead>> {
  const read = await Promise.all(
    [...new Set(deviceIds)].map(async (deviceId): Promise<readonly [number, BindingsRead]> => {
      try {
        return [deviceId, await ports.bindings(deviceId)]
      } catch (err: unknown) {
        return [deviceId, { error: errMsg(err) }]
      }
    }),
  )
  return new Map(read)
}

function describeSource(
  lookup: RowLookup,
  bindings: ReadonlyMap<number, BindingsRead>,
): CompositionSourceDescription {
  if (lookup.kind !== 'row') return lookup
  const bound = bindings.get(lookup.row.id)
  if (bound === undefined) return { kind: 'unreadable', error: 'its bindings were not read' }
  if ('error' in bound) return { kind: 'unreadable', error: bound.error }
  return {
    kind: 'found',
    deviceId: lookup.row.id,
    caps: new Set(bound.map((b) => b.capName)),
    deviceType: lookup.row.type,
    ...(lookup.row.quantity === undefined ? {} : { quantity: lookup.row.quantity }),
  }
}

function describeTarget(
  lookup: RowLookup,
  bindings: ReadonlyMap<number, BindingsRead>,
): CompositionTargetDescription {
  if (lookup.kind !== 'row') return lookup
  const { id, type } = lookup.row
  const bound = bindings.get(id)
  if (bound === undefined) return { kind: 'unreadable', error: 'its bindings were not read' }
  if ('error' in bound) return { kind: 'unreadable', error: bound.error }
  return {
    kind: 'found',
    deviceId: id,
    type,
    nativeCaps: new Map(
      bound.flatMap((b) => {
        const owner = normalizedNativeOwner(b.nativeAddonId)
        return owner === null ? [] : [[b.capName, owner] as const]
      }),
    ),
  }
}

export async function describeCompositionSources(
  ports: CompositionSourcePorts,
  sources: readonly CompositionSourceRef[],
  targets: readonly CompositionSourceRef[] = [],
): Promise<CompositionDescriptions> {
  const owners = await listOwners(ports, [...sources, ...targets])
  const lookup = (ref: CompositionSourceRef): readonly [string, RowLookup] => [
    compositionSourceKey(ref),
    rowOf(ref, owners.get(ref.addonId)),
  ]
  const sourceRows = sources.map(lookup)
  const targetRows = targets.map(lookup)
  const bindings = await readBindings(
    ports,
    [...sourceRows, ...targetRows].flatMap(([, l]) => (l.kind === 'row' ? [l.row.id] : [])),
  )
  return {
    sources: new Map(sourceRows.map(([key, l]) => [key, describeSource(l, bindings)] as const)),
    targets: new Map(targetRows.map(([key, l]) => [key, describeTarget(l, bindings)] as const)),
  }
}
