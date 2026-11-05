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
import * as path from 'node:path'
import type { GroupCandidate } from '../../agent/agent-group-runner.js'
import {
  gateStaleCandidates,
  readPackageRequires,
  type StaleGateContext,
} from '../../agent/stale-addon-gate.js'
import { readRunningServerAddonMinimums, readRunningServerVersion } from './addon-requirements.js'
import { readInstalledAddonVersions } from './installed-addon-versions.js'

export interface HubSpawnGateInput {
  readonly addonIds: readonly string[]
  /** The candidate view of one addon; `undefined` for an id the registry does not hold. */
  readonly candidateOf: (addonId: string) => GroupCandidate | undefined
  readonly context: StaleGateContext
  /**
   * Capability names whose provider the node cannot run without (storage, the
   * data engine): such an addon is spawned even when the gate would hold it.
   */
  readonly infraCapabilities: ReadonlySet<string>
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
  const { ready, deferred, unjudged } = gateStaleCandidates(candidates, input.context)
  for (const line of unjudged) input.log(line)
  const readyIds = new Set(ready.map((c) => c.addonId))
  for (const d of deferred) {
    const isInfra = d.candidate.capabilities.some((c) =>
      input.infraCapabilities.has(typeof c === 'string' ? c : c.name),
    )
    if (isInfra) {
      // Holding a data-store or storage provider leaves the node with no storage at all.
      readyIds.add(d.candidate.addonId)
      input.log(
        `${d.reason} — infrastructure provider, SPAWNED ANYWAY so the node keeps its storage`,
      )
    } else {
      input.log(d.reason)
    }
  }
  // An id the registry cannot describe is not this gate's to judge: keep it, the plan drops it as before.
  return input.addonIds.filter((id) => readyIds.has(id) || !known.has(id))
}

/** The gate's facts for THIS hub, read from disk: the running server and the addons dir. */
export function readHubStaleGateContext(): StaleGateContext {
  const dataDir = path.resolve(process.env.CAMSTACK_DATA ?? 'camstack-data')
  const addonsDir = process.env.CAMSTACK_ADDONS_DIR ?? path.resolve(dataDir, 'addons')
  return {
    serverVersion: readRunningServerVersion(),
    serverRequiresAddons: readRunningServerAddonMinimums(),
    installedVersions: readInstalledAddonVersions(addonsDir),
    requiresOfDir: readPackageRequires,
  }
}
