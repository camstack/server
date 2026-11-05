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
 * A fact that cannot be read is UNKNOWN, never a pass. A package whose own
 * `requires` cannot be read (missing, malformed or schema-invalid package.json)
 * is deferred with the reason. A running server version that cannot be read
 * leaves the addon's own `requires.server` unjudged: it is spawned (every addon
 * held would leave the node empty) but reported in `unjudged`, so the caller
 * logs it. The addon-minimum check does not need the version and still runs.
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
  /** The `camstack.requires` of the package in `addonDir`; `UnreadableRequires` when it cannot be read. */
  readonly requiresOfDir: (addonDir: string) => PackageRequires | UnreadableRequires | undefined
}

/** A package.json that could not be read as a `requires` source, and why. */
export interface UnreadableRequires {
  readonly unreadable: string
}

export function isUnreadableRequires(
  value: PackageRequires | UnreadableRequires | undefined,
): value is UnreadableRequires {
  return value !== undefined && 'unreadable' in value
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
  /** Addons spawned although a fact needed to judge them was unknown; one line each. */
  readonly unjudged: readonly string[]
}

export function gateStaleCandidates(
  candidates: readonly GroupCandidate[],
  context: StaleGateContext,
): StaleGateResult {
  const ready: GroupCandidate[] = []
  const deferred: DeferredCandidate[] = []
  const unjudged: string[] = []
  for (const candidate of candidates) {
    const minimum = context.serverRequiresAddons[candidate.packageName]
    const fromServer = unmetRequirements(
      minimum === undefined ? undefined : { addons: { [candidate.packageName]: minimum } },
      { server: context.serverVersion, addons: context.installedVersions, wrapper: null },
    )
    const read = context.requiresOfDir(candidate.addonDir)
    const label = `addon "${candidate.addonId}" (${candidate.packageName}@${candidate.packageVersion})`
    if (isUnreadableRequires(read)) {
      deferred.push({
        candidate,
        unmet: fromServer,
        reason: `${label} deferred: its package requirements could not be read (${read.unreadable})`,
      })
      continue
    }
    const own = read
    if (context.serverVersion === null && own?.server !== undefined) {
      unjudged.push(
        `${label} spawned unjudged: it requires server ${own.server} and the running server version is unknown`,
      )
    }
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
      reason: `${label} deferred until its package is reconciled: ${unmet.map(describeUnmet).join('; ')}`,
    })
  }
  return { ready, deferred, unjudged }
}

/**
 * `camstack.requires` of the package.json in `dir`: `undefined` when the package
 * declares none, `UnreadableRequires` when the file is missing, not JSON, or
 * declares a `requires` the schema rejects (never a pass).
 */
export function readPackageRequires(dir: string): PackageRequires | UnreadableRequires | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'))
  } catch (err) {
    return { unreadable: `package.json: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (typeof raw !== 'object' || raw === null)
    return { unreadable: 'package.json is not an object' }
  const camstack: unknown = Reflect.get(raw, 'camstack')
  if (camstack === undefined) return undefined
  if (typeof camstack !== 'object' || camstack === null) {
    return { unreadable: 'package.json "camstack" is not an object' }
  }
  const declared: unknown = Reflect.get(camstack, 'requires')
  if (declared === undefined) return undefined
  const parsed = PackageRequiresSchema.safeParse(declared)
  return parsed.success
    ? parsed.data
    : {
        unreadable: `camstack.requires is malformed: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
      }
}
