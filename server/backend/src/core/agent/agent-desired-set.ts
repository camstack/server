/**
 * The desired addon set of a node, and the difference against what it runs
 * ([D982](../../../../docs/decisions/adr-0982-the-hub-owns-every-nodes-addon-set.md)).
 *
 * The hub decides what a node carries; the roster a node reports is an
 * OBSERVATION, never the intent. Two pure functions, no I/O, no clock:
 *
 *  - {@link computeDesiredSet} — every package the hub installs whose placement
 *    allows an agent, plus the agent-only packages the hub tracks (agent-ui),
 *    minus the packages tombstoned for the node, each at the hub's version.
 *  - {@link diffNodeAgainstDesired} — install / update / remove against the
 *    observed roster.
 *
 * A package whose addons mix `hub-only` with another placement is neither wanted
 * nor removed here: the stale sweep undeploys the hub-only addon alone, and
 * removing the package would take the shared bundle directory with it.
 */
import type { AddonPlacement } from '@camstack/types'
import { ADDON_VERSION_REASON_HUB, decideAddonVersionMove } from '@camstack/system'

/**
 * Agent-only packages the hub tracks and delivers without loading them itself.
 * The version the hub follows for each is the registry's `latest`, resolved by
 * the caller and passed in as `trackedForAgents`.
 */
export const AGENT_TRACKED_PACKAGES: readonly string[] = ['@camstack/addon-agent-ui']

export function isAgentTrackedPackage(name: string): boolean {
  return AGENT_TRACKED_PACKAGES.includes(name)
}

/** What the hub knows about one package it installs. */
export interface HubPackageFact {
  /** `null` when the hub cannot read its own version — nothing moves then. */
  readonly version: string | null
  /** The placement of every addon the package ships. */
  readonly placements: readonly AddonPlacement[]
}

export interface DesiredSetInput {
  readonly hubPackages: ReadonlyMap<string, HubPackageFact>
  /** Agent-only packages the hub tracks, with the version it follows. */
  readonly trackedForAgents: ReadonlyMap<string, string>
  /** Packages removed on purpose from this node; they stay off. */
  readonly tombstones: ReadonlySet<string>
  /** Packages the node bootstraps itself (`@camstack/system`); never managed. */
  readonly bootstrap: ReadonlySet<string>
}

export type DesiredOrigin = 'hub-any-node' | 'agent-tracked'

export interface DesiredEntry {
  readonly name: string
  readonly version: string
  readonly origin: DesiredOrigin
}

export interface DesiredSet {
  readonly desired: ReadonlyMap<string, DesiredEntry>
  /** Packages whose every addon is hub-only: a copy on a node is a leftover. */
  readonly hubOnly: ReadonlySet<string>
  readonly tombstones: ReadonlySet<string>
  /** Hub packages deliberately left off, each with its reason (D391). */
  readonly excluded: readonly {
    readonly name: string
    readonly reason: string
  }[]
}

export function computeDesiredSet(input: DesiredSetInput): DesiredSet {
  const desired = new Map<string, DesiredEntry>()
  const hubOnly = new Set<string>()
  const excluded: { name: string; reason: string }[] = []

  for (const [name, fact] of input.hubPackages) {
    if (input.bootstrap.has(name)) continue
    if (fact.placements.length > 0 && fact.placements.every((p) => p === 'hub-only')) {
      hubOnly.add(name)
      excluded.push({ name, reason: 'hub-only placement' })
      continue
    }
    if (fact.placements.includes('hub-only')) {
      excluded.push({ name, reason: 'mixes a hub-only addon' })
      continue
    }
    if (!fact.placements.includes('any-node')) {
      excluded.push({ name, reason: 'placement does not allow any node' })
      continue
    }
    if (input.tombstones.has(name)) {
      excluded.push({ name, reason: 'tombstoned' })
      continue
    }
    if (fact.version === null) {
      excluded.push({ name, reason: 'hub version unknown' })
      continue
    }
    desired.set(name, { name, version: fact.version, origin: 'hub-any-node' })
  }

  for (const [name, version] of input.trackedForAgents) {
    if (input.bootstrap.has(name)) continue
    if (input.tombstones.has(name)) {
      excluded.push({ name, reason: 'tombstoned' })
      continue
    }
    desired.set(name, { name, version, origin: 'agent-tracked' })
  }

  return { desired, hubOnly, tombstones: input.tombstones, excluded }
}

/** One package the node runs, as it reported it. */
export interface ObservedPackage {
  readonly name: string
  readonly version: string | null
}

export interface ConvergenceTarget {
  readonly name: string
  readonly version: string
  readonly origin: DesiredOrigin
  /** The version the node runs now; `null` for an install. */
  readonly from: string | null
}

export type RemovalReason = 'tombstoned' | 'hub-only placement'

export interface ConvergenceRemoval {
  readonly name: string
  readonly reason: RemovalReason
}

export interface ConvergencePlan {
  readonly install: readonly ConvergenceTarget[]
  readonly update: readonly ConvergenceTarget[]
  readonly remove: readonly ConvergenceRemoval[]
  /** Packages the delivery breaker retired for this node; not retried. */
  readonly retired: readonly string[]
}

export interface DiffInput {
  readonly desired: DesiredSet
  readonly observed: readonly ObservedPackage[]
  readonly retired: ReadonlySet<string>
  readonly bootstrap: ReadonlySet<string>
}

export function diffNodeAgainstDesired(input: DiffInput): ConvergencePlan {
  const observed = new Map(input.observed.map((p) => [p.name, p.version]))
  const install: ConvergenceTarget[] = []
  const update: ConvergenceTarget[] = []
  const remove: ConvergenceRemoval[] = []
  const retired: string[] = []

  for (const entry of input.desired.desired.values()) {
    const present = observed.has(entry.name)
    const from = present ? (observed.get(entry.name) ?? null) : null
    const decision = decideAddonVersionMove(from, entry.version, ADDON_VERSION_REASON_HUB)
    if (!decision.move) continue
    if (input.retired.has(entry.name)) {
      retired.push(entry.name)
      continue
    }
    const target: ConvergenceTarget = { ...entry, from }
    if (present) update.push(target)
    else install.push(target)
  }

  for (const name of observed.keys()) {
    if (input.bootstrap.has(name)) continue
    if (input.desired.tombstones.has(name)) remove.push({ name, reason: 'tombstoned' })
    else if (input.desired.hubOnly.has(name)) remove.push({ name, reason: 'hub-only placement' })
  }

  return { install, update, remove, retired }
}
