/**
 * Extracted from NotificationCenter (observeOccupancy, refreshOccupancyWatch, observeAudio, reportAudioWatch, requestOccupancyLook, reportOccupancyWatch, onOccupancyEdge, persistSeededOccupancy, persistOccupancyEdge, persistOccupancyRow, occupancyStillOwner, ruleWantsOccupancyStill, activeOccupancyKeys).
 * The class method forwards private state through {@link OccupancyWatchHost}.
 */

import type { AudioSample, AudioWindowHit, AudioWindowSpec } from './audio-rule-matcher.js'
import { AudioWatcher, audioSpecFromCondition } from './audio-rule-matcher.js'
import { NcDeviceStateCache } from './device-state-cache.js'
import type { NcIncomingEvent } from './event-intake.js'
import { audioHitMeta, incomingFromAudioWindow, incomingFromOccupancyEdge } from './event-intake.js'
import { OccupancyStore } from './occupancy-store.js'
import type {
  OccupancyArmedFlip,
  OccupancyEdge,
  OccupancyEvidence,
  OccupancyKeySpec,
  OccupancyStateRow,
} from './occupancy-watcher.js'
import { OccupancyWatcher, occupancyKey, occupancySpecFromCondition } from './occupancy-watcher.js'
import {
  deviceScopeExcludes,
  matchesOccupancy,
  occupancySubjectFromEdge,
  ruleShipsNoStill,
} from './rule-engine.js'
import { NcRuleStore } from './rule-store.js'
import { NcSceneStateCache } from './scene-state-cache.js'
import { NcStillShelf } from './still-shelf.js'
import { NcZoneOwnershipCache } from './zone-owner-cache.js'
import type { CameraOccupancySnapshot, IScopedLogger } from '@camstack/types'
import type { NotificationCenterDeps } from './index.js'

/**
 * One vigilated audio rule, as the reload tick sees it — the input to
 * {@link NotificationCenter.reportAudioWatch}. Not persisted, not read by
 * anything but the log: the watcher itself is device-agnostic, and the camera
 * scope lives on the rule.
 */
export interface NcAudioWatchEntry {
  readonly ruleId: string
  readonly ruleName: string
  readonly spec: AudioWindowSpec
  /** `conditions.devices` — empty means every camera. */
  readonly devices: readonly number[]
  /** `conditions.devicesExclude` (D641) — the cameras the rule never watches. */
  readonly excluded: readonly number[]
}
/** The watched question in one grep-able token. */
export function renderAudioSpec(spec: AudioWindowSpec): string {
  return spec.mode === 'label'
    ? `label:${spec.labels.join('+')}`
    : `level:${String(spec.dbThreshold)}dBFS|h${String(spec.hitPercent)}|s${String(spec.samplingSeconds)}`
}
/**
 * The camera scope in one token — `@all` is a real answer, not a missing one,
 * and `@all-except:<ids>` is a different one (D641): an excluding rule logged
 * as `@all` would claim the camera it never watches.
 */
export function renderAudioScope(devices: readonly number[], excluded: readonly number[]): string {
  if (devices.length === 0) {
    return excluded.length === 0 ? '@all' : `@all-except:${excluded.join('+')}`
  }
  return devices.filter((id) => !excluded.includes(id)).join('+')
}

export interface OccupancyWatchHost {
  audioEnabled: boolean
  audioStillOwner(deviceId: number, atMs: number, mode: 'legacy' | 'condition'): string | undefined
  readonly audioWatcher: AudioWatcher
  consumeEvent(event: NcIncomingEvent): void
  departureStillOwner(shelf: NcStillShelf, edge: OccupancyEdge): string | undefined
  readonly deps: NotificationCenterDeps
  readonly deviceStates: NcDeviceStateCache
  readonly evaluationActive: boolean
  lastAudioWatchReport: string
  lastOccupancyWatchReport: string
  readonly logger: IScopedLogger
  readonly now: () => number
  occupancyEnabled: boolean
  readonly occupancyLookFailing: Set<number>
  occupancyStillOwner(edge: OccupancyEdge): string | undefined
  readonly occupancyStore: OccupancyStore
  readonly occupancyWatcher: OccupancyWatcher
  onOccupancyEdge(edge: OccupancyEdge): void
  persistOccupancyEdge(edge: OccupancyEdge, now: number): Promise<void>
  persistOccupancyRow(row: OccupancyStateRow, now: number): Promise<void>
  persistSeededOccupancy(now: number): void
  registerDepartureFallback(shelf: NcStillShelf, edge: OccupancyEdge, trackId: string): void
  reportAudioWatch(entries: readonly NcAudioWatchEntry[]): void
  reportOccupancyWatch(specs: readonly OccupancyKeySpec[]): void
  requestOccupancyLook(flip: OccupancyArmedFlip): void
  ruleWantsOccupancyStill(edge: OccupancyEdge): boolean
  readonly rules: NcRuleStore
  readonly sceneStates: NcSceneStateCache
  sceneWatchSignature: string | null
  readonly stills: NcStillShelf | null
  readonly zoneOwners: NcZoneOwnershipCache
}

/**
 * Feed one ZoneAnalytics occupancy snapshot into the debounced watcher
 * (in-process, telemetry-loss-tolerant — a dropped snapshot just misses a
 * sample; the durable confirmed edge-state is the recovery). Called per
 * ≤1 Hz snapshot from `ZoneAnalyticsProvider` (live frames + the parked-object
 * baseline sampler). Cheap no-op when no occupancy rule is enabled. Each
 * COMMITTED edge is persisted (rare — only on a confirmed flip, never
 * per-frame) and routed to {@link onOccupancyEdge}.
 */
export function observeOccupancy(
  host: OccupancyWatchHost,
  deviceId: number,
  snapshot: CameraOccupancySnapshot,
  evidence: OccupancyEvidence = 'scene',
): void {
  if (!host.evaluationActive || !host.occupancyEnabled) return
  const now = host.now()
  let edges: readonly OccupancyEdge[]
  try {
    edges = host.occupancyWatcher.observe(deviceId, snapshot, now, evidence)
  } catch (err) {
    host.logger.debug('occupancy observe failed', {
      tags: { deviceId },
      meta: { error: String(err) },
    })
    return
  }
  // Write through the COLD SEEDS this observation created, before the edges.
  // A seed is the level a key starts from, and until now it lived in RAM
  // only: every restart threw it away and re-seeded from whatever the first
  // post-boot snapshot said, so a car that left during the downtime came
  // back as a phantom re-seed and its departure was never announced. Rare by
  // construction (once per key, ever) — this is not a per-frame write.
  host.persistSeededOccupancy(now)
  for (const flip of host.occupancyWatcher.takeArmedFlips()) host.requestOccupancyLook(flip)
  for (const edge of edges) {
    // A committed edge is RARE (one per confirmed flip) and it is the whole
    // point of this machinery — it was nonetheless entirely silent, so
    // "the zone emptied and nothing was sent" and "the zone never emptied"
    // read identically in the logs. Say it out loud, deviceId-tagged.
    host.logger.info('occupancy edge committed', {
      tags: { deviceId: edge.deviceId },
      meta: {
        zoneId: edge.zoneId ?? '@frame',
        zoneName: edge.zoneName ?? '',
        className: edge.className ?? '@all',
        threshold: edge.threshold,
        count: edge.count,
        previousCount: edge.previousCount,
        occupied: edge.occupied,
        // WHEN it happened vs when we concluded it. `-1` is not a lag: it is
        // "the edge could not date itself", and the notification's footage
        // will be cut around the conclusion (`media-anchor.ts`). Printing 0
        // there would claim the two coincided, which is the one thing we do
        // not know.
        observedAt: edge.observedAt ?? -1,
        observedLagMs: edge.observedAt !== undefined ? edge.timestamp - edge.observedAt : -1,
        // WHO produced the sample that committed this. Three false
        // departures on 102 were all armed by the census sampler and the
        // line said nothing about it — the only way to see it was to notice
        // that every `observedAt` landed on the same `:15.545` tick.
        committedBy: evidence,
      },
    })
    // Durably record the committed confirmed level (best-effort, fire-and-
    // forget) so a restart does not re-fire an already-confirmed edge; then
    // route it to the engine. Both are async — the boot reseed is the recovery
    // if a persist loses the race with a crash.
    void host.persistOccupancyEdge(edge, now)
    host.onOccupancyEdge(edge)
  }
}
export function refreshOccupancyWatch(host: OccupancyWatchHost): void {
  const specs: OccupancyKeySpec[] = []
  for (const rule of host.rules.listEnabled('device-event')) {
    const occ = rule.conditions.occupancy
    if (occ === undefined) continue
    specs.push(occupancySpecFromCondition(occ))
  }
  host.occupancyWatcher.setWatchedKeys(specs)
  host.occupancyEnabled = specs.length > 0
  // Say WHICH keys are watched, on change only. A rule-driven watched set is
  // recomputed on every reload tick and on every respawn, and until now it
  // was entirely invisible: "did the centre actually register my occupancy
  // rule, with which class and which threshold?" had no answer in the logs.
  // The scope is the whole diagnosis — a `className` the snapshots never key
  // on (`car`, where the tracker emits the macro `vehicle`) watches a count
  // that is structurally always 0, and that is readable here and nowhere else.
  host.reportOccupancyWatch(specs)
  // The audio window set rides the same tick, from the same rule cache: an
  // `immediate` rule that declares an `audio` condition. A condition with
  // NEITHER filter yields no spec (`audioSpecFromCondition` returns null),
  // so a rule that would fire on silence watches nothing at all.
  const audioSpecs: AudioWindowSpec[] = []
  const audioWatch: NcAudioWatchEntry[] = []
  for (const rule of host.rules.listEnabled('immediate')) {
    const audio = rule.conditions.audio
    if (audio === undefined) continue
    const spec = audioSpecFromCondition(audio)
    if (spec === null) {
      host.logger.warn('audio rule watches nothing — it names neither labels nor a dB threshold', {
        meta: { ruleId: rule.id, ruleName: rule.name },
      })
      continue
    }
    audioSpecs.push(spec)
    audioWatch.push({
      ruleId: rule.id,
      ruleName: rule.name,
      spec,
      devices: rule.conditions.devices ?? [],
      excluded: rule.conditions.devicesExclude ?? [],
    })
  }
  host.audioWatcher.setWatchedSpecs(audioSpecs)
  host.audioEnabled = audioSpecs.length > 0
  // …and SAY what is being watched, the way occupancy already does. Until
  // now the audio side of this tick was completely invisible: "did the
  // centre register my crying rule, in which mode, on which camera?" had no
  // answer anywhere in the logs, and the answer is the whole diagnosis — a
  // rule in LEVEL mode with a floor above the sounds it is about watches a
  // percentage that is structurally always 0.
  host.reportAudioWatch(audioWatch)
  // The gated devices, from EVERY enabled rule regardless of delivery — a
  // `deviceState` condition applies to all four triggers.
  const gated: number[] = []
  // …and the cameras whose zone OWNERSHIP a zone-scoped rule needs. Only
  // rules that NAME their cameras qualify: an all-devices rule keeps the flat
  // verdict by design (`zone-ownership.ts`), so reading its zones would be
  // work nothing consumes.
  const zoneScoped: number[] = []
  // …and the SCENES a scene-gated rule needs. Same argument as the gated
  // devices: the gate applies to every trigger, so the whole enabled rule set
  // is walked, and a cluster with no scene rule watches nothing at all.
  const sceneIds: string[] = []
  for (const rule of host.rules.list()) {
    if (!rule.enabled) continue
    const ds = rule.conditions.deviceState
    if (ds !== undefined) gated.push(ds.deviceId)
    const scene = rule.conditions.scene
    if (scene !== undefined) sceneIds.push(scene.sceneId)
    const zones = rule.conditions.zones
    const devices = rule.conditions.devices
    if (zones !== undefined && zones.ids.length > 0 && devices !== undefined) {
      zoneScoped.push(...devices)
    }
  }
  // The alarm adds NOTHING here: the arm check reads the covered devices'
  // openings at press time, and the reconcile tick reads the excluded ones'
  // openings itself (`observeAlarmOpenings`). A collapsed state word could
  // not say whether a cover is secure anyway.
  host.deviceStates.setWatched(gated)
  host.zoneOwners.setWatched(zoneScoped)
  host.sceneStates.setWatched(sceneIds)
  // A rule gated on a scene that no longer exists is a rule that is enabled,
  // in the list, and permanently silent — the exact shape the occupancy watch
  // line was added for. `NcSceneStateCache.refresh` names the missing ids;
  // this says how many rules depend on the answer at all.
  // …on CHANGE only: the set is recomputed on every reload tick and a line per
  // tick is a line nobody reads.
  const signature = [...new Set(sceneIds)].sort().join(',')
  if (signature !== host.sceneWatchSignature) {
    host.sceneWatchSignature = signature
    host.logger.info('scene gate watched set', {
      meta: { scenes: host.sceneStates.watched(), gatedRules: sceneIds.length },
    })
  }
}
/**
 * Feed ONE audio inference frame into the sampling-window matcher.
 *
 * Called per analyzer frame from `handleAudioResult`, BEFORE the
 * classification/level route split — deliberately, and for the reason the
 * audio-marker feed sits there too: a rule about how loud a camera has been
 * is a question about EVERY frame, and a feed placed after the split sees
 * only the half its branch kept. A loudness rule fed from the classification
 * route alone would be blind to loud unclassified noise, which is most of it.
 *
 * Cheap no-op when no rule declares an `audio` condition — which is every
 * hub today, by design (the editors ship with P2/P3, so no live rule can
 * carry one yet). Telemetry-loss-tolerant: a dropped frame is one missing
 * sample in a percentage, never a lost notification.
 *
 * Delivery-grade boundary (honest): a confirmed window is not a persisted
 * record and there is no crash-gap reconcile for it. A crash between the
 * confirmation and the outbox insert drops that notification — deliberate,
 * because a window is a claim about sound that has already stopped, and
 * replaying it later would notify about a noise nobody can still hear.
 */
export function observeAudio(
  host: OccupancyWatchHost,
  deviceId: number,
  sample: AudioSample,
): void {
  if (!host.evaluationActive || !host.audioEnabled) return
  let hits: readonly AudioWindowHit[]
  try {
    hits = host.audioWatcher.observe(deviceId, sample, host.now())
  } catch (err) {
    host.logger.debug('audio observe failed', {
      tags: { deviceId },
      meta: { error: String(err) },
    })
    return
  }
  for (const hit of hits) {
    // Two different sentences, because they are two different claims: a
    // label match is "the classifier heard this, once", a window
    // confirmation is "this much of the last N seconds cleared the floor".
    // One line for both would make a grep for "why did this fire" ambiguous
    // exactly where the modes differ.
    host.logger.info(hit.spec.mode === 'label' ? 'audio label matched' : 'audio window confirmed', {
      tags: { deviceId },
      meta: audioHitMeta(hit),
    })
    // The photograph starts HERE, at the confirmation and before the rule
    // evaluation — the sound is already over, and a still fetched after the
    // cooldown verdict would be of a scene the noise had left.
    host.consumeEvent(
      incomingFromAudioWindow(hit, host.audioStillOwner(deviceId, hit.timestamp, 'condition')),
    )
  }
}
/**
 * Log the watched AUDIO spec set, on CHANGE only — the counterpart of
 * {@link reportOccupancyWatch}, which the audio side simply never had.
 *
 * Two shapes, deliberately. The summary answers "what does this hub listen
 * for at all"; the per-camera line answers "why is 102 not notifying" — and
 * that question is ALWAYS asked per camera, so the line carries
 * `tags.deviceId` and a rule scoped to no camera is reported as watching
 * every one rather than silently omitted — every one EXCEPT its
 * `devicesExclude` cameras (D641), each of which gets its own NOT-watching
 * line on that camera.
 */
export function reportAudioWatch(
  host: OccupancyWatchHost,
  entries: readonly NcAudioWatchEntry[],
): void {
  const rendered = entries
    .map((e) => `${e.ruleId}=${renderAudioSpec(e.spec)}@${renderAudioScope(e.devices, e.excluded)}`)
    .toSorted()
    .join(',')
  if (rendered === host.lastAudioWatchReport) return
  host.lastAudioWatchReport = rendered
  host.logger.info('audio watched specs', {
    meta: { specs: entries.length, watched: rendered.length > 0 ? rendered : '(none)' },
  })
  for (const entry of entries) {
    const meta = {
      ruleId: entry.ruleId,
      ruleName: entry.ruleName,
      mode: entry.spec.mode,
      spec: renderAudioSpec(entry.spec),
    }
    // D641: an excluded camera is said ON that camera — the question "why is
    // 102 silent" is asked per camera, and "every camera" would be a lie.
    for (const deviceId of entry.excluded) {
      host.logger.info('audio rule NOT watching camera', {
        tags: { deviceId },
        meta: { ...meta, reason: 'devicesExclude' },
      })
    }
    if (entry.devices.length === 0) {
      if (entry.excluded.length === 0) {
        host.logger.info('audio rule watching every camera', { meta })
      } else {
        host.logger.info('audio rule watching every camera except the excluded', {
          meta: { ...meta, excluded: [...entry.excluded] },
        })
      }
      continue
    }
    for (const deviceId of entry.devices) {
      if (entry.excluded.includes(deviceId)) continue
      host.logger.info('audio rule watching camera', { tags: { deviceId }, meta })
    }
  }
}
/**
 * D691 — a flip just armed and can commit only on a sample after its
 * sustain: ask the orchestrator for ONE look then. The session that armed
 * it often closes first (a car drives off, motion clears) and the next
 * sample would otherwise be the 300 s parked-object cadence — 4 min 52 s
 * late on 102, 2026-10-01. Fire-and-forget: a refusal or a failure costs
 * the early commit, never the edge (the cadence still commits it), and is
 * said per camera.
 */
export function requestOccupancyLook(host: OccupancyWatchHost, flip: OccupancyArmedFlip): void {
  const ask = host.deps.requestOccupancyLook
  if (ask === undefined) return
  const request = {
    deviceId: flip.deviceId,
    afterMs: flip.sustainMs,
    reason: 'occupancy-pending',
  }
  const meta = { key: flip.key, toOccupied: flip.toOccupied, afterMs: flip.sustainMs }
  void ask(request)
    .then((answer) => {
      host.occupancyLookFailing.delete(flip.deviceId)
      if (answer.scheduled) {
        host.logger.debug('occupancy early look requested', {
          tags: { deviceId: flip.deviceId },
          meta: { ...meta, dueInMs: answer.dueInMs ?? null },
        })
        return
      }
      host.logger.info('occupancy early look: refused — the cadence will commit the edge', {
        tags: { deviceId: flip.deviceId },
        meta: { ...meta, refusedBecause: answer.refusedBecause ?? 'unknown' },
      })
    })
    .catch((err: unknown) => {
      // Once per camera until an ask succeeds (review L1): an orchestrator
      // older than D691 fails EVERY ask, and a warn per armed flip is noise.
      const first = !host.occupancyLookFailing.has(flip.deviceId)
      host.occupancyLookFailing.add(flip.deviceId)
      const line = { tags: { deviceId: flip.deviceId }, meta: { ...meta, error: String(err) } }
      const msg = 'occupancy early look: the ask failed — the cadence will commit the edge'
      if (first) host.logger.warn(msg, line)
      else host.logger.debug(msg, line)
    })
}
/**
 * Log the watched occupancy key set, on CHANGE only.
 *
 * Change-only because this runs on every rule-reload tick; a line per tick
 * would be noise, and no line at all is how a rule that watches an
 * impossible scope stays invisible for a day.
 */
export function reportOccupancyWatch(
  host: OccupancyWatchHost,
  specs: readonly OccupancyKeySpec[],
): void {
  const rendered = specs
    .map(
      (s) =>
        `${s.zoneId ?? '@frame'}|${s.className ?? '@all'}|t${String(s.threshold)}@${String(s.sustainSeconds)}s`,
    )
    .toSorted()
    .join(',')
  if (rendered === host.lastOccupancyWatchReport) return
  host.lastOccupancyWatchReport = rendered
  host.logger.info('occupancy watched keys', {
    meta: { keys: specs.length, specs: rendered.length > 0 ? rendered : '(none)' },
  })
}
/**
 * Persist hook for a committed occupancy edge — mirrors the other persist
 * hooks (serialized via {@link scheduleEvaluation}). The subject rides the
 * EXISTING `device-event` delivery via the internal `occupancy-event` kind.
 * Public so a test / a future out-of-band edge source can drive it directly.
 */
export function onOccupancyEdge(host: OccupancyWatchHost, edge: OccupancyEdge): void {
  host.consumeEvent(incomingFromOccupancyEdge(edge, host.occupancyStillOwner(edge)))
}
/**
 * Write-through the rows the watcher SEEDED on this observation — the initial
 * level of a key that had neither a durable row nor RAM state.
 *
 * Same ledger, same best-effort contract as an edge: a failed write leaves
 * exactly today's behaviour (a cold re-seed at the next boot), never a
 * corrupt level. Drained, so a key is written once and not per frame.
 */
export function persistSeededOccupancy(host: OccupancyWatchHost, now: number): void {
  const rows = host.occupancyWatcher.takeSeededRows()
  for (const row of rows) {
    host.logger.info('occupancy baseline seeded', {
      tags: { deviceId: row.deviceId },
      meta: {
        key: row.key,
        zoneId: row.zoneId ?? '@frame',
        className: row.className ?? '@all',
        threshold: row.threshold,
        count: row.confirmedCount,
        occupied: row.occupied,
      },
    })
    void host.persistOccupancyRow(row, now)
  }
}
/** Write-through the committed confirmed level for one edge (rare — only on a
 *  boolean flip). Best-effort: a failed persist is logged, never thrown into
 *  the frame path (the boot reseed + next edge recover). */
export function persistOccupancyEdge(
  host: OccupancyWatchHost,
  edge: OccupancyEdge,
  now: number,
): Promise<void> {
  return host.persistOccupancyRow(
    {
      key: occupancyKey(edge.deviceId, edge.zoneId, edge.className, edge.threshold),
      deviceId: edge.deviceId,
      ...(edge.zoneId !== undefined ? { zoneId: edge.zoneId } : {}),
      ...(edge.className !== undefined ? { className: edge.className } : {}),
      threshold: edge.threshold,
      confirmedCount: edge.count,
      occupied: edge.occupied,
      lastChangeAt: edge.timestamp,
      updatedAt: now,
    },
    now,
  )
}
/** The ONE durable write for a confirmed occupancy level, whether it came from
 *  a committed edge or a cold seed. Best-effort by contract — see the two
 *  callers. */
export async function persistOccupancyRow(
  host: OccupancyWatchHost,
  row: OccupancyStateRow,
  now: number,
): Promise<void> {
  try {
    await host.occupancyStore.persist({ ...row, updatedAt: now })
  } catch (err) {
    host.logger.debug('occupancy persist failed', {
      tags: { deviceId: row.deviceId },
      meta: { key: row.key, error: String(err) },
    })
  }
}
/**
 * Start photographing this edge's camera NOW and return the owner id its
 * subject should name — or `undefined` when nothing would use it.
 *
 * **Only an edge that owns NOBODY.** `chooseOccupancyMediaOwner` names a
 * member track whenever the scope holds one, and that picture is of the
 * counted object itself; a photograph is strictly the stand-in for not having
 * one. The case this exists for is "posto libero" (camera 102): the vehicle
 * whose departure IS the notification has left, so the scope is empty, the
 * ladder resolves nothing and the delivery logged `no still could be resolved
 * … owners=[]`. A became-free edge has no owner BY CONSTRUCTION, and a
 * became-occupied edge can lack one too (every member parked, i.e.
 * `stationary:`) — so the gate is the ABSENCE itself, not the polarity. That
 * is the honest predicate: photograph exactly the edges whose media cannot be
 * resolved, and no others.
 *
 * **The capture is not awaited**, for the audio shelf's reason and one of its
 * own: a freed space is about to be taken by the next car, and a still fetched
 * after the outbox drained would show it occupied again.
 *
 * **The gate is the RULE's media policy AND the engine's own verdict.** The
 * watcher commits both polarities of every watched key, so a hub with only a
 * became-occupied rule still produces free edges — photographing those would
 * be a snapshot no notification can ever carry. `matchesOccupancy` is the same
 * predicate `evaluateRule` will apply, shared rather than restated. The rule
 * cache is an in-memory mirror, so this is not a fallible read (D49).
 */
export function occupancyStillOwner(
  host: OccupancyWatchHost,
  edge: OccupancyEdge,
): string | undefined {
  const shelf = host.stills
  if (shelf === null || !host.evaluationActive) return undefined
  if (!host.ruleWantsOccupancyStill(edge)) return undefined
  if (edge.mediaTrackId !== undefined) {
    // The departed track owns the picture (D691). If it resolves NOTHING —
    // fused away, or too short to persist a best shot — the ring still at
    // the departure stands in, lazily (review M3).
    if (!edge.occupied) host.registerDepartureFallback(shelf, edge, edge.mediaTrackId)
    return undefined
  }
  return edge.occupied
    ? shelf.capture(edge.deviceId, edge.timestamp, 'occupancy')
    : host.departureStillOwner(shelf, edge)
}
/** Would an enabled rule fire on THIS edge and want a still? (In-memory rule
 *  mirror — not a fallible read, D49.) */
export function ruleWantsOccupancyStill(host: OccupancyWatchHost, edge: OccupancyEdge): boolean {
  const subject = occupancySubjectFromEdge(edge)
  for (const rule of host.rules.listEnabled('device-event')) {
    if (ruleShipsNoStill(rule)) continue
    const occ = rule.conditions.occupancy
    if (occ === undefined || !matchesOccupancy(occ, subject)) continue
    const devices = rule.conditions.devices
    if (devices !== undefined && devices.length > 0 && !devices.includes(edge.deviceId)) continue
    const excluded = rule.conditions.devicesExclude
    if (excluded !== undefined && deviceScopeExcludes(excluded, { deviceId: edge.deviceId })) {
      continue
    }
    return true
  }
  return false
}
/** The full-key set the watcher currently tracks (post prune) — the bound for
 *  {@link OccupancyStore.pruneExcept}. */
export function activeOccupancyKeys(host: OccupancyWatchHost): ReadonlySet<string> {
  return new Set(host.occupancyWatcher.snapshotState().map((r) => r.key))
}
