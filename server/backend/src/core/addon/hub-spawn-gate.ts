/**
 * The hub's spawn gate for a stale addon package (planning#447, D989).
 *
 * An agent already holds an addon back when its package is below what the
 * running server requires (`agent/stale-addon-gate.ts`, #346). The hub planned
 * every addon it found on disk, so after a server swap an addon built for the
 * previous framework was spawned, crashed, and burned the D6 respawn budget
 * before the post-swap update reached it. The hub now asks the SAME gate before
 * it plans a runner: a held-back addon stays unspawned, is logged with both
 * versions, and is not part of the plan.
 */
import type { GroupCandidate } from '../../agent/agent-group-runner.js'
import { gateStaleCandidates, type StaleGateContext } from '../../agent/stale-addon-gate.js'

export interface HubSpawnGateInput {
  readonly addonIds: readonly string[]
  /** The candidate view of one addon; `undefined` for an id the registry does not hold. */
  readonly candidateOf: (addonId: string) => GroupCandidate | undefined
  readonly context: StaleGateContext
  readonly log: (line: string) => void
}

/** The ids of `addonIds` that may be spawned; every held-back one is logged. */
export function spawnableAddonIds(input: HubSpawnGateInput): readonly string[] {
  const candidates: GroupCandidate[] = []
  const known = new Set<string>()
  for (const id of input.addonIds) {
    const candidate = input.candidateOf(id)
    if (candidate === undefined) continue
    known.add(id)
    candidates.push(candidate)
  }
  const { ready, deferred } = gateStaleCandidates(candidates, input.context)
  for (const d of deferred) input.log(d.reason)
  const readyIds = new Set(ready.map((c) => c.addonId))
  // An id the registry cannot describe is not this gate's to judge: keep it, the plan drops it as before.
  return input.addonIds.filter((id) => readyIds.has(id) || !known.has(id))
}
