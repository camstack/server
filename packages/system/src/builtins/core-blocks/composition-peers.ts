/**
 * The stored compositions a save is judged against, as graph peers (D663,
 * ruling S2). Each is identified by its BLOCK ID, targets the device it writes
 * — `composedDeviceRef(block.id)` for a new device, the customized device for an
 * existing one — and, on an existing device, names the fields it REPLACES, so
 * its self-read of a replaced field is the native value and never an edge.
 *
 * `replaced` is not stored anywhere: it is recomputed at save time from the
 * peer's target description (`planComposition(..., target)`), read in the same
 * batch as the candidate's. A peer whose device could not be read has unknown
 * replaced fields: it is OVER-approximated — nothing replaced, every self-read
 * an edge (edges only added, never a cycle hidden) — and its device is listed
 * in `unread`, so the validator refuses a cyclic component only when it holds
 * a candidate node, and names the device (`findCandidateCycles`). An unreadable
 * device never blocks an unrelated save. A peer whose device is GONE is treated
 * the same way (M-1): a stored peer validated earlier may still read it, and
 * assuming every field replaced would remove edges.
 *
 * The candidate's own old version is kept in the list: the graph drops it BY ID
 * (`compositionEdges`), never by target — that is how a second block on
 * the same device reaches `duplicate-target`.
 */
import {
  type CapabilityLookup,
  type Composition,
  type CompositionPeer,
  type CompositionSourceRef,
  type CompositionTargetDescription,
  type CoreBlock,
  composedDeviceRef,
  compositionSourceKey,
  coreBlockComposition,
  planComposition,
  replacedFieldKeys,
} from '@camstack/types'

/** A stored composition block, with its composition parsed out. */
interface StoredComposition {
  readonly blockId: string
  readonly composition: Composition
}

export interface StoredPeers {
  readonly peers: readonly CompositionPeer[]
  /** `compositionSourceKey` → why, for each OTHER stored customization whose device could not be read. */
  readonly unread: ReadonlyMap<string, string>
}

function storedCompositions(blocks: readonly CoreBlock[]): readonly StoredComposition[] {
  return blocks.flatMap((block) => {
    const composition = coreBlockComposition(block)
    return composition === null ? [] : [{ blockId: block.id, composition }]
  })
}

/** The existing devices the stored customizations write — each read once with the candidate's. */
export function storedCustomizationTargets(
  blocks: readonly CoreBlock[],
): readonly CompositionSourceRef[] {
  return storedCompositions(blocks).flatMap(({ composition }) =>
    composition.target.kind === 'existing' ? [composition.target.device] : [],
  )
}

/** The fields a stored customization replaces, or why they are unknown. */
function replacedOf(
  stored: StoredComposition,
  description: CompositionTargetDescription | undefined,
  lookupCap: CapabilityLookup,
): ReadonlySet<string> | { readonly error: string } {
  if (description === undefined) return { error: 'it was not read' }
  if (description.kind === 'unreadable') return { error: description.error }
  if (description.kind === 'absent') return { error: 'the device does not exist' }
  return replacedFieldKeys(planComposition(stored.composition, lookupCap, description))
}

/** One stored composition as a peer, and its device's read error when it could not be read. */
interface PeerRead {
  readonly peer: CompositionPeer
  readonly unread: readonly [string, string] | null
}

function peerOf(
  stored: StoredComposition,
  targets: ReadonlyMap<string, CompositionTargetDescription>,
  lookupCap: CapabilityLookup,
  candidateBlockId: string | null,
): PeerRead {
  const { blockId, composition } = stored
  if (composition.target.kind === 'new')
    return { peer: { blockId, target: composedDeviceRef(blockId), composition }, unread: null }
  const device = composition.target.device
  const key = compositionSourceKey(device)
  const replaced = replacedOf(stored, targets.get(key), lookupCap)
  if (!('error' in replaced))
    return { peer: { blockId, target: device, composition, replaced }, unread: null }
  return {
    peer: { blockId, target: device, composition, replaced: new Set() },
    // The candidate's own old version is dropped by id: its unread device is the candidate's own refusal.
    unread: blockId === candidateBlockId ? null : [key, replaced.error],
  }
}

export function storedPeers(
  blocks: readonly CoreBlock[],
  targets: ReadonlyMap<string, CompositionTargetDescription>,
  lookupCap: CapabilityLookup,
  candidateBlockId: string | null,
): StoredPeers {
  const read = storedCompositions(blocks).map((stored) =>
    peerOf(stored, targets, lookupCap, candidateBlockId),
  )
  return {
    peers: read.map((r) => r.peer),
    unread: new Map(read.flatMap((r) => (r.unread === null ? [] : [r.unread]))),
  }
}
