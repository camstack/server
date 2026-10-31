/**
 * Node addon delivery — the bookkeeping that carries a convergence plan to a
 * node: the trigger allowlist, the delivery circuit breaker, the confirmation
 * read and the execution seam.
 *
 * WHAT A NODE SHOULD HAVE is decided in `agent-desired-set.ts`
 * ([D982](../../../../docs/decisions/adr-0982-the-hub-owns-every-nodes-addon-set.md)):
 * the hub's desired set, never the roster the node declared. This module only
 * delivers a computed plan, and is seam-driven so that is tested with no
 * Moleculer, filesystem or npm registry.
 *
 * THE VERSION is the hub's own installed version, and only that — including when
 * the node is AHEAD of the hub (D942). Never npm `latest` directly for a package
 * the hub installs: the hub follows the registry, and every node follows the hub.
 * An agent-only package the hub tracks (agent-ui) is delivered at the registry
 * version the hub resolved for it.
 *
 * BOUNDING
 * Delivery failures are counted per `(node, package, version)` and the pair is
 * retired after {@link MAX_BACKFILL_ATTEMPTS}, exactly as `CrashSupervisor`
 * bounds respawns (D6). A reconnect flap or a periodic round therefore cannot
 * turn a broken package into an endless push loop. A different hub version
 * resets the count — a new version is a new fact worth one more attempt.
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
export type BackfillTrigger =
  | 'node-registration'
  | 'hub-boot'
  | 'operator-repair'
  /** The fixed-schedule round over every online node (D982). */
  | 'periodic'
  /** After a hub install / update / uninstall (D982). */
  | 'hub-change'
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
  'periodic',
  'hub-change',
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
export type BackfillVersionSource = 'hub-installed' | 'agent-tracked'

/** A package the hub decided to (re)deliver, at a resolved exact version. */
export interface BackfillTarget {
  readonly name: string
  readonly version: string
  /** Which authority supplied {@link version}. */
  readonly versionSource: BackfillVersionSource
}

export interface BackfillPlan {
  /** Packages to deliver: installs first, then updates. */
  readonly targets: readonly BackfillTarget[]
  /** Missing packages skipped because the circuit breaker retired them. */
  readonly retired: readonly string[]
  /**
   * How many packages the node reported when this plan was computed. The
   * "why did you think it was missing" half of the log line: a plan built
   * against a roster of 4 on a node that normally reports 14 is a partial read,
   * not fourteen missing packages.
   */
  readonly liveCount: number
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
      failed.push({
        name: target.name,
        version: target.version,
        error,
        retired,
      })
    }
  }

  if (delivered.length > 0) {
    await seam.reload(nodeId)
  }

  return { delivered, failed, skipped: plan.retired }
}
