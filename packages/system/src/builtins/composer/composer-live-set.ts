/**
 * Pure reads of the composer's live set: which sources it must track, which
 * sources an operator action re-opens, and which claims it still WANTS.
 * Nothing here touches a port; the composer acts on the answers.
 */
import { compositionSourceKey } from '@camstack/types'
import { type ClaimGate, type ClaimKey, claimKey } from './claim-gate.js'
import type { PlannedBlock } from './composer-plan.js'
import type { LiveComposition } from './composer-verdict.js'
import { selfReadCaps } from './existing-target.js'
import type { TrackedSourceRequest } from './source-tracker.js'

/** A release answered with one of these hands back nothing of ours: the gate forgets the claim. */
export const RELEASE_SETTLED_CODES: ReadonlySet<string> = new Set([
  'not-claimed',
  'unknown-device',
  'owned-by-other',
])

/**
 * The source keys an operator action on `p` re-opens: every source its fields
 * read, except its own target (re-resolved by `planExisting` already, never
 * twice).
 */
export function operatorResetKeys(p: PlannedBlock): readonly string[] {
  const targetKey = p.target.kind === 'existing' ? compositionSourceKey(p.target.ref) : null
  const keys: string[] = []
  for (const f of p.fields)
    for (const r of f.reads) {
      const key = compositionSourceKey(r.source)
      if (key !== targetKey) keys.push(key)
    }
  return keys
}

/** Every source the live set reads, with the view each own cap is read in. */
export function trackedSourceRequests(
  live: Iterable<LiveComposition>,
): readonly TrackedSourceRequest[] {
  const requests: TrackedSourceRequest[] = []
  for (const e of live) {
    const target = e.planned.target
    const running = e.runtime !== null && e.planned.block.enabled
    let targetKey: string | null = null
    if (target.kind === 'existing') {
      // The target stays tracked whatever the block does: its resolution is
      // what tells a gone row (rule 5), and its own caps are read in the view
      // rule 6 says.
      targetKey = compositionSourceKey(target.ref)
      const self = running ? selfReadCaps(e.planned.fields, target.ref, target.features) : null
      requests.push({
        ref: target.ref,
        caps: self?.effective ?? [],
        nativeCaps: self?.native ?? [],
        nativeOwner: e.planned.block.id,
      })
    }
    if (!running) continue
    for (const f of e.planned.fields)
      for (const r of f.reads)
        if (compositionSourceKey(r.source) !== targetKey)
          requests.push({ ref: r.source, caps: [r.cap] })
  }
  return requests
}

/**
 * Rule 3: the claims every live customization WANTS this apply; everything
 * else the gate knows is a release candidate, handed back once two applies
 * agree. A block that cannot plan — waiting, unreadable, failed, or with its
 * target gone — HOLDS its claims (rule 4, rule 5): they are wanted as they
 * are. A disabled block wants none (rule 7).
 */
export function wantedClaims(
  live: ReadonlyMap<string, LiveComposition>,
  claimGate: Pick<ClaimGate, 'claimsOf'>,
): readonly ClaimKey[] {
  const wanted: ClaimKey[] = []
  const held: string[] = []
  for (const [blockId, entry] of live) {
    const target = entry.planned.target
    if (target.kind === 'new') continue
    if (
      target.kind === 'unreadable' ||
      entry.planned.problems.length > 0 ||
      target.waiting !== null ||
      target.gone !== null ||
      target.deviceId === null
    ) {
      held.push(blockId)
      continue
    }
    if (!entry.planned.block.enabled) continue
    const deviceId = target.deviceId
    for (const f of target.features) wanted.push({ deviceId, capName: f.cap, owner: blockId })
  }
  for (const owner of held) wanted.push(...claimGate.claimsOf(owner))
  return wanted
}

/**
 * Claims an operator has already confirmed are no longer wanted: a deleted
 * block (`retiredBlockIds`), or a cap an edit dropped. Released on this apply,
 * not after a second one — a missing block in a single snapshot is still the
 * two-apply gate (`wantedClaims`). A disabled block is not here: its runtime
 * hands the fields back itself.
 */
export function confirmedReleaseKeys(
  retiredBlockIds: readonly string[],
  planned: readonly PlannedBlock[],
  previous: ReadonlyMap<string, LiveComposition>,
  claimGate: Pick<ClaimGate, 'claimsOf'>,
): readonly ClaimKey[] {
  const retired = new Set(retiredBlockIds)
  const seen = new Set<string>()
  const keys: ClaimKey[] = []
  const push = (key: ClaimKey): void => {
    const id = claimKey(key)
    if (seen.has(id)) return
    seen.add(id)
    keys.push(key)
  }
  for (const owner of retired) for (const key of claimGate.claimsOf(owner)) push(key)
  const plannedById = new Map(planned.map((block) => [block.block.id, block]))
  for (const [blockId, entry] of previous) {
    if (retired.has(blockId)) continue
    const next = plannedById.get(blockId)
    if (next === undefined || !next.block.enabled) continue
    if (entry.planned.block.updatedAt === next.block.updatedAt) continue
    for (const key of claimGate.claimsOf(blockId)) {
      if (!planStillWantsClaim(next, key)) push(key)
    }
  }
  return keys
}

/** True when this plan still holds `key` — including while the plan cannot say, so a bad read releases nothing. */
function planStillWantsClaim(planned: PlannedBlock, key: ClaimKey): boolean {
  const target = planned.target
  if (target.kind !== 'existing') return false
  if (
    target.waiting !== null ||
    target.gone !== null ||
    target.deviceId === null ||
    planned.problems.length > 0
  ) {
    return true
  }
  return (
    target.deviceId === key.deviceId &&
    target.features.some((feature) => feature.cap === key.capName)
  )
}
