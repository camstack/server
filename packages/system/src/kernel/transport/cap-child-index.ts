import type { ChildCapDescriptor } from './child-cap-protocol.js'

/**
 * One connected child as the index reads it: its id and the cap manifest it
 * registered. A structural subset of `LocalChildRegistry`'s own child entry,
 * so the index can be built from `children.values()` directly and unit-tested
 * without a socket.
 */
export interface CapIndexEntry {
  readonly childId: string
  readonly caps: readonly ChildCapDescriptor[]
}

/**
 * The two questions `resolveChildId` asks, answered in O(1).
 *
 * Deliberately NOT "resolve a child": the operator's `setActiveSingleton`
 * preference is read at CALL time from the capability registry and can change
 * without any child connecting or leaving, so the index must not be allowed to
 * hold an answer that depends on it. It holds only what the `children` map
 * says, which is the same thing that invalidates it.
 */
export interface CapChildIndex {
  /** The FIRST child owning the exact `(capName, deviceId)` pair, or null. */
  deviceOwner(capName: string, deviceId: number): string | null
  /**
   * Every child owning a deviceId-LESS descriptor for `capName`, in children
   * insertion order (so `[0]` is the first-registered), each named once.
   */
  singletonCandidates(capName: string): readonly string[]
}

/** Separator that cannot occur in a kebab cap name, so the key is unambiguous. */
const DEVICE_KEY_SEPARATOR = '\u0000'

const NO_CANDIDATES: readonly string[] = Object.freeze([])

class MapCapChildIndex implements CapChildIndex {
  constructor(
    private readonly deviceOwners: ReadonlyMap<string, string>,
    private readonly singletons: ReadonlyMap<string, readonly string[]>,
  ) {}

  deviceOwner(capName: string, deviceId: number): string | null {
    return this.deviceOwners.get(`${capName}${DEVICE_KEY_SEPARATOR}${deviceId}`) ?? null
  }

  singletonCandidates(capName: string): readonly string[] {
    return this.singletons.get(capName) ?? NO_CANDIDATES
  }
}

/**
 * Build the `(cap, device?) → child` index from the connected children.
 *
 * A PURE function of what it is handed — it captures nothing, subscribes to
 * nothing and cannot be updated in place. That is the whole safety argument
 * (D3, D457): the only way to change what it says is to build a new one from
 * the `children` map, so an index can never name a child that map has already
 * dropped. An incremental index — add on register, remove on close — would be
 * a second registry that can disagree with the first, and a stale one routes
 * to a dead runner, which is strictly worse than a slow scan.
 *
 * Cost: O(children × descriptors), paid once per mutation of the children map
 * (a register, a re-register, a disconnect) rather than once per cap call.
 *
 * The two tiers stay separate, exactly as the scan had them: a device lookup
 * is never answered from a deviceId-less descriptor. `resolveChildId` owns
 * the fallback from tier 1 to tier 2, and folding it in here would make it
 * unreachable.
 */
export function buildCapChildIndex(entries: Iterable<CapIndexEntry>): CapChildIndex {
  const deviceOwners = new Map<string, string>()
  const singletons = new Map<string, string[]>()

  for (const entry of entries) {
    // A child that declares the same singleton cap twice was named ONCE by the
    // `caps.some(...)` scan this replaces; keep that, or `candidates[0]` and
    // the operator-preference match below it both see a duplicate.
    const namedForThisChild = new Set<string>()
    for (const cap of entry.caps) {
      if (cap.deviceId === undefined) {
        if (namedForThisChild.has(cap.capName)) continue
        namedForThisChild.add(cap.capName)
        const candidates = singletons.get(cap.capName)
        if (candidates === undefined) singletons.set(cap.capName, [entry.childId])
        else candidates.push(entry.childId)
        continue
      }
      const key = `${cap.capName}${DEVICE_KEY_SEPARATOR}${cap.deviceId}`
      // First child wins, like the scan's first match.
      if (!deviceOwners.has(key)) deviceOwners.set(key, entry.childId)
    }
  }

  return new MapCapChildIndex(deviceOwners, singletons)
}
