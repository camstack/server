/**
 * The hub's support judgement for an addon package (planning#447, D989, D1017).
 *
 * An addon whose package is below what the running server requires is spawned
 * like any other and reported to the operator (`UnsupportedAddonTracker`); the
 * hub asks the SAME judgement an agent does (`agent/stale-addon-gate.ts`).
 * `readHubStaleGateContext` reads its facts for THIS hub from disk.
 */
import * as path from 'node:path'
import type { GroupCandidate } from '../../agent/agent-group-runner.js'
import {
  readPackageRequires,
  reportSupport,
  type StaleGateContext,
} from '../../agent/stale-addon-gate.js'
import type { UnsupportedAddonTracker } from '@camstack/server/system'
import { readRunningServerAddonMinimums, readRunningServerVersion } from './addon-requirements.js'
import { readInstalledAddonVersions } from './installed-addon-versions.js'

export interface HubSupportInput {
  readonly addonIds: readonly string[]
  /** The candidate view of one addon; `undefined` for an id the registry does not hold. */
  readonly candidateOf: (addonId: string) => GroupCandidate | undefined
  readonly context: StaleGateContext
  readonly tracker: UnsupportedAddonTracker
  /** Every package the registry holds: a streak outside it is cleared. */
  readonly installedPackages: readonly string[]
}

/** Judge the addons of `addonIds` the registry holds and report the verdict; nothing is held back. */
export function reportHubAddonSupport(input: HubSupportInput): void {
  const candidates: GroupCandidate[] = []
  for (const id of input.addonIds) {
    const candidate = input.candidateOf(id)
    if (candidate !== undefined) candidates.push(candidate)
  }
  reportSupport(candidates, input.context, input.tracker, input.installedPackages)
}

/** The judgement's facts for THIS hub, read from disk: the running server and the addons dir. */
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
