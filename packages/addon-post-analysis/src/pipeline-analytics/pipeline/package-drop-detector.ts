/**
 * PackageDropDetector — turns stationary-registry appear/depart signals into
 * package-delivered / package-picked-up events.
 *
 * A delivered package is a newly-appeared stationary object of a package
 * class inside a package zone. The heavy lifting (promote-after-stillness,
 * persist, IoU-wake departure, hydrate-without-refire) is already done by
 * `StationaryObjectRegistry`; this detector is a thin consumer of its
 * `onChange` — no new frame path, no hot loop.
 *
 * MODEL-AGNOSTIC: it gates purely on `entry.className ∈ classFilter`
 * (default `['package']`). The class source can be the interim COCO vector
 * (suitcase/backpack/handbag → package) OR a dedicated parcel model
 * emitting `class:'package'` — the detector never branches on which.
 *
 * Durable events are STANDARD object-events (className `package`, state
 * `idle` for a delivery / `left` for a pick-up), so the timeline, event
 * media and retention cascade all work with zero new plane. Delivery and
 * pick-up rows carry a DETERMINISTIC `idempotencyKey` derived from the
 * stationary entry id (it was their primary key until D474 made an event id
 * the rowid), which makes the detector idempotent and restart-safe: the registry
 * hydrates on boot WITHOUT firing `onChange`, so a parcel present across a
 * restart never re-fires `delivered`, and a `picked-up` after a restart
 * still pairs to the persisted delivery row.
 *
 * See docs/superpowers/specs/2026-07-17-package-zones-design.md §5.
 */
import type {
  IScopedLogger,
  ObjectEvent,
  ObjectEventDraft,
  PackageLlmVerdict,
  PipelineAnalyticsPackageDeliveredPayload,
  PipelineAnalyticsPackagePickedUpPayload,
  Zone,
  ZoneRule,
} from '@camstack/types'
import type { PackageDropSettings } from '../package-settings.js'
import { type PackageCollector, pickupInstantOf } from './package/package-collector-mirror.js'
import type { PackageLlmConfirmOutcome } from './package/package-llm-confirm.js'
import {
  packageLlmAlertReason,
  PackageLlmSilence,
  type PackageLlmSilenceEdge,
  type PackageLlmUncertainDetail,
} from './package/package-llm-silence.js'
import { packageReferenceArea } from './package/package-reference-area.js'
import type { StationaryEntry } from './stationary/stationary-types.js'
import { computeStationaryEntryZones } from './stationary/stationary-zones.js'

interface PackageLlmEventFields {
  readonly packageLlmVerdict?: PackageLlmVerdict
}

/** The class every durable package event carries. */
export const PACKAGE_EVENT_CLASS = 'package'
/** Fixed high importance — package delivery is inherently high-signal (§6). */
const PACKAGE_IMPORTANCE = 1

/** Object-event `state` used for a delivery (a parked package) / a pick-up
 *  (its departure). Both are valid `TrackState` enum members so the events
 *  stay `getObjectEvents`-output-valid. */
const DELIVERED_STATE = 'idle' as const
const PICKED_UP_STATE = 'left' as const

/**
 * Deterministic IDEMPOTENCE keys, one per (stationary entry, phase).
 *
 * These were the event ids until D474 made an event id the SQLite rowid, which
 * the database assigns and a producer cannot choose. They kept their exact
 * spelling and moved to `ObjectEvent.idempotencyKey`: the gates below are the
 * only reason a restart does not re-deliver every parcel, and the strings are
 * on 2.1 million existing rows' primary key, so a row written before the
 * rebuild is still recognisable by the same text.
 *
 * They are NOT event ids any more. `eventId` on the emitted payload and in
 * every log line is the row's real id.
 */
export function deliveredIdempotencyKey(entryId: string): string {
  return `pa-pkg-${entryId}-delivered`
}
export function pickedUpIdempotencyKey(entryId: string): string {
  return `pa-pkg-${entryId}-pickedup`
}

/** The stationary-registry change the detector consumes. */
export interface StationaryChange {
  readonly phase: 'appeared' | 'departed'
  readonly entry: StationaryEntry
  readonly timestamp: number
  /**
   * WHO took the parcel, on a `departed` change (D404).
   *
   * Resolved by the PRODUCER (`PackageCollectorMirror`, fed from the live
   * frame loop) because a departure is concluded minutes after the fact and
   * the collector's track no longer exists by then. Absent means nobody
   * qualified — the pick-up still fires, carrying the parcel's own owner.
   */
  readonly collector?: PackageCollector
}

/** The object-event surface the detector needs (EventStore satisfies it). */
export interface PackageObjectEventClient {
  insertObject(ev: ObjectEventDraft): Promise<number | null>
  queryObject(q: { deviceId: number; classFilter?: string }): Promise<readonly ObjectEvent[]>
}

export interface PackageDropEmitter {
  delivered(payload: PipelineAnalyticsPackageDeliveredPayload): void
  pickedUp(payload: PipelineAnalyticsPackagePickedUpPayload): void
}

export interface PackageDropDetectorDeps {
  readonly events: PackageObjectEventClient
  readonly emit: PackageDropEmitter
  readonly logger: IScopedLogger
  /** Device's current 0–1 zone catalogue (geometry). */
  readonly resolveZones: (deviceId: number) => Promise<readonly Zone[]>
  /** Device's `package`-stage zone rules (behaviour). */
  readonly resolvePackageRules: (deviceId: number) => Promise<readonly ZoneRule[]>
  /** Device's package-drop settings (per-device, TTL-cached). */
  readonly resolveSettings: (deviceId: number) => Promise<PackageDropSettings>
  /**
   * `TrackingSettings.zoneMembershipMinOverlap` — same bar live stamps use.
   * Required so package zone gating never invents a second threshold.
   */
  readonly resolveZoneMembershipMinOverlap: (deviceId: number) => Promise<number>
  /**
   * Fired AFTER a package object-event is durably inserted (the Notification
   * Center `package-event` persist hook, D-2). Best-effort — the caller owns
   * error handling; a throw here would abort the emit below.
   *
   * The row is ALL it hands over (D684): a pick-up's instant rides on
   * `ev.observedAt`, the same field the reconcile reads back from the table, so
   * the live hook and a replay cannot anchor the footage differently.
   */
  readonly onPersisted?: (ev: ObjectEvent, phase: 'delivered' | 'picked-up') => void
  readonly onError?: (scope: string, err: unknown) => void
  /**
   * Vision confirm for a packages rule with `confirmWithLlm` (D931).
   * Absent is an uncertain confirm: the candidate is dropped.
   */
  readonly confirmPackage?: (input: {
    readonly deviceId: number
    readonly entryId: string
    readonly zoneIds: readonly string[]
  }) => Promise<PackageLlmConfirmOutcome>
  /**
   * Silence / recovery edge for the package-confirm system event (D931).
   * One open edge per camera. A missing reporter is logged, not swallowed.
   */
  readonly onLlmSilence?: (edge: PackageLlmSilenceEdge) => void
}

export class PackageDropDetector {
  private readonly deps: PackageDropDetectorDeps
  /** Per-device mirror of the last LOGGED value of the `packageDropEnabled`
   *  switch, so gate 0 logs a transition instead of one line per promotion. */
  private readonly disabledLogged = new Map<number, boolean>()
  private readonly llmSilence = new PackageLlmSilence()

  constructor(deps: PackageDropDetectorDeps) {
    this.deps = deps
  }

  /**
   * LLM gate (D931). `null` means the delivery is dropped (no, or no yes).
   * An empty object means the rule did not ask. A verdict is spread onto the row.
   */
  private async llmFields(
    entry: StationaryEntry,
    rules: readonly ZoneRule[],
    hitZones: readonly string[],
    tags: { readonly deviceId: number },
  ): Promise<PackageLlmEventFields | null> {
    const wants = rules.some(
      (rule) => rule.confirmWithLlm === true && rule.zoneIds.some((id) => hitZones.includes(id)),
    )
    if (!wants) return {}
    const confirm = this.deps.confirmPackage
    if (!confirm) {
      this.dropUncertain(entry, tags, 'unwired', 0)
      return null
    }
    const started = Date.now()
    const outcome = await confirm({
      deviceId: entry.deviceId,
      entryId: entry.id,
      zoneIds: hitZones,
    })
    const latencyMs = Date.now() - started
    if (outcome.kind === 'no') {
      this.deps.logger.info('package dropped — llm said no parcel', {
        tags,
        meta: {
          entryId: entry.id,
          reason: outcome.verdict.reason,
          confidence: outcome.verdict.confidence,
          latencyMs,
        },
      })
      this.reportLlmSilence(this.llmSilence.noteAnswered(entry.deviceId), tags)
      return null
    }
    if (outcome.kind === 'yes') {
      this.reportLlmSilence(this.llmSilence.noteAnswered(entry.deviceId), tags)
      return { packageLlmVerdict: outcome.verdict }
    }
    this.dropUncertain(entry, tags, outcome.reason, latencyMs)
    return null
  }

  /** Fail-closed (D931): no `yes` is no event. The drop is logged (D391). */
  private dropUncertain(
    entry: StationaryEntry,
    tags: { readonly deviceId: number },
    detail: PackageLlmUncertainDetail,
    latencyMs: number,
  ): void {
    this.deps.logger.info('package llm confirm uncertain — dropping candidate', {
      tags,
      meta: { entryId: entry.id, reason: detail, latencyMs },
    })
    this.reportLlmSilence(
      this.llmSilence.noteUncertain({
        deviceId: entry.deviceId,
        reason: packageLlmAlertReason(detail),
        detail,
        latencyMs,
      }),
      tags,
    )
  }

  private reportLlmSilence(
    edge: PackageLlmSilenceEdge | null,
    tags: { readonly deviceId: number },
  ): void {
    if (edge === null) return
    const report = this.deps.onLlmSilence
    if (report === undefined) {
      this.deps.logger.warn('package llm silence edge has no reporter', {
        tags,
        meta: { phase: edge.phase },
      })
      return
    }
    report(edge)
  }

  /** Log the `packageDropEnabled` switch only when it MOVES for a device. */
  private noteDisabled(deviceId: number, disabled: boolean): void {
    if (this.disabledLogged.get(deviceId) === disabled) return
    this.disabledLogged.set(deviceId, disabled)
    if (disabled) {
      this.deps.logger.info('package gate 0/5 switch — packageDropEnabled is false', {
        tags: { deviceId },
      })
    }
  }

  /** Drop a device's gate-log mirror (unbind / teardown). */
  forgetDevice(deviceId: number): void {
    this.disabledLogged.delete(deviceId)
    this.llmSilence.forget(deviceId)
  }

  /** Single entrypoint — bridge the registry's `onChange` here. Never
   *  throws (telemetry-lossy, D8): a failure only misses one package event. */
  async onStationaryChange(change: StationaryChange): Promise<void> {
    try {
      if (change.phase === 'appeared') {
        await this.onAppeared(change.entry, change.timestamp)
      } else {
        await this.onDeparted(change)
      }
    } catch (err) {
      this.deps.onError?.('onStationaryChange', err)
      this.deps.logger.warn('package-drop detector failed on change', {
        tags: { deviceId: change.entry.deviceId },
        meta: {
          phase: change.phase,
          entryId: change.entry.id,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
  }

  // ── appeared → package-delivered ─────────────────────────────────────
  private async onAppeared(entry: StationaryEntry, timestamp: number): Promise<void> {
    const settings = await this.deps.resolveSettings(entry.deviceId)
    if (!settings.packageDropEnabled) {
      // Transition-logged: this fires on every promotion of every class on a
      // camera the operator switched off, so it says it ONCE and then stays
      // quiet until the switch moves.
      this.noteDisabled(entry.deviceId, true)
      return
    }
    this.noteDisabled(entry.deviceId, false)

    // (1) Class gate — excludes person / vehicle / animal outright. DEBUG: the
    //     generic registry promotes every parked car through here, so an info
    //     line would be pure noise on a parking-lot camera.
    if (!settings.packageDropClassFilter.includes(entry.className)) {
      this.deps.logger.debug('package gate 1/5 class — not a package class', {
        tags: { deviceId: entry.deviceId },
        meta: {
          entryId: entry.id,
          className: entry.className,
          classFilter: settings.packageDropClassFilter,
        },
      })
      return
    }

    // Past the class gate this is a real package-class entry: rare by
    // construction, so every remaining rejection is logged at info. Silence on
    // a dropped package is what made this chain unfalsifiable for a year.
    const tags = { deviceId: entry.deviceId }

    // (2) Zone gate — the entry's bbox must overlap a zone referenced by an
    //     ENABLED package rule (same membership path as live / occupancy).
    const rules = (await this.deps.resolvePackageRules(entry.deviceId)).filter(
      (r) => r.enabled !== false,
    )
    if (rules.length === 0) {
      this.deps.logger.info('package gate 2/5 zone — no enabled package-stage zone rule', {
        tags,
        meta: { entryId: entry.id, className: entry.className },
      })
      return
    }
    const ruleZoneIds = new Set<string>(rules.flatMap((r) => r.zoneIds))
    const zones = await this.deps.resolveZones(entry.deviceId)
    const minOverlap = await this.deps.resolveZoneMembershipMinOverlap(entry.deviceId)
    const entryZones = computeStationaryEntryZones(entry, zones, minOverlap)
    const hitZones = entryZones.filter((z) => ruleZoneIds.has(z))
    if (hitZones.length === 0) {
      this.deps.logger.info('package gate 2/5 zone — no package zone meets membership overlap', {
        tags,
        meta: {
          entryId: entry.id,
          bbox: entry.bbox,
          entryZones,
          minOverlap,
          ruleZoneIds: [...ruleZoneIds],
          zonesOnDevice: zones.length,
        },
      })
      return
    }

    // (3) Dwell gate — observed time since first-seen. The dedicated package
    //     path never promotes before this has elapsed, so a rejection here
    //     means the entry came from the GENERIC registry.
    const dwellMs = timestamp - entry.firstSeenAt
    const requiredDwellMs = settings.packageDropDwellSec * 1000
    if (dwellMs < requiredDwellMs) {
      this.deps.logger.info('package gate 3/5 dwell — not still long enough', {
        tags,
        meta: { entryId: entry.id, dwellMs, requiredDwellMs },
      })
      return
    }

    // (4) Size gate — reject tiny far-field blobs / detector flicker.
    const frameArea = entry.frameWidth * entry.frameHeight
    if (frameArea <= 0) {
      this.deps.logger.info('package gate 4/5 size — frame dimensions unknown', {
        tags,
        meta: {
          entryId: entry.id,
          frameWidth: entry.frameWidth,
          frameHeight: entry.frameHeight,
        },
      })
      return
    }
    const ruleZoneIdSet = new Set<string>(rules.flatMap((r) => r.zoneIds))
    const ref = packageReferenceArea({
      zones,
      packageZoneIds: ruleZoneIdSet,
      frameWidth: entry.frameWidth,
      frameHeight: entry.frameHeight,
    })
    const minDenom = ref.areaPx > 0 ? ref.areaPx : frameArea
    const minAreaFrac = (entry.bbox.w * entry.bbox.h) / minDenom
    if (minAreaFrac < settings.packageDropMinBboxAreaFrac) {
      this.deps.logger.info('package gate 4/5 size — bbox below the minimum area', {
        tags,
        meta: {
          entryId: entry.id,
          areaFrac: Number(minAreaFrac.toFixed(5)),
          minAreaFrac: settings.packageDropMinBboxAreaFrac,
          referenceKind: ref.kind,
          referenceAreaPx: ref.areaPx,
          bbox: entry.bbox,
          frame: [entry.frameWidth, entry.frameHeight],
        },
      })
      return
    }
    const maxAreaFrac = (entry.bbox.w * entry.bbox.h) / frameArea
    // Ceiling — a near-scene-sized "package" is scenery, not a parcel. Device
    // 101's streetlight wedge (7.96–9.47% of frame, conf up to 0.877) produced
    // 348/350 of all package FPs; real parcels measured ≤1.72%. The stillness
    // path filters this before a candidate ever opens (`package-area-gate.ts`);
    // this is the same bound at the event gate, for entries from ANY producer.
    if (maxAreaFrac > settings.packageDropMaxBboxAreaFrac) {
      this.deps.logger.info('package gate 4/5 size — bbox above the maximum area', {
        tags,
        meta: {
          entryId: entry.id,
          areaFrac: Number(maxAreaFrac.toFixed(5)),
          maxAreaFrac: settings.packageDropMaxBboxAreaFrac,
          bbox: entry.bbox,
          frame: [entry.frameWidth, entry.frameHeight],
        },
      })
      return
    }

    // (5) Idempotence gate — never emit a second delivery for the same entry
    //     (a spurious re-appear, or a replayed change post-restart).
    const idempotencyKey = deliveredIdempotencyKey(entry.id)
    const existing = await this.deps.events.queryObject({
      deviceId: entry.deviceId,
      classFilter: PACKAGE_EVENT_CLASS,
    })
    // A row written before the rebuild carries the key as its `id`; one written
    // after carries it in `idempotencyKey`. Both are checked, or the first boot
    // on a rebuilt table re-delivers every parcel still on a doormat.
    const alreadyDelivered = existing.find(
      (e) => e.idempotencyKey === idempotencyKey || String(e.id) === idempotencyKey,
    )
    if (alreadyDelivered !== undefined) {
      this.deps.logger.info('package gate 5/5 idempotence — delivery already recorded', {
        tags,
        meta: { entryId: entry.id, idempotencyKey, eventId: alreadyDelivered.id },
      })
      return
    }

    const llm = await this.llmFields(entry, rules, hitZones, tags)
    if (llm === null) return

    const draft: ObjectEventDraft = {
      kind: 'object',
      deviceId: entry.deviceId,
      timestamp,
      source: 'pipeline',
      idempotencyKey,
      // Cascade under the source track's retention prune when known.
      trackId: entry.sourceTrackId ?? entry.id,
      className: PACKAGE_EVENT_CLASS,
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      // The DETECTOR's score when the producer knows it. A fixed 1 here made
      // every notification rule's `minConfidence` a no-op on package events,
      // which leaves an operator no lever at all against a recurring false
      // positive (101's doormat scores 0.53–0.60). `importance` stays fixed.
      confidence: entry.confidence ?? PACKAGE_IMPORTANCE,
      bbox: {
        x: entry.bbox.x,
        y: entry.bbox.y,
        w: entry.bbox.w,
        h: entry.bbox.h,
      },
      zones: hitZones,
      state: DELIVERED_STATE,
      frameWidth: entry.frameWidth,
      frameHeight: entry.frameHeight,
      // The parcel crop resolves via the standard event-media plane.
      ...(entry.keyFrameMediaId !== undefined ? { mediaId: entry.keyFrameMediaId } : {}),
      importance: PACKAGE_IMPORTANCE,
      ...llm,
    }
    // The id is the ROWID the insert assigned and there is nowhere else to
    // learn it (D474). A failed write means there IS no delivery: emitting a
    // payload with an invented id would point the media ladder at `event:NaN`,
    // and the next appear would re-deliver anyway because no row exists to gate
    // on. Say so and stop.
    const rowId = await this.deps.events.insertObject(draft)
    if (rowId === null) {
      this.deps.logger.warn('package delivery NOT emitted — the event row did not persist', {
        tags,
        meta: { entryId: entry.id, idempotencyKey },
      })
      return
    }
    const ev: ObjectEvent = { ...draft, id: rowId }
    this.deps.onPersisted?.(ev, 'delivered')

    this.deps.emit.delivered({
      deviceId: entry.deviceId,
      entryId: entry.id,
      eventId: String(rowId),
      className: entry.className,
      zoneIds: hitZones,
      ...(entry.keyFrameMediaId !== undefined ? { keyFrameMediaId: entry.keyFrameMediaId } : {}),
      bbox: {
        x: entry.bbox.x,
        y: entry.bbox.y,
        w: entry.bbox.w,
        h: entry.bbox.h,
      },
      timestamp,
    })
    this.deps.logger.info('package delivered — all 5 gates passed', {
      tags: { deviceId: entry.deviceId },
      meta: {
        entryId: entry.id,
        eventId: rowId,
        idempotencyKey,
        zoneIds: hitZones,
        dwellMs,
        areaFrac: Number(minAreaFrac.toFixed(5)),
        ...(entry.confidence !== undefined ? { confidence: entry.confidence } : {}),
      },
    })
  }

  // ── departed → package-picked-up ─────────────────────────────────────
  private async onDeparted(change: StationaryChange): Promise<void> {
    const entry = change.entry
    const timestamp = change.timestamp
    const settings = await this.deps.resolveSettings(entry.deviceId)
    if (!settings.packageDropPickupEnabled) {
      this.deps.logger.debug('package pick-up skipped — packageDropPickupEnabled is false', {
        tags: { deviceId: entry.deviceId },
        meta: { entryId: entry.id },
      })
      return
    }

    const deliveredKey = deliveredIdempotencyKey(entry.id)
    const pickedUpKey = pickedUpIdempotencyKey(entry.id)
    const rows = await this.deps.events.queryObject({
      deviceId: entry.deviceId,
      classFilter: PACKAGE_EVENT_CLASS,
    })
    // Only pick up something that was delivered (restart-safe: the delivery
    // row is persisted), and never record a pick-up twice. The overwhelming
    // majority of departures are parked CARS, which never had a delivery row —
    // debug, or a parking-lot camera would log this on every retirement.
    //
    // Matched on the idempotence key, with the pre-rebuild `id` spelling as a
    // fallback (D474): a parcel delivered before the table was rebuilt must
    // still pair to its pick-up afterwards.
    const matchesKey = (e: ObjectEvent, key: string): boolean =>
      e.idempotencyKey === key || String(e.id) === key
    const delivered = rows.find((e) => matchesKey(e, deliveredKey))
    if (delivered === undefined) {
      this.deps.logger.debug('package pick-up skipped — no delivery row for this entry', {
        tags: { deviceId: entry.deviceId },
        meta: { entryId: entry.id, className: entry.className },
      })
      return
    }
    const alreadyPickedUp = rows.find((e) => matchesKey(e, pickedUpKey))
    if (alreadyPickedUp !== undefined) {
      this.deps.logger.info('package pick-up skipped — already recorded', {
        tags: { deviceId: entry.deviceId },
        meta: { entryId: entry.id, eventId: alreadyPickedUp.id, idempotencyKey: pickedUpKey },
      })
      return
    }

    // ── WHOSE PICTURE THIS ROW CARRIES (D404) ────────────────────────────
    //
    // The notification's still ladder resolves by OWNER — `event:<id>` then
    // `track:<id>` — and nothing ever writes media under a pick-up event id.
    // So the row's `trackId` IS the picture. It used to name the parcel's own
    // stationary-entry track, which is a photograph of the empty doormat: the
    // subject of a pick-up is the PERSON, and the person has their own track
    // with their own frames already in the media store.
    //
    // Same vehicle as the doorbell marker and the occupancy edge's
    // `mediaTrackId` (docs/architecture/notifications.md): the owner id rides
    // on `subject.trackId` and there is NO package branch on the notification
    // path. A handle, never pixels (D9/D18).
    //
    // The parcel stays the owner when no collector was resolved — degraded,
    // never conditional: the pick-up notification always ships.
    const collector = change.collector
    const packageTrackId = entry.sourceTrackId ?? entry.id
    const mediaTrackId = collector?.trackId ?? packageTrackId
    if (collector === undefined) {
      // Dropped work is never silent: this is the line that answers "why is
      // this pick-up still showing me the doormat".
      this.deps.logger.info(
        'package pick-up has no collector track — the notification carries the parcel frame',
        {
          tags: { deviceId: entry.deviceId },
          meta: {
            entryId: entry.id,
            idempotencyKey: pickedUpKey,
            packageTrackId,
            pickupAt: entry.lastConfirmedAt,
          },
        },
      )
    }

    // THE MOMENT IT HAPPENED (D682), STORED on the row (D684). `timestamp` is
    // when the departure was CONCLUDED — minutes after the parcel went, by
    // construction — and the notification's gif used to be cut around it: an
    // empty doormat. The collector's own instant is the best-attested one (the
    // frame the still shows), and the parcel's last sighting is the same
    // derivation the collector was chosen by (`pickupInstantOf`). On the row,
    // not beside it: the boot reconcile re-reads the row, and an instant handed
    // only to the live hook was lost on every replay.
    const observedAt = collector?.observedAt ?? pickupInstantOf(entry)
    const draft: ObjectEventDraft = {
      kind: 'object',
      deviceId: entry.deviceId,
      timestamp,
      observedAt,
      source: 'pipeline',
      idempotencyKey: pickedUpKey,
      trackId: mediaTrackId,
      className: PACKAGE_EVENT_CLASS,
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      confidence: PACKAGE_IMPORTANCE,
      bbox: {
        x: entry.bbox.x,
        y: entry.bbox.y,
        w: entry.bbox.w,
        h: entry.bbox.h,
      },
      ...(delivered.zones !== undefined ? { zones: delivered.zones } : {}),
      state: PICKED_UP_STATE,
      frameWidth: entry.frameWidth,
      frameHeight: entry.frameHeight,
      // The collector's native key frame, when the mirror caught one. The
      // parcel's key frame is deliberately NOT the fallback here: a pick-up
      // that cannot show the person shows the scene through the track ladder,
      // not a close-up of a parcel that has gone.
      ...(collector?.keyFrameMediaId !== undefined ? { mediaId: collector.keyFrameMediaId } : {}),
      importance: PACKAGE_IMPORTANCE,
    }
    // As on the delivery leg: the id comes from the insert and nowhere else
    // (D474), and a write that did not land is not a pick-up.
    const rowId = await this.deps.events.insertObject(draft)
    if (rowId === null) {
      this.deps.logger.warn('package pick-up NOT emitted — the event row did not persist', {
        tags: { deviceId: entry.deviceId },
        meta: { entryId: entry.id, idempotencyKey: pickedUpKey },
      })
      return
    }
    const ev: ObjectEvent = { ...draft, id: rowId }
    this.deps.onPersisted?.(ev, 'picked-up')

    this.deps.emit.pickedUp({
      deviceId: entry.deviceId,
      entryId: entry.id,
      deliveredEventId: String(delivered.id),
      className: entry.className,
      ...(collector !== undefined ? { collectorTrackId: collector.trackId } : {}),
      timestamp,
    })
    this.deps.logger.info('package picked up', {
      tags: { deviceId: entry.deviceId },
      meta: {
        entryId: entry.id,
        eventId: rowId,
        idempotencyKey: pickedUpKey,
        deliveredEventId: delivered.id,
        mediaTrackId,
        // The instant the footage is cut around, and how far behind it the
        // conclusion ran — the number that says "this gif is about the pick-up,
        // not about the doormat five minutes later".
        observedAt,
        concludedLagMs: timestamp - observedAt,
        // How far the collector's frame is from the parcel's last sighting —
        // the number that says whether the operator is looking at the moment
        // or at its neighbourhood.
        ...(collector !== undefined
          ? {
              collectorTrackId: collector.trackId,
              collectorClassName: collector.className,
              collectorSkewMs: collector.skewMs,
            }
          : { collectorTrackId: null }),
      },
    })
  }
}
