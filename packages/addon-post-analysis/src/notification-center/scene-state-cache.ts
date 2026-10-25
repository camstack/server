/**
 * The scene states the `scene` rule gate reads.
 *
 * Sibling of {@link ../notification-center/device-state-cache.ts} and built to
 * the same contract, for the same reason: the gate runs on the persist hook,
 * per event, so it cannot do I/O — it reads this mirror with no await, and the
 * mirror is refreshed OFF the event path (D49). The cap is NEVER read from the
 * gate. A `listScenes` that failed would otherwise look exactly like a scene
 * that had gone back to `matched`, and it would un-gate the rule at the moment
 * the operator most needs it gated.
 *
 * Three properties, each because its opposite is a silent failure:
 *
 *  - **A cold mirror reads `undefined`**, and `undefined` never matches. Until
 *    the first successful refresh a gated rule does not fire. Silence is the
 *    safe failure for a gate.
 *  - **A FAILED refresh keeps the previous entries** — it never empties the
 *    mirror. One transient error must not un-gate (or worse, wrongly gate) the
 *    whole rule set. They still AGE OUT past {@link SCENE_MAX_AGE_MS}, so a
 *    sustained failure does not pin a week-old verdict forever.
 *  - **A scene missing from a successful refresh is DROPPED**, not kept at its
 *    last value: a deleted or disabled scene must stop arming rules, and
 *    keeping it would be a gate answering about something that no longer
 *    exists.
 *
 * ── Two writers, and which one wins ────────────────────────────────────────
 * {@link NcSceneStateCache.note} is the in-process edge tap: the scene provider
 * lives in THIS process (`pipeline-analytics` hosts both) and calls it
 * synchronously on a confirmed transition, so the very next evaluation already
 * sees the flip. {@link NcSceneStateCache.refresh} is the reconcile half on the
 * rule-reload tick — it is what makes a scene created, edited, reset or deleted
 * elsewhere converge, and what stops a noted value living forever.
 *
 * A noted entry OUTRANKS a refreshed one while it is fresher, exactly as
 * `NcDeviceStateCache` does: the direct call is newer by construction, and it
 * is the only thing that can be right in the seconds after a scene flipped.
 * Direct call and not an event, because D8 events are droppable telemetry and a
 * gate refreshed by droppable telemetry is a gate that is sometimes wrong and
 * never says so.
 */

import type { IScopedLogger, NcSceneCondition, SceneMonitor } from '@camstack/types'

/**
 * How long an observation may go unrefreshed before it stops counting.
 *
 * Deliberately several reload ticks, for the reason `MAX_AGE_MS` is: one failed
 * refresh must not un-gate everything, and a sustained failure must not keep a
 * stale verdict arming rules indefinitely.
 */
export const SCENE_MAX_AGE_MS = 5 * 60_000

/** What the gate needs to know about one scene. A projection of `SceneMonitor`
 *  — never the monitor itself, so the gate cannot start reading a field the
 *  mirror does not promise to keep fresh. */
export interface NcSceneObservation {
  readonly sceneId: string
  /** The camera the scene lives on — the `tags: { deviceId }` every line owes. */
  readonly deviceId: number
  readonly label: string
  readonly verdict: SceneMonitor['verdict']
  readonly latched: boolean
  /** Which boolean the scene itself declares drives notification rules. */
  readonly emit: SceneMonitor['emit']
}

export interface NcSceneStateCacheDeps {
  readonly logger: IScopedLogger
  /**
   * Every scene this process can currently answer for. In-process and
   * synchronous by construction (`SceneMonitorProvider.listAllEnabled`), and a
   * scene that is disabled or deleted is simply absent — never present with an
   * invented value.
   */
  readonly readScenes: () => readonly NcSceneObservation[]
  readonly now?: () => number
}

interface Entry {
  readonly observation: NcSceneObservation
  readonly at: number
}

export class NcSceneStateCache {
  private entries: ReadonlyMap<string, Entry> = new Map()
  private readonly noted = new Map<string, Entry>()
  private ids: readonly string[] = []
  private readonly now: () => number

  constructor(private readonly deps: NcSceneStateCacheDeps) {
    this.now = deps.now ?? ((): number => Date.now())
  }

  /**
   * The scene ids worth reading — recomputed from the rule set, so a cluster
   * with no scene-gated rule does no work at all and logs nothing.
   */
  setWatched(ids: readonly string[]): void {
    this.ids = [...new Set(ids)].sort()
  }

  watched(): readonly string[] {
    return this.ids
  }

  /**
   * "This scene, in this process, is in this state, NOW."
   *
   * Synchronous by contract — the caller is the scene provider's own edge tap
   * and the next rule evaluation must already see it.
   */
  note(observation: NcSceneObservation): void {
    this.noted.set(observation.sceneId, { observation, at: this.now() })
  }

  /** Hot-path read. No I/O, no await — this is called per event. */
  get(sceneId: string): NcSceneObservation | undefined {
    const now = this.now()
    const noted = this.noted.get(sceneId)
    if (noted !== undefined) {
      if (now - noted.at <= SCENE_MAX_AGE_MS) return noted.observation
      this.noted.delete(sceneId)
    }
    const entry = this.entries.get(sceneId)
    if (entry === undefined) return undefined
    if (now - entry.at > SCENE_MAX_AGE_MS) return undefined
    return entry.observation
  }

  /**
   * Re-read every watched scene. Never throws: a gate that could fail the
   * evaluation tick would take the notification pipeline with it.
   *
   * On failure the previous entries are KEPT — their timestamps are not
   * touched, so they age out on their own rather than vanishing at once.
   */
  refresh(): void {
    if (this.ids.length === 0) {
      this.entries = new Map()
      this.noted.clear()
      return
    }
    let observations: readonly NcSceneObservation[]
    try {
      observations = this.deps.readScenes()
    } catch (err) {
      this.deps.logger.warn(
        'scene-state refresh failed — keeping the previous states until they age out',
        { meta: { watched: this.ids.length, error: String(err) } },
      )
      return
    }
    const at = this.now()
    const wanted = new Set(this.ids)
    const next = new Map<string, Entry>()
    for (const observation of observations) {
      if (!wanted.has(observation.sceneId)) continue
      next.set(observation.sceneId, { observation, at })
    }
    this.entries = next
    // A watched scene that answered nothing is a rule that has quietly stopped
    // being able to fire — deleted, disabled, or living on a node whose store
    // has not converged. The operator has to be able to find that.
    for (const sceneId of this.ids) {
      if (next.has(sceneId)) continue
      this.deps.logger.info('scene gate: no state for a watched scene', { meta: { sceneId } })
    }
  }
}

/**
 * Does this observation satisfy the rule's scene condition?
 *
 * Exported and pure so the semantics can be tested without a cache, a provider
 * or a rule — and so there is exactly ONE place that decides what `latched`
 * absent means. See `NcSceneConditionSchema` for the reasoning behind each
 * branch.
 */
export function sceneConditionSatisfied(
  condition: NcSceneCondition,
  observation: NcSceneObservation,
): boolean {
  const readLatch = condition.latched ?? observation.emit === 'latched'
  if (readLatch) return observation.latched === (condition.requiredState === 'diverged')
  // LIVE: `unknown` is a real value and it satisfies NEITHER required state.
  return observation.verdict === condition.requiredState
}

/** One-line "why", for the suppression log. Never a bare boolean: a drop the
 *  operator cannot explain is the failure this whole feature is one misstep
 *  away from. */
export function sceneGateReason(
  condition: NcSceneCondition,
  observation: NcSceneObservation | undefined,
): string {
  if (observation === undefined) return 'no mirrored state for this scene'
  const readLatch = condition.latched ?? observation.emit === 'latched'
  return readLatch
    ? `latched=${observation.latched} (wanted ${condition.requiredState})`
    : `verdict=${observation.verdict} (wanted ${condition.requiredState})`
}
