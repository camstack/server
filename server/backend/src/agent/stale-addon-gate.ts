/**
 * The boot gate for an addon whose package is stale (#346).
 *
 * After `applyServerUpdate` an agent restarts with the addons already on disk.
 * An addon built for the previous framework imports a package the new server no
 * longer carries and crash-loops until the hub's reconcile (D982) replaces it,
 * which can trip the D6 breaker long before the new bytes arrive. The gate
 * decides, from facts both packages declare (D989), that an addon cannot run on
 * this server yet and leaves it unspawned: the hub's registration reconcile
 * delivers the right version, and the deploy's reload spawns it then.
 *
 * Stale means either:
 *   - the RUNNING server requires a newer version of this addon's package
 *     (`requires.addons` of the server), or
 *   - the addon's own `requires.server` is above the running server.
 *
 * A running server version that cannot be read judges nothing (D49: a failed
 * read changes nothing); the addon-minimum check does not need it and still runs.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  PackageRequiresSchema,
  describeUnmet,
  unmetRequirements,
  type PackageRequires,
  type UnmetRequirement,
} from '@camstack/types'
import type { GroupCandidate } from './agent-group-runner.js'

/** What the gate needs to know about the node. */
export interface StaleGateContext {
  /** The running `@camstack/server`, or `null` when unreadable. */
  readonly serverVersion: string | null
  /** What the running server requires of addon packages (`requires.addons`). */
  readonly serverRequiresAddons: Readonly<Record<string, string>>
  /** Installed addon package versions, by package name. */
  readonly installedVersions: Readonly<Record<string, string | null>>
  /** The `camstack.requires` of the package in `addonDir`. */
  readonly requiresOfDir: (addonDir: string) => PackageRequires | undefined
}

export interface DeferredCandidate {
  readonly candidate: GroupCandidate
  readonly unmet: readonly UnmetRequirement[]
  /** One line naming the addon and both versions of every unmet requirement. */
  readonly reason: string
}

export interface StaleGateResult {
  readonly ready: readonly GroupCandidate[]
  readonly deferred: readonly DeferredCandidate[]
}

export function gateStaleCandidates(
  candidates: readonly GroupCandidate[],
  context: StaleGateContext,
): StaleGateResult {
  const ready: GroupCandidate[] = []
  const deferred: DeferredCandidate[] = []
  for (const candidate of candidates) {
    const minimum = context.serverRequiresAddons[candidate.packageName]
    const fromServer = unmetRequirements(
      minimum === undefined ? undefined : { addons: { [candidate.packageName]: minimum } },
      { server: context.serverVersion, addons: context.installedVersions, wrapper: null },
    )
    const own = context.requiresOfDir(candidate.addonDir)
    const fromAddon =
      context.serverVersion === null
        ? []
        : unmetRequirements(own?.server === undefined ? undefined : { server: own.server }, {
            server: context.serverVersion,
            addons: {},
            wrapper: null,
          })
    const unmet = [...fromServer, ...fromAddon]
    if (unmet.length === 0) {
      ready.push(candidate)
      continue
    }
    deferred.push({
      candidate,
      unmet,
      reason: `addon "${candidate.addonId}" (${candidate.packageName}@${candidate.packageVersion}) deferred until its package is reconciled: ${unmet.map(describeUnmet).join('; ')}`,
    })
  }
  return { ready, deferred }
}

/** `camstack.requires` of the package.json in `dir`; `undefined` when absent or malformed. */
export function readPackageRequires(dir: string): PackageRequires | undefined {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'))
    if (typeof raw !== 'object' || raw === null) return undefined
    const camstack: unknown = Reflect.get(raw, 'camstack')
    if (typeof camstack !== 'object' || camstack === null) return undefined
    const parsed = PackageRequiresSchema.safeParse(Reflect.get(camstack, 'requires'))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}
