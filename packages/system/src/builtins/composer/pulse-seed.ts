/**
 * What `lastPressedAt` is at the start of a pulse override (D938).
 *
 * The stored formula stays `latest(rose(...))` — the seed is not an argument
 * of `rose` or `latest`, so compile/decode stay a round trip (D936). A stamp
 * this block already claimed is kept. Anything else comes from the source,
 * and a read that failed is not a seed and not "no ring" (D49).
 */

export interface PulseHistoryPoint {
  readonly t: number
  readonly on: boolean
}

export type PulseHistoryRead =
  | { readonly kind: 'unread' }
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'series'
      readonly beforeOn: boolean | null
      readonly points: readonly PulseHistoryPoint[]
    }

export type PulseSourceLevel =
  | { readonly kind: 'unread' }
  | { readonly kind: 'off'; readonly changedAt: number | null }
  | { readonly kind: 'on'; readonly changedAt: number | null }

/** What this block already wrote. `none` means it holds no claim. */
export type OwnedPulse =
  | { readonly kind: 'none' }
  | { readonly kind: 'never' }
  | { readonly kind: 'stamp'; readonly at: number; readonly count: number }

export interface PulseSeedFacts {
  readonly owned: OwnedPulse
  /** The target's native `lastPressedAt`. Compared only with a changed-at bound. */
  readonly nativeStamp: number | null
  readonly history: PulseHistoryRead
  readonly level: PulseSourceLevel
}

export type PulseStampDecision =
  | { readonly kind: 'keep' }
  | { readonly kind: 'hold'; readonly reason: string }
  | { readonly kind: 'none'; readonly count: number }
  | {
      readonly kind: 'stamp'
      readonly at: number
      readonly count: number
      readonly via: 'history' | 'changed-at-bound'
    }

/** What one field's record is seeded with. `keep` leaves the boot slice alone. */
export type PulseFieldSeed =
  | { readonly kind: 'keep' }
  | { readonly kind: 'hold' }
  | { readonly kind: 'value'; readonly value: number | null }

type Proof =
  | { readonly kind: 'hold'; readonly reason: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'rise'; readonly at: number; readonly via: 'history' | 'changed-at-bound' }

/** The last false→true in time order. A series that opens already on is not a transition. */
export function lastOffToOn(
  points: readonly PulseHistoryPoint[],
  beforeOn: boolean | null,
): number | null {
  const ordered = [...points].toSorted((a, b) => a.t - b.t)
  let previous = beforeOn
  let rise: number | null = null
  for (const point of ordered) {
    if (previous === false && point.on && Number.isFinite(point.t)) rise = point.t
    previous = point.on
  }
  return rise
}

function finite(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null
}

/**
 * What the source proves. A failed read is `hold`, never `none`.
 * When the source records no history and it is off, `lastChangedAt` is the
 * end of the last ring: it bounds the ring from above (the press was at or
 * before that instant). It is used only when it is newer than the target's
 * native stamp — an older bound does not prove the native value.
 */
function proof(facts: PulseSeedFacts): Proof {
  if (facts.history.kind === 'unread') return { kind: 'hold', reason: 'history-unread' }
  if (facts.history.kind === 'series') {
    const at = lastOffToOn(facts.history.points, facts.history.beforeOn)
    return at === null ? { kind: 'none' } : { kind: 'rise', at, via: 'history' }
  }
  if (facts.level.kind === 'unread') return { kind: 'hold', reason: 'level-unread' }
  const changedAt = facts.level.kind === 'off' ? finite(facts.level.changedAt) : null
  const newerThanNative =
    changedAt !== null && (facts.nativeStamp === null || changedAt > facts.nativeStamp)
  if (changedAt !== null && newerThanNative) {
    return { kind: 'rise', at: changedAt, via: 'changed-at-bound' }
  }
  return { kind: 'none' }
}

function claimed(owned: OwnedPulse): boolean {
  return owned.kind === 'stamp' || owned.kind === 'never'
}

export function decidePulseSeed(facts: PulseSeedFacts): PulseStampDecision {
  const proved = proof(facts)
  if (proved.kind === 'hold') {
    return claimed(facts.owned) ? { kind: 'keep' } : proved
  }
  if (proved.kind === 'rise') {
    if (facts.owned.kind === 'stamp' && facts.owned.at >= proved.at) return { kind: 'keep' }
    const count = facts.owned.kind === 'stamp' ? facts.owned.count : 0
    return { kind: 'stamp', at: proved.at, count, via: proved.via }
  }
  return claimed(facts.owned) ? { kind: 'keep' } : { kind: 'none', count: 0 }
}

/** One failed source blocks "no ring". A rise from another source still stands. */
export function mergePulseDecisions(decisions: readonly PulseStampDecision[]): PulseStampDecision {
  if (decisions.length === 0) return { kind: 'none', count: 0 }
  const stamps = decisions.flatMap((decision) => (decision.kind === 'stamp' ? [decision] : []))
  if (stamps.length > 0) {
    return stamps.reduce((best, next) => (next.at > best.at ? next : best))
  }
  const hold = decisions.find((decision) => decision.kind === 'hold')
  if (hold !== undefined) return hold
  if (decisions.some((decision) => decision.kind === 'keep')) return { kind: 'keep' }
  return { kind: 'none', count: 0 }
}
