/**
 * Node addon back-fill — converge a node to the addon roster THAT NODE last
 * declared.
 *
 * WHY THIS EXISTS
 * `AgentRegistryService.reconcileAgentAddons` used to be undeploy-only: it read
 * the node's live roster, removed what no longer belonged, and had no branch for
 * "installed on the hub but missing on the node". A node whose `<dataDir>/addons`
 * had been wiped therefore came back with only its bootstrap packages
 * (`@camstack/system` + `camstack.agentBootstrapAddons`) and the hub never sent
 * the rest — measured live as 4 of 14 packages on `agent-a`. Under the
 * volume-only image (no addons baked in) an empty addons dir is the ORDINARY
 * first-boot state of every new or rebuilt node, so that gap becomes the normal
 * case rather than an anomaly.
 *
 * THE INTENDED SET
 * A node's intended set is the roster the node itself last declared while
 * online, remembered durably hub-side (`ClusterNodeHistoryStore`). It is not
 * invented by the hub and it is not "every agent-deployable package the hub has
 * installed" — that would over-install and would override deliberate per-node
 * operator choices. The record GROWS when a node declares a package and SHRINKS
 * only on an explicit undeploy (operator gesture or the stale-reconcile), so
 * both mutations are attributable actions rather than heuristics.
 *
 * THE INTENDED VERSION
 * The hub's own installed version, and only that — including when the node
 * is AHEAD of the hub (D942). Never npm `latest` directly: the hub follows
 * the registry, and every node follows the hub. A package the hub's version
 * map does not name is left as it is when it is already installed, and is
 * never delivered when it is missing (`notOnHub`). An unreadable hub version
 * is not a reason to move.
 *
 * A package the hub does NOT install is never delivered, whatever the node last
 * reported. It used to fall back to the node's last-reported version, which
 * made the back-fill the one path that could put an UNINSTALLED addon back: an
 * operator removes `@camstack/addon-decoder-ffmpeg` from the hub and moves the
 * agent's copy aside, and the next reconnect reinstalled it from npm at the
 * version the node last ran — while the same pass's stale sweep exists to
 * remove exactly such an addon. The two directions disagreed; now the hub's
 * install set bounds both. Such packages are reported as `notOnHub`.
 *
 * BOUNDING
 * Delivery failures are counted per `(node, package, version)` and the pair is
 * retired after {@link MAX_BACKFILL_ATTEMPTS}, exactly as `CrashSupervisor`
 * bounds respawns (D6). A reconnect flap therefore cannot turn a broken package
 * into an endless push loop. A different hub version resets the count — a new
 * version is a new fact worth one more attempt.
 *
 * This module is pure/seam-driven on purpose: the decision of what a node should
 * have is asserted in unit tests with no Moleculer, filesystem or npm registry.
 */

/**
 * Why a reconcile is running. Named on every back-fill decision, and an
 * allowlist: a future caller has to CHOOSE a trigger, and a trigger that must
 * not deliver bytes is refused here rather than in a comment.
 *
 * `node-registration` covers both a first registration and a rejoin — the
 * distinction is not the discriminator it looks like. The case the back-fill
 * exists for (a node that lost `<dataDir>/addons` and came back with 4 of 14
 * packages) presents as a rejoin, so excluding rejoins would delete the only
 * legitimate purpose. The transient-roster-gap case is excluded by the delivery
 * ledger and the confirmation read instead, which discriminate on FACTS rather
 * than on which callback fired.
 */
import { ADDON_VERSION_REASON_HUB, decideAddonVersionMove } from '@camstack/system'

export type BackfillTrigger =
  | 'node-registration'
  | 'hub-boot'
  | 'operator-repair'
  /**
   * A pass that must never deliver. Reserved for callers that reconcile for a
   * reason unrelated to convergence (a status refresh, a diagnostic sweep) —
   * they still want the stale-addon half, never the installing half.
   */
  | 'inspect-only'

/** Triggers permitted to install packages onto a node. */
const DELIVERING_TRIGGERS: ReadonlySet<BackfillTrigger> = new Set<BackfillTrigger>([
  'node-registration',
  'hub-boot',
  'operator-repair',
])

/** Is this trigger allowed to put bytes on a node? */
export function triggerMayDeliver(trigger: BackfillTrigger): boolean {
  return DELIVERING_TRIGGERS.has(trigger)
}

/** One npm package a node reported installed, with the version it ran. */
export interface NodePackageEntry {
  readonly name: string
  /** `null` when the node reported the package without a usable version. */
  readonly version: string | null
}

/** Where the pinned version came from. Named in the log, never inferred later. */
export type BackfillVersionSource = 'hub-installed'

/** A package the hub decided to (re)deliver, at a resolved exact version. */
export interface BackfillTarget {
  readonly name: string
  readonly version: string
  /** Which authority supplied {@link version}. */
  readonly versionSource: BackfillVersionSource
}

export interface BackfillPlanInput {
  /** The roster this node last declared — the durable, node-authored record. */
  readonly recorded: readonly NodePackageEntry[]
  /** What the node reports installed right now (`$agent.status`). */
  readonly live: readonly NodePackageEntry[]
  /** Packages a node bootstraps itself; the hub must never push these. */
  readonly bootstrap: ReadonlySet<string>
  /** Packages undeployed in this same pass — they must not come straight back. */
  readonly undeployed: ReadonlySet<string>
  /** Packages the circuit breaker has retired for this node. */
  readonly retired: ReadonlySet<string>
  /** Hub-installed version per package name — the pin source. */
  readonly hubVersions: ReadonlyMap<string, string>
}

export interface BackfillPlan {
  /** Packages to deliver, in recorded order. */
  readonly targets: readonly BackfillTarget[]
  /** Missing packages skipped because the circuit breaker retired them. */
  readonly retired: readonly string[]
  /**
   * Missing packages the hub does not install. Never delivered — the hub's
   * install set is the ceiling of what a node is converged to.
   */
  readonly notOnHub: readonly string[]
  /**
   * How many packages the node reported when this plan was computed. The
   * "why did you think it was missing" half of the log line: a plan built
   * against a roster of 4 on a node that normally reports 14 is a partial read,
   * not fourteen missing packages.
   */
  readonly liveCount: number
}

/**
 * Decide what a node is missing relative to its own last-declared roster.
 * Pure — no I/O, no clock, no randomness.
 */
export function computeBackfillPlan(input: BackfillPlanInput): BackfillPlan {
  const liveByName = new Map(input.live.map((p) => [p.name, p.version]))
  const targets: BackfillTarget[] = []
  const retired: string[] = []
  const notOnHub: string[] = []

  for (const entry of input.recorded) {
    if (input.bootstrap.has(entry.name)) continue
    if (input.undeployed.has(entry.name)) continue
    const hubVersion = input.hubVersions.get(entry.name)
    const present = liveByName.has(entry.name)
    const liveVersion = present ? (liveByName.get(entry.name) ?? null) : null
    if (hubVersion === undefined) {
      if (!present && input.retired.has(entry.name)) retired.push(entry.name)
      else if (!present) notOnHub.push(entry.name)
      continue
    }
    const decision = decideAddonVersionMove(
      present ? liveVersion : null,
      hubVersion,
      ADDON_VERSION_REASON_HUB,
    )
    if (!decision.move) continue
    if (input.retired.has(entry.name)) {
      retired.push(entry.name)
      continue
    }
    targets.push({ name: entry.name, version: hubVersion, versionSource: 'hub-installed' })
  }

  return { targets, retired, notOnHub, liveCount: liveByName.size }
}

/**
 * The confirmation read ([D49](../../../../docs/decisions/adr-0049.md)).
 *
 * A back-fill DESTROYS work: it installs over whatever the node has, so a plan
 * built on one bad roster read is how a freshly deployed bundle gets replaced
 * by an older build of the same version number. D49's rule for exactly this
 * shape — a read that contradicts the mirror in the direction that destroys
 * work needs a SECOND read to agree — applies verbatim.
 *
 * So every target is re-checked against an independently fetched roster. A
 * package the second read already shows AT the target version is dropped —
 * installing again would overwrite a copy that matches, which is how a
 * same-version deploy was undone. A second read that still differs (or is
 * still absent) keeps the target. An unreadable version on that read is not
 * agreement to overwrite.
 */
export interface ConfirmedPlan {
  readonly plan: BackfillPlan
  /** Targets the second read reported present — dropped, and worth saying so. */
  readonly contradicted: readonly BackfillTarget[]
}

export function confirmBackfillPlan(
  plan: BackfillPlan,
  secondRead: readonly NodePackageEntry[],
): ConfirmedPlan {
  const seen = new Map(secondRead.map((p) => [p.name, p.version]))
  const targets: BackfillTarget[] = []
  const contradicted: BackfillTarget[] = []
  for (const target of plan.targets) {
    if (!seen.has(target.name)) {
      targets.push(target)
      continue
    }
    const version = seen.get(target.name) ?? null
    if (version === target.version) {
      contradicted.push(target)
      continue
    }
    if (version === null) {
      contradicted.push(target)
      continue
    }
    targets.push(target)
  }
  return { plan: { ...plan, targets }, contradicted }
}

/**
 * How many consecutive delivery failures retire a `(node, package)` pair.
 * Mirrors `CrashSupervisor.MAX_CRASHES_IN_WINDOW` in intent: bounded, terminal,
 * loud — never an infinite retry loop.
 */
export const MAX_BACKFILL_ATTEMPTS = 3

/** A retired or still-failing delivery, surfaced for diagnostics. */
export interface BackfillFailureRecord {
  readonly name: string
  readonly version: string
  readonly attempts: number
  readonly retired: boolean
  readonly lastError: string
}

interface FailureState {
  version: string
  attempts: number
  lastError: string
}

/**
 * Per-`(node, package)` delivery circuit breaker. In-memory and process-scoped
 * on purpose: it bounds retries within one hub lifetime, and a hub restart is an
 * operator-visible event that legitimately re-opens the breaker (same shape as
 * `CrashSupervisor`). It stores no intent — the durable record of what a node
 * should have lives in `ClusterNodeHistoryStore`, not here.
 */
export class BackfillAttemptTracker {
  private readonly failures = new Map<string, Map<string, FailureState>>()

  private forNode(nodeId: string): Map<string, FailureState> {
    const existing = this.failures.get(nodeId)
    if (existing) return existing
    const created = new Map<string, FailureState>()
    this.failures.set(nodeId, created)
    return created
  }

  /** Packages this node has exhausted its attempts on. */
  retiredFor(nodeId: string): ReadonlySet<string> {
    const node = this.failures.get(nodeId)
    if (!node) return new Set()
    const retired = new Set<string>()
    for (const [name, state] of node) {
      if (state.attempts >= MAX_BACKFILL_ATTEMPTS) retired.add(name)
    }
    return retired
  }

  /** Every non-clean delivery record for a node — attempted, failing or retired. */
  failuresFor(nodeId: string): readonly BackfillFailureRecord[] {
    const node = this.failures.get(nodeId)
    if (!node) return []
    return [...node].map(([name, state]) => ({
      name,
      version: state.version,
      attempts: state.attempts,
      retired: state.attempts >= MAX_BACKFILL_ATTEMPTS,
      lastError: state.lastError,
    }))
  }

  recordFailure(
    nodeId: string,
    name: string,
    version: string,
    error: string = '',
  ): { attempts: number; retired: boolean } {
    const node = this.forNode(nodeId)
    const prior = node.get(name)
    // A different hub version is a new fact — it earns a fresh set of attempts.
    const attempts = prior && prior.version === version ? prior.attempts + 1 : 1
    node.set(name, { version, attempts, lastError: error })
    return { attempts, retired: attempts >= MAX_BACKFILL_ATTEMPTS }
  }

  recordSuccess(nodeId: string, name: string): void {
    this.failures.get(nodeId)?.delete(name)
  }

  /** Drop everything remembered about a node (e.g. "Forget node"). */
  forget(nodeId: string): void {
    this.failures.delete(nodeId)
  }
}

/**
 * The side-effecting half of the back-fill, isolated behind a seam so the
 * orchestration can be tested without Moleculer, npm or a real hub.
 *
 * Delivery is an RPC (`$agent.deploy` + `$agent.reload`), never an event — a
 * dropped broadcast that leaves a node missing an addon is precisely the failure
 * this exists to remove (D8/D11).
 */
export interface BackfillSeam {
  /** Produce the tarball bytes for `name@version` (hub-side npm pack). */
  pack(name: string, version: string): Promise<Buffer>
  /** Ship the bundle to the node and install it there. */
  deploy(nodeId: string, packageName: string, bundle: Buffer): Promise<void>
  /** Re-run the node's addon discovery once, after all deliveries. */
  reload(nodeId: string): Promise<void>
}

export interface BackfillOutcome {
  readonly delivered: readonly BackfillTarget[]
  readonly failed: readonly {
    readonly name: string
    readonly version: string
    readonly error: string
    readonly retired: boolean
  }[]
  readonly skipped: readonly string[]
  readonly notOnHub: readonly string[]
}

/**
 * Deliver every planned package, then reload the node ONCE. Per-package failures
 * are isolated and counted — one broken package must not stop the others, and
 * must not retry forever.
 */
export async function executeBackfill(
  seam: BackfillSeam,
  nodeId: string,
  plan: BackfillPlan,
  tracker: BackfillAttemptTracker,
): Promise<BackfillOutcome> {
  const delivered: BackfillTarget[] = []
  const failed: BackfillOutcome['failed'][number][] = []

  for (const target of plan.targets) {
    try {
      const bundle = await seam.pack(target.name, target.version)
      await seam.deploy(nodeId, target.name, bundle)
      tracker.recordSuccess(nodeId, target.name)
      delivered.push(target)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      const { retired } = tracker.recordFailure(nodeId, target.name, target.version, error)
      failed.push({ name: target.name, version: target.version, error, retired })
    }
  }

  if (delivered.length > 0) {
    await seam.reload(nodeId)
  }

  return { delivered, failed, skipped: plan.retired, notOnHub: plan.notOnHub }
}
