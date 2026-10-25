/**
 * SceneMonitorProvider — the `scene-monitor` capability, at last implemented.
 *
 * The cap has shipped fully declared (8 methods, generated routers, a
 * device-proxy facade, UI hooks, an event category and a typed payload) with
 * NO provider, no persistence, no engine construction and no emitter since it
 * landed. It was invisible on every device: `getSingleton('scene-monitor')`
 * resolved `null` on every call, so nothing about it was even broken — it was
 * absent. This file is the missing half.
 *
 * ## What lives here, and what deliberately does not
 *
 * - **Here:** the operator's CRUD, the reference capture (the one legitimate
 *   `snapshot.getSnapshot({ force: true })` in the codebase — see below), the
 *   LATCH, the runtimeState mirror and the `EnrichmentSceneStateChanged` emit.
 * - **Not here:** the comparison. `SceneEngine` owns when to look and what the
 *   pixels say; this provider owns what that MEANS to the operator and what
 *   survives a restart. The engine reports observations; the latch is a fact
 *   only this component ever held, so only this component may write it.
 *
 * ## Two booleans
 *
 * `verdict` is live ("does the region match right now"); `latched` is the
 * operator's boolean ("has it diverged at least once since the last reset").
 * The operator asked for the latch. The live value costs one field and is what
 * makes the UI honest — a card that can only say "ALARM" cannot tell the
 * operator that the bin came back.
 *
 * ## Durability
 *
 * The latch's authority is `pipeline-analytics:scene-latch`; the cap's
 * `runtimeState` slice is a MIRROR of it, rehydrated at boot before evaluation
 * starts. That is why `durability: 'session'` on the cap is correct rather than
 * an oversight: the slice is never the truth, so persisting it would be a
 * second copy that eventually disagrees.
 *
 * Boot hydration must NOT re-fire edges. A scene that was `diverged` before the
 * restart is `diverged` after it, with no new event and no new notification.
 */

import { randomUUID } from 'node:crypto'
import type {
  ISceneMonitorProvider,
  IScopedLogger,
  MaskRectShape,
  SceneCheck,
  SceneCondition,
  SceneMonitor,
  SceneMonitorState,
  SceneMonitorStatus,
  SceneMonitorStatusForDevice,
  SceneReference,
  SceneUncoveredPolicy,
} from '@camstack/types'
import {
  SCENE_DEFAULT_ANCHOR_THRESHOLD,
  SCENE_DEFAULT_CHECK_INTERVAL_SEC,
  SCENE_DEFAULT_OBSERVATION_SPACING_SEC,
  SCENE_DEFAULT_QUIET_SECONDS,
  SCENE_DEFAULT_UNCOVERED_POLICY,
  SCENE_DIVERGED,
  SCENE_RESET_RECAPTURES,
} from '@camstack/types'
import type { EmbeddingEncoderClient } from '../embedding/embedding-dispatcher.js'
import { anchorFrame, cropSnapshotRoi } from './scene-crop.js'
import type { SceneEngine, SceneEngineResult, SnapshotImage } from './scene-engine.js'
import {
  SCENE_MAX_CONDITIONS,
  SCENE_MAX_REFS_PER_CONDITION,
  type SceneLatchRow,
  type SceneStore,
  sceneKey,
} from './scene-store.js'

/** A confirmed scene transition, for the in-process Notification-Center tap. */
export interface SceneEdge {
  readonly deviceId: number
  readonly monitorId: string
  readonly monitorLabel: string
  readonly direction: 'diverged' | 'restored'
  readonly verdict: SceneMonitor['verdict']
  readonly latched: boolean
  /**
   * Which boolean this scene declares drives notification rules.
   *
   * On the edge and not only in the config row because the Notification-Center
   * gate reads `emit` to decide whether a rule with no explicit `latched`
   * override tests the latch or the live verdict — and the tap is the ONLY
   * writer between two reload ticks. An edge without it would leave the mirror
   * resolving that question against a value up to thirty seconds old.
   */
  readonly emit: SceneMonitor['emit']
  readonly condition: SceneCondition
  readonly confidence: number | null
  readonly timestamp: number
}

/** What {@link SceneMonitorProviderDeps.putMedia} is handed. Named, because a
 *  signature never carries an inline type in this repo. */
export interface ScenePutMediaInput {
  readonly deviceId: number
  readonly ownerId: string
  readonly data: Buffer
  readonly timestamp: number
}

export interface SceneMonitorProviderDeps {
  readonly store: SceneStore
  readonly encoder: EmbeddingEncoderClient
  readonly getSnapshot: (deviceId: number, force: boolean) => Promise<SnapshotImage | null>
  /** Persist a reference thumbnail and return its media ROW id (D482). */
  readonly putMedia?: (input: ScenePutMediaInput) => Promise<number>
  /**
   * Drop one reference thumbnail by its media row id.
   *
   * Every reference owns its OWN picture (its owner id carries the capture
   * timestamp), which is what makes the gallery able to show the operator which
   * capture was the bad one. The cost of that is a blob per reference, so the
   * blob has to leave with the reference — on an explicit `deleteReference`, on
   * a `deleteScene`, and when `boundReferences` evicts an old capture. Scene
   * media is retention-EXEMPT (`OWNER_KINDS`), so nothing else will ever come
   * along and collect it.
   *
   * Best-effort by construction: a picture that will not delete must never fail
   * the operator's delete of the reference itself.
   */
  readonly dropMedia?: (mediaId: number) => Promise<void>
  /** Mirror the cap's runtimeState slice for a device. */
  readonly mirrorSlice: (deviceId: number, status: SceneMonitorStatus) => void
  /** `ctx.eventBus.emit(EventCategory.EnrichmentSceneStateChanged, …)`. */
  readonly emitStateChanged: (payload: {
    deviceId: number
    monitorId: string
    monitorLabel: string
    previousState: string
    currentState: string
    confidence: number
    timestamp: number
  }) => void
  /**
   * In-process Notification-Center tap. NOT a bus subscription: D8 events are
   * droppable telemetry, and a latched alarm is exactly the payload that must
   * not be dropped.
   */
  readonly onSceneEdge?: (edge: SceneEdge) => void
  /** The condition the resolver reports for a device right now. */
  readonly currentCondition: (deviceId: number) => Promise<SceneCondition>
  readonly logger: IScopedLogger
  readonly now?: () => number
}

/** The engine seam the provider drives. Narrow on purpose — it is the whole
 *  reason the provider can be tested without decoding a JPEG. */
export interface SceneEngineControl {
  recheck(deviceId: number, monitorId: string): Promise<void>
  resetMonitor(deviceId: number, monitorId: string, currentStateId: string | null): void
}

export class SceneMonitorProvider implements ISceneMonitorProvider {
  private readonly deps: SceneMonitorProviderDeps
  private engine: SceneEngineControl | null = null
  private readonly now: () => number

  constructor(deps: SceneMonitorProviderDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  /** The engine is constructed after the provider (it reads scenes through it),
   *  so the back-reference is set rather than injected. */
  attachEngine(engine: SceneEngine | SceneEngineControl): void {
    this.engine = engine
  }

  // ── boot ────────────────────────────────────────────────────────────────

  /**
   * Rehydrate the runtimeState mirror from the durable authority, WITHOUT
   * emitting a single edge. A scene that was `diverged` before the restart is
   * `diverged` after it — the operator was already told, and telling them again
   * on every container restart is how a feature loses its credibility in a week.
   */
  hydrate(): void {
    const byDevice = new Map<number, SceneMonitor[]>()
    for (const row of this.deps.store.listScenes()) {
      const list = byDevice.get(row.deviceId) ?? []
      list.push(this.merged(row.deviceId, row.monitor))
      byDevice.set(row.deviceId, list)
    }
    for (const [deviceId, monitors] of byDevice) {
      this.deps.mirrorSlice(deviceId, { monitors, lastFetchedAt: this.now() })
    }
    this.deps.logger.info('scene monitors hydrated', {
      meta: { devices: byDevice.size, scenes: this.deps.store.listScenes().length },
    })
  }

  // ── cap methods ─────────────────────────────────────────────────────────

  async listScenes(input: { deviceId: number }): Promise<SceneMonitorStatus> {
    return this.statusFor(input.deviceId)
  }

  /**
   * `listScenes` for a SET, in one round trip.
   *
   * `/scenes` renders every camera and re-reads them behind the push slice on a
   * 30 s safety net. Fanned out client-side that was one request per camera to
   * read `statusFor`, which is an in-memory merge this provider already holds —
   * all cost, no work. The work here is identical; only the transport
   * collapses.
   *
   * **Every requested id gets a row.** A camera `statusFor` cannot answer for
   * is `status: null`, which is NOT `monitors: []`: this feature's whole
   * failure mode is silence reading as "nothing configured", and a batch that
   * dropped the row would have made an unreachable camera invisible instead of
   * reported.
   */
  async listScenesBatch(input: {
    deviceIds: readonly number[]
  }): Promise<readonly SceneMonitorStatusForDevice[]> {
    return input.deviceIds.map((deviceId): SceneMonitorStatusForDevice => {
      try {
        return { deviceId, status: this.statusFor(deviceId) }
      } catch (err: unknown) {
        // A branch that drops a camera silently reads as "it had no scenes".
        // Per-camera, because every question asked of this is per-camera.
        this.deps.logger.warn('scene status could not be read', {
          tags: { deviceId },
          meta: { error: String(err) },
        })
        return { deviceId, status: null }
      }
    })
  }

  async getStatus(input: { deviceId: number }): Promise<SceneMonitorStatus> {
    return this.statusFor(input.deviceId)
  }

  async createScene(input: {
    deviceId: number
    label: string
    roi: MaskRectShape
    check: SceneCheck
    triggerMode?: 'periodic' | 'on-motion' | 'both'
    checkIntervalSec?: number
  }): Promise<SceneMonitor> {
    const now = this.now()
    const monitor: SceneMonitor = {
      id: randomUUID(),
      label: input.label,
      roi: input.roi,
      enabled: true,
      triggerMode: input.triggerMode ?? 'both',
      checkIntervalSec: input.checkIntervalSec ?? SCENE_DEFAULT_CHECK_INTERVAL_SEC,
      check: input.check,
      states: [],
      currentStateId: null,
      lastCheckedAt: null,
      lastConfidence: null,
      currentCondition: null,
      availability: 'ok',
      unavailableReason: null,
      baselineStateId: null,
      emit: 'latched',
      // A scene with no reference cannot judge anything yet, and saying
      // `matched` here would be the feature's first lie.
      verdict: 'unknown',
      latched: false,
      armedAt: now,
      divergedAt: null,
      restoredAt: null,
      quietSeconds: SCENE_DEFAULT_QUIET_SECONDS,
      minObservationSpacingSec: SCENE_DEFAULT_OBSERVATION_SPACING_SEC,
      anchorThreshold: SCENE_DEFAULT_ANCHOR_THRESHOLD,
      autoRestore: false,
      // Night is optional from the first second a scene exists: the operator
      // captures daylight, walks away, and the scene must not spend every night
      // complaining about the reference they were never asked to take.
      onUncoveredCondition: SCENE_DEFAULT_UNCOVERED_POLICY,
      suspendedCondition: null,
      unavailable: 'no-reference-for-condition',
      coveredConditions: [],
    }
    await this.deps.store.putScene(input.deviceId, monitor, now)
    await this.deps.store.putLatch(this.freshLatch(input.deviceId, monitor.id, now))
    this.deps.logger.info('scene created', {
      tags: { deviceId: input.deviceId },
      meta: { monitorId: monitor.id, label: monitor.label, mode: input.check.mode },
    })
    this.refresh(input.deviceId)
    return monitor
  }

  async updateScene(input: {
    deviceId: number
    monitorId: string
    patch: {
      label?: string
      roi?: MaskRectShape
      enabled?: boolean
      triggerMode?: 'periodic' | 'on-motion' | 'both'
      checkIntervalSec?: number
      check?: SceneCheck
      emit?: 'latched' | 'live'
      quietSeconds?: number
      minObservationSpacingSec?: number
      anchorThreshold?: number
      autoRestore?: boolean
      onUncoveredCondition?: SceneUncoveredPolicy
      confirm?: SceneMonitor['confirm'] | null
    }
  }): Promise<void> {
    const current = this.requireScene(input.deviceId, input.monitorId)
    const { confirm, ...rest } = input.patch
    // Immutable: a new monitor, never a mutated one. `confirm: null` is the
    // operator CLEARING the adjudicator, which `undefined` cannot express.
    const next: SceneMonitor = {
      ...current,
      ...definedOnly(rest),
      ...(confirm === null ? {} : confirm !== undefined ? { confirm } : {}),
    }
    if (confirm === null) delete (next as { confirm?: unknown }).confirm
    await this.deps.store.putScene(input.deviceId, next, this.now())
    this.refresh(input.deviceId)
  }

  async deleteScene(input: { deviceId: number; monitorId: string }): Promise<void> {
    const doomed = this.deps.store.getScene(input.deviceId, input.monitorId)
    await this.deps.store.deleteScene(input.deviceId, input.monitorId)
    // Scene media is retention-exempt, so a deleted scene's pictures are
    // unreachable by every sweep in the system: if they do not leave here they
    // never leave.
    await this.dropOrphanedMedia(doomed?.monitor.states.flatMap((s) => s.references) ?? [])
    this.deps.logger.info('scene deleted', {
      tags: { deviceId: input.deviceId },
      meta: { monitorId: input.monitorId },
    })
    this.refresh(input.deviceId)
  }

  /**
   * Capture the operator's "this is the initial state".
   *
   * This is the ONE legitimate `force: true` snapshot in the codebase. `force`
   * walks past a battery camera's sleep gate, which is why every background
   * caller is forbidden from setting it — but here the operator is standing at
   * the UI pressing a button, and a reference captured from a ten-minute-old
   * cached frame is a reference of the wrong world.
   */
  async captureReference(input: {
    deviceId: number
    monitorId: string
    stateId?: string
    label?: string
    condition?: SceneCondition
  }): Promise<{ stateId: string; referenceCount: number }> {
    const monitor = this.requireScene(input.deviceId, input.monitorId)
    const condition = input.condition ?? (await this.deps.currentCondition(input.deviceId))
    const reference = await this.encodeReference(input.deviceId, monitor, condition)

    const stateId = input.stateId ?? monitor.states[0]?.id ?? randomUUID()
    const existing = monitor.states.find((s) => s.id === stateId)
    const label = input.label ?? existing?.label ?? monitor.label
    const kept = [...(existing?.references ?? []), reference]
    const references = boundReferences(kept, condition)
    // Whatever the bound EVICTED owns a picture nothing will ever collect
    // (scene media is retention-exempt), so it leaves with the reference.
    await this.dropOrphanedMedia(kept.filter((r) => !references.includes(r)))
    const state: SceneMonitorState = {
      id: stateId,
      label,
      references,
      referenceCount: references.length,
      currentlyMatched: existing?.currentlyMatched ?? false,
    }
    const states =
      existing === undefined
        ? [...monitor.states, state]
        : monitor.states.map((s) => (s.id === stateId ? state : s))

    const next: SceneMonitor = {
      ...monitor,
      states,
      // The first captured state IS the baseline; a scene is not a boolean
      // until something says which side of it is "normal".
      baselineStateId: monitor.baselineStateId ?? stateId,
    }
    await this.deps.store.putScene(input.deviceId, next, this.now())
    this.deps.logger.info('scene reference captured', {
      tags: { deviceId: input.deviceId },
      meta: {
        monitorId: monitor.id,
        stateId,
        condition,
        references: references.length,
        anchored: reference.anchorEmbedding !== undefined,
      },
    })
    this.refresh(input.deviceId)
    void this.engine?.recheck(input.deviceId, monitor.id)
    return { stateId, referenceCount: references.length }
  }

  async deleteReference(input: {
    deviceId: number
    monitorId: string
    stateId: string
    index: number
  }): Promise<void> {
    const monitor = this.requireScene(input.deviceId, input.monitorId)
    const removed = monitor.states.find((s) => s.id === input.stateId)?.references[input.index]
    const states = monitor.states.map((s) => {
      if (s.id !== input.stateId) return s
      const references = s.references.filter((_, i) => i !== input.index)
      return { ...s, references, referenceCount: references.length }
    })
    await this.deps.store.putScene(input.deviceId, { ...monitor, states }, this.now())
    // The row is authoritative and already written; the picture is a follower.
    // Dropping it AFTER the write means a failed media delete costs a stray
    // blob, never a reference the operator asked to be rid of and still sees.
    await this.dropOrphanedMedia(removed === undefined ? [] : [removed])
    this.deps.logger.info('scene reference deleted', {
      tags: { deviceId: input.deviceId },
      meta: {
        monitorId: input.monitorId,
        stateId: input.stateId,
        index: input.index,
        condition: removed?.condition ?? '(none)',
        remaining: states.reduce((n, s) => n + s.references.length, 0),
      },
    })
    this.refresh(input.deviceId)
  }

  async recheckNow(input: { deviceId: number; monitorId: string }): Promise<void> {
    this.requireScene(input.deviceId, input.monitorId)
    await this.engine?.recheck(input.deviceId, input.monitorId)
  }

  /**
   * Clear the latch, re-arm, and — by default — RE-CAPTURE the baseline for the
   * current condition.
   *
   * The re-capture is the operator's own decision and it is the right one: the
   * bin never goes back in exactly the same spot, so a reset that only re-armed
   * would compare next week's world against last week's photograph and diverge
   * on the wheel angle. Re-capture makes "reset" mean what the operator means
   * by it — *this is the new normal* — and makes the feature self-healing
   * against slow drift instead of failing silently weeks later.
   *
   * It REPLACES that condition's reference set rather than appending: an old
   * baseline left in place would keep matching, and the scene would never
   * diverge again.
   */
  async resetScene(input: {
    deviceId: number
    monitorId: string
    recapture?: boolean
  }): Promise<void> {
    const monitor = this.requireScene(input.deviceId, input.monitorId)
    const now = this.now()
    const recapture = input.recapture ?? SCENE_RESET_RECAPTURES

    let next: SceneMonitor = monitor
    let recaptured = false
    if (recapture) {
      const condition = await this.deps.currentCondition(input.deviceId)
      // A capture that fails must not cost the operator the RE-ARM: they
      // pressed reset to clear an alarm, and refusing because the camera is
      // asleep would leave the latch stuck exactly when they need it gone.
      const reference = await this.encodeReference(input.deviceId, monitor, condition).catch(
        (err: unknown) => {
          this.deps.logger.warn('scene reset could not re-capture the baseline — re-arming only', {
            tags: { deviceId: input.deviceId },
            meta: { monitorId: monitor.id, condition, error: String(err) },
          })
          return null
        },
      )
      if (reference !== null) {
        next = replaceConditionReferences(monitor, condition, reference)
        recaptured = true
      }
    }

    const baselineStateId = next.baselineStateId
    next = {
      ...next,
      currentStateId: baselineStateId,
      verdict: baselineStateId === null ? 'unknown' : 'matched',
      latched: false,
      armedAt: now,
      divergedAt: null,
      restoredAt: null,
      unavailable: baselineStateId === null ? 'no-reference-for-condition' : null,
    }
    await this.deps.store.putScene(input.deviceId, next, now)
    await this.deps.store.putLatch({
      ...this.freshLatch(input.deviceId, monitor.id, now),
      verdict: next.verdict,
      currentStateId: baselineStateId,
      unavailable: next.unavailable,
    })
    this.engine?.resetMonitor(input.deviceId, monitor.id, baselineStateId)
    this.deps.logger.info('scene reset', {
      tags: { deviceId: input.deviceId },
      meta: { monitorId: monitor.id, recaptured, requestedRecapture: recapture },
    })
    this.refresh(input.deviceId)
    void this.engine?.recheck(input.deviceId, monitor.id)
  }

  // ── engine callback ─────────────────────────────────────────────────────

  /**
   * The engine observed something. Derive the latch, persist it write-through,
   * mirror it, and emit — in that order, so a persist failure never leaves a
   * notification the durable record cannot explain.
   */
  async applyEngineResult(
    deviceId: number,
    monitorId: string,
    result: SceneEngineResult,
  ): Promise<void> {
    const row = this.deps.store.getScene(deviceId, monitorId)
    if (row === undefined) return
    const monitor = row.monitor

    // ---- A SKIPPED check is not an observation. ----
    // The scene sat this light out because the operator never captured a
    // reference for it — the optional half of the feature working as designed,
    // not a failure. So the LATCH is not written at all: not `verdict`, not
    // `latched`, not `lastCheckedAt`, and above all not the `autoRestore` path
    // that would quietly clear a week of flag on hours of checks that were
    // never made. Only the advisory config fields move, so the card can name
    // the light it is sitting out in the same calm voice as the coverage line.
    if (result.suspendedCondition !== null) {
      await this.deps.store.putScene(
        deviceId,
        {
          ...monitor,
          suspendedCondition: result.suspendedCondition,
          coveredConditions: [...result.coveredConditions],
        },
        result.checkedAt,
      )
      this.refresh(deviceId)
      return
    }

    const previous = this.deps.store.getLatch(deviceId, monitorId)
    const wasLatched = previous?.latched ?? monitor.latched
    const wasVerdict = previous?.verdict ?? monitor.verdict

    const diverged = result.verdict === 'diverged'
    const restored = result.verdict === 'matched' && wasVerdict === 'diverged'
    // `unknown` never moves the latch in EITHER direction: a scene that cannot
    // judge has not observed anything, and an observation it could not make
    // must never clear a week of latch state (D49, applied to an observation).
    const latched =
      result.verdict === 'unknown'
        ? wasLatched
        : diverged
          ? true
          : monitor.autoRestore
            ? false
            : wasLatched

    const latch: SceneLatchRow = {
      key: sceneKey(deviceId, monitorId),
      deviceId,
      monitorId,
      verdict: result.verdict,
      unavailable: result.unavailable,
      currentStateId: result.currentStateId,
      latched,
      armedAt: previous?.armedAt ?? monitor.armedAt,
      divergedAt: diverged ? result.checkedAt : (previous?.divergedAt ?? monitor.divergedAt),
      restoredAt: restored ? result.checkedAt : (previous?.restoredAt ?? monitor.restoredAt),
      lastCheckedAt: result.checkedAt,
      lastConfidence: result.lastConfidence,
      currentCondition: result.currentCondition,
      updatedAt: result.checkedAt,
    }
    await this.deps.store.putLatch(latch)

    const merged: SceneMonitor = {
      ...monitor,
      coveredConditions: [...result.coveredConditions],
      // A real check clears the pause marker. Leaving it set would tell the
      // operator the scene is still sitting out a light it has just judged in.
      suspendedCondition: null,
      availability: result.availability,
      unavailableReason: result.unavailableReason,
    }
    await this.deps.store.putScene(deviceId, merged, result.checkedAt)
    this.refresh(deviceId)

    if (!result.transitioned) return

    // Latch and EDGE are different facts. `scene-restored` is emitted even
    // while the latch holds, so an automation can react to the bin coming back
    // without the operator's own alarm silently clearing itself.
    const direction: 'diverged' | 'restored' | null = diverged
      ? 'diverged'
      : restored
        ? 'restored'
        : null
    this.deps.logger.info('scene transition', {
      tags: { deviceId },
      meta: {
        monitorId,
        from: result.previousStateId ?? '(none)',
        to: result.currentStateId ?? '(none)',
        verdict: result.verdict,
        latched,
        condition: result.currentCondition,
        confidence: result.lastConfidence,
      },
    })
    this.deps.emitStateChanged({
      deviceId,
      monitorId,
      monitorLabel: monitor.label,
      previousState: result.previousStateId ?? '',
      currentState: result.currentStateId ?? '',
      confidence: result.lastConfidence ?? 0,
      timestamp: result.checkedAt,
    })
    if (direction !== null) {
      this.deps.onSceneEdge?.({
        deviceId,
        monitorId,
        monitorLabel: monitor.label,
        direction,
        verdict: result.verdict,
        latched,
        emit: monitor.emit,
        condition: result.currentCondition,
        confidence: result.lastConfidence,
        timestamp: result.checkedAt,
      })
    }
  }

  /** Every ENABLED scene across all devices — the engine's read surface. */
  listAllEnabled(): ReadonlyArray<{ deviceId: number; monitor: SceneMonitor }> {
    return this.deps.store
      .listScenes()
      .filter((r) => r.monitor.enabled)
      .map((r) => ({ deviceId: r.deviceId, monitor: this.merged(r.deviceId, r.monitor) }))
  }

  // ── internals ───────────────────────────────────────────────────────────

  private statusFor(deviceId: number): SceneMonitorStatus {
    const monitors = this.deps.store
      .listScenes()
      .filter((r) => r.deviceId === deviceId)
      .map((r) => this.merged(deviceId, r.monitor))
    return { monitors, lastFetchedAt: this.now() }
  }

  /** The config row plus the durable latch — the latch is the authority for
   *  every field it carries, and the config copy is only a stale mirror. */
  private merged(deviceId: number, monitor: SceneMonitor): SceneMonitor {
    const latch = this.deps.store.getLatch(deviceId, monitor.id)
    if (latch === undefined) return monitor
    return {
      ...monitor,
      verdict: latch.verdict,
      unavailable: latch.unavailable,
      currentStateId: latch.currentStateId,
      latched: latch.latched,
      armedAt: latch.armedAt,
      divergedAt: latch.divergedAt,
      restoredAt: latch.restoredAt,
      lastCheckedAt: latch.lastCheckedAt,
      lastConfidence: latch.lastConfidence,
      currentCondition: latch.currentCondition,
      states: monitor.states.map((s) => ({
        ...s,
        currentlyMatched: s.id === latch.currentStateId,
      })),
    }
  }

  private refresh(deviceId: number): void {
    this.deps.mirrorSlice(deviceId, this.statusFor(deviceId))
  }

  private requireScene(deviceId: number, monitorId: string): SceneMonitor {
    const row = this.deps.store.getScene(deviceId, monitorId)
    if (row === undefined) throw new Error(`scene not found: ${deviceId}/${monitorId}`)
    return row.monitor
  }

  private freshLatch(deviceId: number, monitorId: string, now: number): SceneLatchRow {
    return {
      key: sceneKey(deviceId, monitorId),
      deviceId,
      monitorId,
      verdict: 'unknown',
      unavailable: 'no-reference-for-condition',
      currentStateId: null,
      latched: false,
      armedAt: now,
      divergedAt: null,
      restoredAt: null,
      lastCheckedAt: null,
      lastConfidence: null,
      currentCondition: null,
      updatedAt: now,
    }
  }

  /**
   * Drop the pictures of references that are no longer stored anywhere.
   *
   * Best-effort per blob and never throwing: the reference row is already gone,
   * and refusing the operator's delete because a JPEG would not unlink would be
   * failing the request over the follower rather than the fact.
   */
  private async dropOrphanedMedia(references: readonly SceneReference[]): Promise<void> {
    const drop = this.deps.dropMedia
    if (drop === undefined) return
    for (const r of references) {
      if (r.thumbnailMediaId === undefined) continue
      await drop(r.thumbnailMediaId).catch((err: unknown) => {
        this.deps.logger.debug('scene reference thumbnail delete failed', {
          meta: { mediaId: r.thumbnailMediaId, error: String(err) },
        })
      })
    }
  }

  /** Snapshot → ROI crop + whole-frame anchor → two embeddings + a thumbnail. */
  private async encodeReference(
    deviceId: number,
    monitor: SceneMonitor,
    condition: SceneCondition,
  ): Promise<SceneReference> {
    const capturedAt = this.now()
    const snap = await this.deps.getSnapshot(deviceId, true)
    if (snap === null) throw new Error('no snapshot available for this camera')
    const encoded = Buffer.from(snap.base64, 'base64')
    const roi = await cropSnapshotRoi(encoded, monitor.roi)
    const [{ embedding }, info] = await Promise.all([
      this.deps.encoder.encode(roi.crop, roi.width, roi.height),
      this.deps.encoder.getInfo(),
    ])

    // The anchor is best-effort: a scene with references but no anchor is a
    // scene without the view-shift guard, which is worse than having it and
    // far better than a capture that refused.
    const anchor = await anchorFrame(encoded)
      .then((a) => this.deps.encoder.encode(a.crop, a.width, a.height))
      .then((r) => r.embedding)
      .catch((err: unknown) => {
        this.deps.logger.warn('scene anchor encode failed — capturing without the view guard', {
          tags: { deviceId },
          meta: { monitorId: monitor.id, error: String(err) },
        })
        return null
      })

    // The owner id carries `capturedAt`, so every reference owns its OWN
    // picture. It used to be `scene-<id>-<condition>`, and `thumbnailSmall` is
    // a single-instance kind: all six references a condition may hold shared
    // one blob, and each capture overwrote the last. A gallery built on that
    // would show the operator six copies of the newest photograph while asking
    // them to pick out the blurry one.
    const thumbnailMediaId = await this.deps
      .putMedia?.({
        deviceId,
        ownerId: `scene-${monitor.id}-${condition}-${capturedAt}`,
        data: roi.crop,
        timestamp: capturedAt,
      })
      .catch(() => undefined)

    return {
      embedding,
      modelId: info.modelId,
      condition,
      capturedAt,
      ...(thumbnailMediaId !== undefined ? { thumbnailMediaId } : {}),
      ...(anchor !== null ? { anchorEmbedding: anchor } : {}),
    }
  }
}

/** Drop `undefined` values so a patch never overwrites a field it omitted. */
function definedOnly<T extends Record<string, unknown>>(patch: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) out[k] = v
  }
  return out as Partial<T>
}

/**
 * Keep the reference set bounded — newest first within a condition, and at most
 * {@link SCENE_MAX_CONDITIONS} conditions. Without this, a capture loop grows a
 * scene row without bound: each reference carries two 512-float embeddings.
 */
function boundReferences(
  references: readonly SceneReference[],
  captured: SceneCondition,
): SceneReference[] {
  const byCondition = new Map<SceneCondition, SceneReference[]>()
  for (const r of references) {
    const list = byCondition.get(r.condition) ?? []
    list.push(r)
    byCondition.set(r.condition, list)
  }
  const conditions = [...byCondition.keys()]
  // The condition just captured is never the one evicted.
  const kept = conditions
    .filter((c) => c === captured)
    .concat(conditions.filter((c) => c !== captured).slice(0, SCENE_MAX_CONDITIONS - 1))
  const out: SceneReference[] = []
  for (const c of kept) {
    const list = [...(byCondition.get(c) ?? [])].sort((a, b) => b.capturedAt - a.capturedAt)
    out.push(...list.slice(0, SCENE_MAX_REFS_PER_CONDITION))
  }
  return out
}

/**
 * Replace one condition's reference set — the reset path. Appending would leave
 * the OLD baseline in place, it would keep matching, and the scene would never
 * be able to diverge again: a reset that quietly disarmed the alarm forever.
 */
function replaceConditionReferences(
  monitor: SceneMonitor,
  condition: SceneCondition,
  reference: SceneReference,
): SceneMonitor {
  const baselineStateId = monitor.baselineStateId ?? monitor.states[0]?.id ?? randomUUID()
  const existing = monitor.states.find((s) => s.id === baselineStateId)
  const references = [
    ...(existing?.references ?? []).filter((r) => r.condition !== condition),
    reference,
  ]
  const state: SceneMonitorState = {
    id: baselineStateId,
    label: existing?.label ?? monitor.label,
    references,
    referenceCount: references.length,
    currentlyMatched: true,
  }
  const states =
    existing === undefined
      ? [...monitor.states, state]
      : monitor.states.map((s) => (s.id === baselineStateId ? state : s))
  return { ...monitor, states, baselineStateId }
}

/** `SCENE_DIVERGED` is engine-owned and must never appear in `states[]`. */
export function isReservedStateId(id: string): boolean {
  return id === SCENE_DIVERGED
}
