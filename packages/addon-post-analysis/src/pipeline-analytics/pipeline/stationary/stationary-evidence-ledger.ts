/**
 * stationary-evidence-ledger — the durable half of {@link stationary-evidence}.
 *
 * ONE ledger, two producers, both live: occasion A is an active motion session
 * (free at the margin), occasion B the periodic occupancy recheck that looks at
 * a STILL scene nobody is watching. They arrive through the same detection
 * queue and differ only in {@link StationaryObservation.source}, which the
 * RUNNER names on the payload — an object confirmed half by each still
 * promotes, because both feed the same candidate, and the per-candidate
 * `sessionAgreed` / `burstAgreed` tallies keep "is the recheck earning its keep
 * on this camera?" answerable. Those tallies read zero for burst until
 * 2026-09-14, when every observation was still being filed as a session.
 *
 * ## Track binding, and why M is not "every detection near the spot"
 *
 * A track BINDS to a candidate the first time it agrees with its anchor. From
 * then on every observation of that track counts toward M — agreeing or not.
 * That is what dilutes a car that merely drove through the spot, and it is why
 * the binding map exists at all. Bindings are RAM-only and per device: losing
 * them on a respawn costs nothing, because a track that outlives a respawn
 * simply re-binds on its next frame.
 *
 * The binding is not permanent (D280). A track emitted on a settling box binds
 * to whichever of a device's accumulated candidates it happened to touch, and
 * used to stay there for life — on 102 that put 267 observations of a parked
 * car onto a row the car is not on, and delayed the promotion of the row it IS
 * on by 3.3 minutes. A bound row whose overlap with the current box has fallen
 * to ~0 is re-matched when another candidate clears `agreeIou`. Nothing is
 * transferred by a re-bind: every observation is folded exactly once, into the
 * row it is bound to at that moment, so the total M across a device's
 * candidates is always the number of observations the device offered.
 */

import type { IScopedLogger } from '@camstack/types'

import { DurableLedger, type DurableLedgerSpec } from '../../../durable/durable-ledger.js'
import { type DurableKindDeps } from '../../../durable/durable-wiring.js'
import { pipelineAnalyticsRecordKinds } from '../../record-kinds.js'
import {
  EVIDENCE_MAX_CANDIDATES_PER_DEVICE,
  EVIDENCE_REBIND_MAX_BOUND_OVERLAP,
  EVIDENCE_WINDOW_MS,
  evaluateStationaryEvidence,
  evidencePolicyFor,
  foldObservation,
  matchEvidenceCandidate,
  newEvidenceRow,
  observationVote,
  type StationaryEvidenceFrame,
  type StationaryEvidencePolicy,
  type StationaryEvidenceRow,
  type StationaryEvidenceVerdict,
  type StationaryObservation,
} from './stationary-evidence.js'
import { iou } from './stationary-match.js'
import type { StationaryBbox } from './stationary-types.js'

/**
 * @durable class=ledger owner=pipeline-analytics
 *   write="a candidate's BIRTH and its PROMOTION are written immediately; the per-frame agreement tallies are STAGED in RAM and flushed on the 5-minute sweep (a parked car is observed 5-30 times a second and one commit per observation would offer ~10^6 writes a day to maintain a handful of rows)"
 *   retention="a candidate untouched for 6h is deleted, and a device is capped at 512 candidates (least-recently-touched evicted). A promoted candidate is deleted the moment its entry is born. Never orphaned by track retention — evidence describes an OBJECT that outlives every track that ever saw it, which is the entire reason this collection exists."
 */
export const STATIONARY_EVIDENCE_COLLECTION = 'pipeline-analytics:stationary-evidence'

const STATIONARY_EVIDENCE_COLUMNS = [
  { name: 'id', type: 'TEXT' as const, primaryKey: true, notNull: true },
  { name: 'deviceId', type: 'INTEGER' as const, notNull: true },
  { name: 'className', type: 'TEXT' as const, notNull: true },
  { name: 'anchor', type: 'JSON' as const },
  { name: 'agreed', type: 'INTEGER' as const },
  { name: 'seen', type: 'INTEGER' as const },
  { name: 'firstAgreedAt', type: 'INTEGER' as const },
  { name: 'lastAgreedAt', type: 'INTEGER' as const },
  { name: 'bestBbox', type: 'JSON' as const },
  { name: 'sourceTrackId', type: 'TEXT' as const },
  { name: 'keyFrameMediaId', type: 'INTEGER' as const },
  { name: 'label', type: 'TEXT' as const },
  { name: 'sessionAgreed', type: 'INTEGER' as const },
  { name: 'burstAgreed', type: 'INTEGER' as const },
  { name: 'undecided', type: 'INTEGER' as const },
  { name: 'updatedAt', type: 'INTEGER' as const },
] as const

const STATIONARY_EVIDENCE_INDEXES = [
  { name: 'idx_stationary_evidence_device', columns: ['deviceId'] as const },
] as const

export interface StationaryEvidenceLedgerDeps extends DurableKindDeps {
  readonly logger: IScopedLogger
}

/** One live track and the candidate it is currently feeding. */
export interface StationaryEvidenceBindingView {
  readonly trackId: string
  readonly candidateKey: string
}

/** What one observation was worth to the caller. */
export interface StationaryEvidenceOutcome {
  readonly row: StationaryEvidenceRow
  readonly verdict: StationaryEvidenceVerdict
  /** True on the observation that tipped the candidate over. The ledger has
   *  already forgotten the candidate — the caller owns the birth. */
  readonly promoted: boolean
}

function parseBbox(value: unknown): StationaryBbox | null {
  if (typeof value !== 'object' || value === null) return null
  const record: Record<string, unknown> = { ...value }
  const { x, y, w, h } = record
  if (typeof x !== 'number' || typeof y !== 'number') return null
  if (typeof w !== 'number' || typeof h !== 'number') return null
  return { x, y, w, h }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** A measurement that failed is absent, never zero (D393): a non-finite read
 *  (missing column, unreadable value) yields `undefined`, not `0`. */
function numberIdOrUndefined(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

const STATIONARY_EVIDENCE_SPEC: DurableLedgerSpec<StationaryEvidenceRow> = {
  collection: STATIONARY_EVIDENCE_COLLECTION,
  columns: [...STATIONARY_EVIDENCE_COLUMNS],
  indexes: [...STATIONARY_EVIDENCE_INDEXES],
  // The mirror is the authority for the decision — a candidate is judged
  // from RAM on the frame path, never from a read that can fail (D49).
  writeMode: 'write-behind',
  keyOf: (row) => row.key,
  toValue: (row) => ({
    deviceId: row.deviceId,
    className: row.className,
    anchor: { ...row.anchor },
    agreed: row.agreed,
    seen: row.seen,
    windowAgreed: row.windowAgreed,
    windowSeen: row.windowSeen,
    prevWindowAgreed: row.prevWindowAgreed,
    prevWindowSeen: row.prevWindowSeen,
    windowStartedAt: row.windowStartedAt,
    firstAgreedAt: row.firstAgreedAt,
    lastAgreedAt: row.lastAgreedAt,
    bestBbox: { ...row.bestBbox },
    ...(row.sourceTrackId !== undefined ? { sourceTrackId: row.sourceTrackId } : {}),
    ...(row.keyFrameMediaId !== undefined ? { keyFrameMediaId: row.keyFrameMediaId } : {}),
    ...(row.label !== undefined ? { label: row.label } : {}),
    sessionAgreed: row.sessionAgreed,
    burstAgreed: row.burstAgreed,
    undecided: row.undecided,
    updatedAt: row.updatedAt,
  }),
  fromRecord: (key, data) => {
    const deviceId = data.deviceId
    const className = data.className
    if (typeof deviceId !== 'number' || typeof className !== 'string') return null
    const anchor = parseBbox(data.anchor)
    const bestBbox = parseBbox(data.bestBbox) ?? anchor
    if (anchor === null || bestBbox === null) return null
    const sourceTrackId = stringOrUndefined(data.sourceTrackId)
    const keyFrameMediaId = numberIdOrUndefined(data.keyFrameMediaId)
    const label = stringOrUndefined(data.label)
    const updatedAt = numberOr(data.updatedAt, 0)
    return {
      key,
      deviceId,
      className,
      anchor,
      agreed: numberOr(data.agreed, 0),
      seen: numberOr(data.seen, 0),
      windowAgreed: numberOr(data.windowAgreed, 0),
      windowSeen: numberOr(data.windowSeen, 0),
      prevWindowAgreed: numberOr(data.prevWindowAgreed, 0),
      prevWindowSeen: numberOr(data.prevWindowSeen, 0),
      windowStartedAt: numberOr(data.windowStartedAt, updatedAt),
      firstAgreedAt: numberOr(data.firstAgreedAt, updatedAt),
      lastAgreedAt: numberOr(data.lastAgreedAt, updatedAt),
      bestBbox,
      ...(sourceTrackId !== undefined ? { sourceTrackId } : {}),
      ...(keyFrameMediaId !== undefined ? { keyFrameMediaId } : {}),
      ...(label !== undefined ? { label } : {}),
      sessionAgreed: numberOr(data.sessionAgreed, 0),
      burstAgreed: numberOr(data.burstAgreed, 0),
      undecided: numberOr(data.undecided, 0),
      updatedAt,
    }
  },
  deviceIdOf: (row) => row.deviceId,
}

export class StationaryEvidenceLedger {
  private readonly ledger: DurableLedger<StationaryEvidenceRow>
  private readonly spec = STATIONARY_EVIDENCE_SPEC
  private readonly logger: IScopedLogger
  /** deviceId → candidate keys, so a device's candidates are found without
   *  scanning the fleet. */
  private readonly byDevice = new Map<number, Set<string>>()
  /** `deviceId:trackId` → candidate key. RAM-only, see the file header. */
  private readonly binding = new Map<string, string>()
  /** Keys whose staged tallies have not been persisted yet. */
  private readonly dirty = new Set<string>()
  /** Candidates already reported as an artifact box. The shortfall recurs on
   *  every observation of a box that never changes (3836's jacket is seen five
   *  times a second in a session), so the line is said once per candidate. */
  private readonly implausibleReported = new Set<string>()
  /** `<deviceId>:<trackId>` of tracks whose first undecided fold was logged
   *  (D547). Pruned with the bindings in {@link retainTracks}. */
  private readonly undecidedReported = new Set<string>()
  private anchorSeq = 0

  constructor(deps: StationaryEvidenceLedgerDeps) {
    this.logger = deps.logger
    this.ledger = new DurableLedger({
      spec: this.spec,
      kind: deps.records.kind(pipelineAnalyticsRecordKinds['stationary-evidence']),
      logger: deps.logger,
    })
  }

  /** Boot reseed. Returns how many candidates came back — "loaded 0" after a
   *  container recreate is the one line that explains a silent regression. */
  async load(): Promise<number> {
    const rows = await this.ledger.load()
    for (const row of rows) this.index(row)
    return rows.length
  }

  get size(): number {
    return this.ledger.snapshot().length
  }

  /** Devices holding at least one candidate — the diagnostic's entry point. */
  deviceIdsWithCandidates(): readonly number[] {
    const ids: number[] = []
    for (const [deviceId, keys] of this.byDevice) if (keys.size > 0) ids.push(deviceId)
    return ids
  }

  /**
   * Which candidate each of a device's live tracks is bound to.
   *
   * The 102 audit could not answer this — the binding map was private, and the
   * whole D280 defect is invisible without it: a promotion's `agreed`/`seen`
   * tell you a row was fed, never WHICH track fed it or which track went
   * somewhere else. Read-only, and the only reason it is public.
   */
  bindingsFor(deviceId: number): readonly StationaryEvidenceBindingView[] {
    const prefix = `${deviceId}:`
    const out: StationaryEvidenceBindingView[] = []
    for (const [bindKey, candidateKey] of this.binding) {
      if (!bindKey.startsWith(prefix)) continue
      out.push({ trackId: bindKey.slice(prefix.length), candidateKey })
    }
    return out
  }

  candidatesFor(deviceId: number): readonly StationaryEvidenceRow[] {
    const keys = this.byDevice.get(deviceId)
    if (!keys) return []
    const rows: StationaryEvidenceRow[] = []
    for (const key of keys) {
      const row = this.ledger.get(key)
      if (row) rows.push(row)
    }
    return rows
  }

  /**
   * Fold ONE observation in and say whether it just earned an entry.
   *
   * Synchronous by construction: the verdict is read from the RAM mirror, so a
   * slow or failing store can never change what this frame decides. The
   * durable half is fired behind the verdict.
   */
  observe(observation: StationaryObservation): StationaryEvidenceOutcome | undefined {
    const policy: StationaryEvidencePolicy = evidencePolicyFor(observation.className)
    this.expire(observation.deviceId, observation.timestamp)

    const bindKey =
      observation.trackId === undefined
        ? undefined
        : `${observation.deviceId}:${observation.trackId}`
    const candidates = this.candidatesFor(observation.deviceId)

    let row: StationaryEvidenceRow | undefined
    const boundKey = bindKey === undefined ? undefined : this.binding.get(bindKey)
    if (boundKey !== undefined) row = this.ledger.get(boundKey)
    // A binding is CLASS-BOUND, like everything else in this module. A track
    // whose class the vote flipped (vehicle → person on the same box) used to
    // keep feeding the row it bound under its old class: matching is class
    // gated on the way IN, the bound row was never re-checked, and a person
    // standing where a car had been agreed with the car's candidate at IoU
    // 0.9. Dropped here so the observation below binds afresh, by class.
    if (row !== undefined && row.className !== observation.className) {
      this.logger.debug('stationary evidence binding dropped — the track changed class', {
        tags: { deviceId: observation.deviceId },
        meta: {
          deviceId: observation.deviceId,
          ...(observation.trackId !== undefined ? { trackId: observation.trackId } : {}),
          boundClass: row.className,
          className: observation.className,
        },
      })
      if (bindKey !== undefined) this.binding.delete(bindKey)
      row = undefined
    }

    let overlap = row === undefined ? 0 : iou(row.anchor, observation.bbox)
    // RE-BIND (D280). A track that bound on a settling box is otherwise stuck
    // on the wrong row for its whole life, and every one of its observations
    // dilutes a candidate it is not about while starving the one it is. The
    // guard is deliberately narrow: the incumbent must be essentially
    // UNRELATED to this box, and the challenger must clear the ordinary
    // agreement bar. Re-binding moves nothing — no tally is copied, credited
    // twice or transferred — so the observation below is still folded exactly
    // once, into whichever row wins here.
    if (row !== undefined && overlap <= EVIDENCE_REBIND_MAX_BOUND_OVERLAP) {
      const better = matchEvidenceCandidate(
        candidates,
        observation.className,
        observation.bbox,
        policy.agreeIou,
      )
      if (better !== undefined && better.row.key !== row.key) {
        this.logger.debug('stationary evidence re-bound — the track was on the wrong candidate', {
          tags: { deviceId: observation.deviceId },
          meta: {
            deviceId: observation.deviceId,
            className: observation.className,
            ...(observation.trackId !== undefined ? { trackId: observation.trackId } : {}),
            boundOverlap: overlap,
            reboundOverlap: better.overlap,
            fromAgreed: row.agreed,
            fromSeen: row.seen,
            toAgreed: better.row.agreed,
            toSeen: better.row.seen,
          },
        })
        row = better.row
        overlap = better.overlap
        if (bindKey !== undefined) this.binding.set(bindKey, row.key)
      }
    }
    let created = false
    if (row === undefined) {
      const match = matchEvidenceCandidate(
        candidates,
        observation.className,
        observation.bbox,
        policy.agreeIou,
      )
      if (match) {
        row = match.row
        overlap = match.overlap
      } else {
        this.anchorSeq += 1
        row = newEvidenceRow(observation, `a${this.anchorSeq}`)
        overlap = 1
        created = true
        this.index(row)
        void this.write(row)
        if (bindKey !== undefined) this.binding.set(bindKey, row.key)
        this.capDevice(observation.deviceId)
        return {
          row,
          verdict: evaluateStationaryEvidence(row, policy, observation),
          promoted: false,
        }
      }
      if (bindKey !== undefined) this.binding.set(bindKey, row.key)
    }

    // IDENTITY from the overlap, STILLNESS from the tracker on a session frame
    // and from the occasion on a burst — one authority each, and neither
    // re-derives the other's answer.
    const vote = observationVote(
      overlap,
      policy.agreeIou,
      observation.source,
      observation.movementState,
      observation.settling === true,
    )
    const agrees = vote === 'agree'
    if (vote === 'undecided') this.noteUndecided(row, observation)
    const next = foldObservation(row, observation, vote, overlap)
    this.ledger.stage(next)
    this.dirty.add(next.key)
    if (created) this.capDevice(observation.deviceId)

    const verdict = evaluateStationaryEvidence(next, policy, observation)
    if (verdict.kind === 'accumulating' && verdict.shortfall === 'implausible-box') {
      this.noteImplausible(next, observation)
    }
    if (verdict.kind !== 'promote') return { row: next, verdict, promoted: false }
    // ONLY AN AGREEING OBSERVATION MAY MINT. A disagreeing fold can still turn
    // the verdict over — the ratio window rotates on every fold, and dropping
    // yesterday's bucket is what makes a diluted candidate look clean again.
    // The observation that did that used to be the one the caller tore down
    // and closed as `stationary-promotion`: on 102 and 3836 that was a track
    // ONE position old, `entered`, of a subject the row is not about. The
    // candidate stays promotable; the next observation OF THE OBJECT mints it.
    if (!agrees) return { row: next, verdict, promoted: false }

    // The candidate has become an entry. Forget it here so the same evidence
    // can never mint a second entry, and so the registry — which now owns and
    // suppresses this object — is the only thing holding it.
    this.forgetKey(next.key)
    return { row: next, verdict, promoted: true }
  }

  /** Persist the staged tallies. Called from the registry's 5-minute sweep. */
  async flush(): Promise<number> {
    const keys = [...this.dirty]
    this.dirty.clear()
    let written = 0
    for (const key of keys) {
      const row = this.ledger.get(key)
      if (!row) continue
      await this.write(row)
      written += 1
    }
    return written
  }

  /** Drop a device's evidence wholesale (camera removed / analytics reset). */
  async clearDevice(deviceId: number): Promise<void> {
    for (const row of this.candidatesFor(deviceId)) await this.forgetKeyDurable(row.key)
    this.byDevice.delete(deviceId)
    for (const [bindKey] of this.binding) {
      if (bindKey.startsWith(`${deviceId}:`)) this.binding.delete(bindKey)
    }
  }

  /** Forget the bindings of tracks the tracker no longer carries, so the map
   *  cannot grow for the process's lifetime on a busy camera. */
  retainTracks(deviceId: number, liveTrackIds: ReadonlySet<string>): void {
    const prefix = `${deviceId}:`
    for (const bindKey of [...this.binding.keys()]) {
      if (!bindKey.startsWith(prefix)) continue
      if (!liveTrackIds.has(bindKey.slice(prefix.length))) this.binding.delete(bindKey)
    }
    for (const key of [...this.undecidedReported]) {
      if (!key.startsWith(prefix)) continue
      if (!liveTrackIds.has(key.slice(prefix.length))) this.undecidedReported.delete(key)
    }
  }

  private forgetKey(key: string): void {
    void this.forgetKeyDurable(key)
  }

  /**
   * A candidate whose evidence suffices and whose BOX is an artifact — said
   * once, at info, with the numbers, because it is the line that answers "why
   * is this camera's biggest still thing never censused" (3836's jacket:
   * 1132x1396 in a 2560x1440 frame, 40 486 agreements). A branch that refuses
   * work is never silent (D391), and one that refuses it five times a second
   * is never loud.
   */
  /**
   * An undecided observation is dropped from the tally on purpose (D547), and
   * a branch that drops work says so — once per track, at debug: the same
   * track offers one every frame until it decides, and a line per frame would
   * bury what it reports. The lifetime count rides the row (`undecided`).
   */
  private noteUndecided(row: StationaryEvidenceRow, observation: StationaryObservation): void {
    const trackId = observation.trackId
    if (trackId === undefined) return
    const key = `${observation.deviceId}:${trackId}`
    if (this.undecidedReported.has(key)) return
    this.undecidedReported.add(key)
    this.logger.debug('stationary evidence: undecided observation — counted as neither N nor M', {
      tags: { deviceId: observation.deviceId },
      meta: {
        deviceId: observation.deviceId,
        trackId,
        candidateKey: row.key,
        movementState: observation.movementState ?? null,
        settling: observation.settling === true,
        agreed: row.agreed,
        seen: row.seen,
        undecided: row.undecided,
      },
    })
  }

  private noteImplausible(row: StationaryEvidenceRow, frame: StationaryEvidenceFrame): void {
    if (this.implausibleReported.has(row.key)) return
    this.implausibleReported.add(row.key)
    this.logger.info('stationary candidate refused — implausible box for a parked object', {
      tags: { deviceId: row.deviceId },
      meta: {
        deviceId: row.deviceId,
        className: row.className,
        candidateKey: row.key,
        bbox: row.bestBbox,
        frameWidth: frame.frameWidth,
        frameHeight: frame.frameHeight,
        agreed: row.agreed,
        seen: row.seen,
        sessionAgreed: row.sessionAgreed,
        burstAgreed: row.burstAgreed,
        spanMs: row.lastAgreedAt - row.firstAgreedAt,
      },
    })
  }

  private async forgetKeyDurable(key: string): Promise<void> {
    const row = this.ledger.get(key)
    this.dirty.delete(key)
    this.implausibleReported.delete(key)
    if (row) this.byDevice.get(row.deviceId)?.delete(key)
    for (const [bindKey, boundTo] of this.binding) {
      if (boundTo === key) this.binding.delete(bindKey)
    }
    await this.ledger.forget(key)
  }

  private async write(row: StationaryEvidenceRow): Promise<void> {
    this.dirty.delete(row.key)
    await this.ledger.put(row)
  }

  private index(row: StationaryEvidenceRow): void {
    let keys = this.byDevice.get(row.deviceId)
    if (!keys) {
      keys = new Set()
      this.byDevice.set(row.deviceId, keys)
    }
    keys.add(row.key)
  }

  /** Drop candidates untouched for {@link EVIDENCE_WINDOW_MS}. Evidence
   *  describes an object that can drive away; a stale candidate is not a
   *  weaker one, it is one about a thing that is gone. */
  private expire(deviceId: number, now: number): void {
    for (const row of this.candidatesFor(deviceId)) {
      if (now - row.updatedAt <= EVIDENCE_WINDOW_MS) continue
      this.logger.debug('stationary evidence expired — candidate untouched past the window', {
        tags: { deviceId },
        meta: {
          className: row.className,
          agreed: row.agreed,
          seen: row.seen,
          ageMs: now - row.updatedAt,
        },
      })
      this.forgetKey(row.key)
    }
  }

  private capDevice(deviceId: number): void {
    const rows = this.candidatesFor(deviceId)
    if (rows.length <= EVIDENCE_MAX_CANDIDATES_PER_DEVICE) return
    const ordered = [...rows].sort((a, b) => a.updatedAt - b.updatedAt)
    const excess = ordered.slice(0, rows.length - EVIDENCE_MAX_CANDIDATES_PER_DEVICE)
    this.logger.info('stationary evidence capped — least-recently-touched candidates evicted', {
      tags: { deviceId },
      meta: { evicted: excess.length, cap: EVIDENCE_MAX_CANDIDATES_PER_DEVICE },
    })
    for (const row of excess) this.forgetKey(row.key)
  }
}
