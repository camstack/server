import type { DemuxPathCounts } from './demux-path-tally'

/**
 * scrub-drag-stats — the per-DRAG accumulator behind `scrub-feeder:drag-end`.
 *
 * D68 rebuilt the scrub (velocity-adaptive mapping, bidirectional P-frame
 * sweep, GOP byte-range reads, timeline warm-up, budgeted seek travel) and none
 * of it had run on real hardware. Tuning it needs per-phase numbers; a per-tick
 * line at drag rates would be a flood on a hub already measured at 70–95% main
 * thread. So the AGGREGATE is the primary surface: one line at drag end
 * carrying counts, sums and min/median/max per phase, and the per-tick lines
 * are sampled or reserved for the pathological cases.
 *
 * The percentile window is BOUNDED ({@link SCRUB_PHASE_SAMPLE_CAP}): a drag can
 * be arbitrarily long, and an unbounded array here would be a leak on the exact
 * path we are trying to make cheap. Count, sum, min and max stay exact past the
 * cap; only the median is computed from the first N samples.
 */

export type ScrubPushMode = 'jump' | 'sweep'
export type ScrubPushDir = 'fwd' | 'back'
/** The client's px→time mapping decision for the sample that produced this tick. */
export type ScrubMapMode = 'fine' | 'coarse'
/** Which tier resolved the covering fragment — the LOCATE question. */
export type ScrubCoverage = 'memo' | 'cache' | 'miss'

/** Everything one processed `scrubTick` learned, phase by phase. */
export interface ScrubTickSample {
  readonly mode: ScrubPushMode
  readonly dir: ScrubPushDir
  /** Null when the client is older than the mapping-hint field. */
  readonly mapMode: ScrubMapMode | null
  readonly velocityPxPerS: number | null
  readonly coverage: ScrubCoverage
  /** `locate` RPCs this tick made (0 on a coverage hit, 2 when a gap snapped). */
  readonly locateCalls: number
  readonly locateMs: number | null
  readonly readMs: number | null
  readonly readBytes: number | null
  /** True when the provider had no `readGopBytes` and the whole file was read. */
  readonly wholeSegmentRead: boolean
  readonly demuxMs: number | null
  readonly aus: number
  readonly travel: number
  /** Bytes this push put on the wire (travel stills included). */
  readonly wireBytes: number
  readonly creditLeft: number
  readonly tickMs: number
}

/** Bound on the per-phase percentile window — see the module docblock. */
export const SCRUB_PHASE_SAMPLE_CAP = 512

/** Count/sum/min/median/max for one phase; `n === 0` ⇒ every number is null. */
export interface PhaseSummary {
  readonly n: number
  readonly minMs: number | null
  readonly p50Ms: number | null
  readonly maxMs: number | null
}

/**
 * A bounded numeric series. Exact count/sum/min/max forever; the median comes
 * from the first {@link SCRUB_PHASE_SAMPLE_CAP} samples.
 */
class PhaseSamples {
  private readonly window: number[] = []
  private n = 0
  private sum = 0
  private min: number | null = null
  private max: number | null = null

  add(value: number): void {
    this.n += 1
    this.sum += value
    if (this.min === null || value < this.min) this.min = value
    if (this.max === null || value > this.max) this.max = value
    if (this.window.length < SCRUB_PHASE_SAMPLE_CAP) this.window.push(value)
  }

  get count(): number {
    return this.n
  }

  get total(): number {
    return this.sum
  }

  summary(): PhaseSummary {
    if (this.n === 0) return { n: 0, minMs: null, p50Ms: null, maxMs: null }
    const sorted = this.window.toSorted((a, b) => a - b)
    const p50 = sorted[Math.floor((sorted.length - 1) / 2)] ?? null
    return { n: this.n, minMs: this.min, p50Ms: p50, maxMs: this.max }
  }
}

/**
 * The flat, all-scalar shape of `scrub-feeder:drag-end`. A TYPE alias (not an
 * interface) on purpose: it must be assignable to the `Record<string, unknown>`
 * the log seam takes, and only a type alias gets the implicit index signature.
 */
export type ScrubDragLogFields = {
  // ── drag ────────────────────────────────────────────────────────────────
  readonly ticks: number
  readonly dragMs: number
  /** Finger-down → first frame on the wire. The number the operator feels. */
  readonly firstPushMs: number | null
  // ── 1. mapping (client-reported) ────────────────────────────────────────
  readonly mapFine: number
  readonly mapCoarse: number
  readonly mapUnknown: number
  readonly velPxPerSP50: number | null
  readonly velPxPerSMax: number | null
  // ── 2. locate ───────────────────────────────────────────────────────────
  readonly coverMemo: number
  readonly coverCache: number
  readonly coverMiss: number
  readonly locateCalls: number
  readonly locateMsP50: number | null
  readonly locateMsMax: number | null
  // ── 3. fetch ────────────────────────────────────────────────────────────
  readonly gopReads: number
  readonly wholeReads: number
  readonly readBytes: number
  readonly readMsP50: number | null
  readonly readMsMax: number | null
  // ── 4. demux ────────────────────────────────────────────────────────────
  readonly demuxCalls: number
  readonly demuxMsP50: number | null
  readonly demuxMsMax: number | null
  readonly demuxJs: number
  readonly demuxFfmpeg: number
  readonly demuxFallback: string | null
  // ── 5. push ─────────────────────────────────────────────────────────────
  readonly jumps: number
  /** Of those, the ones that went BACKWARD — the documented degradation when a
   *  backward delta exceeds the sweep window (no GOP walk, keyframe only). */
  readonly jumpsBack: number
  readonly sweeps: number
  readonly backSweeps: number
  readonly aus: number
  readonly travel: number
  readonly bytes: number
  readonly parks: number
  /** Speculative GOP reads issued this drag, and their bytes — the I/O the
   *  feeder spent on where it GUESSED the drag was going.
   *
   *  **Structurally zero since 2026-08-26**, when the directional prefetch was
   *  deleted. The field stays on the line, at zero, as the seat kept warm for
   *  the next attempt to guess where a finger is going: two versions of that
   *  idea survived for months precisely because their reads never reached a
   *  census. Anything above zero here is a NEW predictor and should be measured
   *  from its first drag. */
  readonly prefetchReads: number
  readonly prefetchBytes: number
  /** Times speculation declined to read because the disk was already the
   *  bottleneck. Also structurally zero — the gate went with the thing it
   *  gated. */
  readonly prefetchSuppressed: number
  /** Ticks served from a fragment speculation landed. Structurally zero. */
  readonly prefetchHits: number
  /** WINDOW-WARM reads issued while this drag was live, and their bytes.
   *
   *  Separate from `prefetch*` because they are a different mechanism with a
   *  different justification: the warm walks the window around the playhead
   *  SEQUENTIALLY, and it is supposed to spend the disk only while the disk is
   *  free. Sharing one counter hid the handover — the drag after the prefetch
   *  was deleted still reported 12 and 17 "prefetch" reads, and they were all
   *  the warm. Read `warmHits` beside these: high reads with zero hits is the
   *  warm taking the arm away from the finger for nothing. */
  readonly warmReads: number
  readonly warmBytes: number
  /** Ticks served from a fragment the warm had already landed. */
  readonly warmHits: number
  /** Pushes written off unacknowledged — a lost ack, or a mute receiver. The
   *  drag survived it (the credit came back), but the frames may never have
   *  painted, so it is dropped work and it is counted. */
  readonly ackTimeouts: number
  /** Frames ABANDONED on their deadline: the fragment could not be produced
   *  inside the frame's share of the gesture, so the tick gave up instead of
   *  waiting. Dropped work by design — and the number that says whether the
   *  deadline is set right. High here WITH `firstPushMs` falling is the change
   *  working; high here with `ticks` collapsing means the deadline is too
   *  tight for this disk. */
  readonly deadlineMisses: number
  /** Landings re-aimed at a newer finger position: the read started for one
   *  target and the fragment it produced also covered the target the finger
   *  had moved to, so the frame painted WHERE THE FINGER IS. This is the
   *  "l'immagine insegue il dito" [the image chases the finger] counter — every retarget is a stale frame
   *  that was never painted. */
  readonly retargets: number
  /** Ticks that RODE a read already in flight instead of starting a second
   *  one. Each is a random seek the drag did not add to a saturated spindle. */
  readonly resolveJoins: number
  /** How far AHEAD of the finger this drag aimed its reads, in ms of timeline.
   *  Zero everywhere means the lead never engaged (no sustained direction, or
   *  too few measured reads); large here beside a falling `retargets` means it
   *  is overshooting and the velocity estimate is wrong. */
  readonly leadMsP50: number | null
  readonly leadMsMax: number | null
  /** Reads that had to degrade from the whole-segment unit to a GOP range
   *  because the `low` segment was over the byte ceiling. Non-zero means the
   *  ceiling and the recorder's segment duration disagree — see
   *  SCRUB_WHOLE_SEGMENT_MAX_BYTES. */
  readonly oversizeSegments: number
  /** The profile this drag actually ran on when it is NOT the scrub profile,
   *  else null. Every scrub optimisation (whole-segment reads, the 48 MB cache
   *  budget, the entry warm) is gated on `low`, so a non-null here is a drag
   *  running with all three off — and it used to be indistinguishable from a
   *  slow disk. */
  readonly degradedProfile: string | null
  readonly failures: number
  readonly creditEndedAt: number | null
  // ── 6. ack / render ─────────────────────────────────────────────────────
  readonly acks: number
  readonly ackMsMin: number | null
  readonly ackMsP50: number | null
  readonly ackMsMax: number | null
  // ── whole tick ──────────────────────────────────────────────────────────
  readonly tickMsP50: number | null
  readonly tickMsMax: number | null
}

export class ScrubDragStats {
  private ticks = 0
  private jumps = 0
  private jumpsBack = 0
  private sweeps = 0
  private backSweeps = 0
  private aus = 0
  private travel = 0
  private bytes = 0
  private mapFine = 0
  private mapCoarse = 0
  private mapUnknown = 0
  private coverMemo = 0
  private coverCache = 0
  private coverMiss = 0
  private locateCalls = 0
  private gopReads = 0
  private wholeReads = 0
  private readBytes = 0
  private parks = 0
  private prefetchReads = 0
  private prefetchBytes = 0
  private prefetchHits = 0
  private prefetchSuppressed = 0
  private warmReads = 0
  private warmBytes = 0
  private warmHits = 0
  private ackTimeouts = 0
  private deadlineMisses = 0
  private retargets = 0
  private resolveJoins = 0
  private failures = 0
  private firstPushMs: number | null = null
  private creditEndedAt: number | null = null
  private readonly velocity = new PhaseSamples()
  private readonly locateMs = new PhaseSamples()
  private readonly readMs = new PhaseSamples()
  private readonly demuxMs = new PhaseSamples()
  private readonly tickMs = new PhaseSamples()
  private readonly ackMs = new PhaseSamples()
  private readonly leadMs = new PhaseSamples()
  private oversizeSegments = 0
  private degradedProfile: string | null = null

  constructor(private readonly startedAtMs: number) {}

  recordTick(sample: ScrubTickSample, nowMs: number = performance.now()): void {
    this.ticks += 1
    if (this.firstPushMs === null) this.firstPushMs = Math.round(nowMs - this.startedAtMs)
    if (sample.mode === 'jump') {
      this.jumps += 1
      if (sample.dir === 'back') this.jumpsBack += 1
    } else if (sample.dir === 'back') this.backSweeps += 1
    else this.sweeps += 1
    this.aus += sample.aus
    this.travel += sample.travel
    this.bytes += sample.wireBytes
    if (sample.mapMode === 'fine') this.mapFine += 1
    else if (sample.mapMode === 'coarse') this.mapCoarse += 1
    else this.mapUnknown += 1
    if (sample.velocityPxPerS !== null) this.velocity.add(sample.velocityPxPerS)
    if (sample.coverage === 'memo') this.coverMemo += 1
    else if (sample.coverage === 'cache') this.coverCache += 1
    else this.coverMiss += 1
    this.locateCalls += sample.locateCalls
    if (sample.locateMs !== null) this.locateMs.add(sample.locateMs)
    if (sample.readMs !== null) this.readMs.add(sample.readMs)
    if (sample.readBytes !== null) {
      this.readBytes += sample.readBytes
      if (sample.wholeSegmentRead) this.wholeReads += 1
      else this.gopReads += 1
    }
    if (sample.demuxMs !== null) this.demuxMs.add(sample.demuxMs)
    this.tickMs.add(sample.tickMs)
    this.creditEndedAt = sample.creditLeft
  }

  /** A tick that PARKED on zero credit — dropped-for-now work, not a push. */
  recordPark(): void {
    this.parks += 1
  }

  /** One speculative GOP read and what it cost the disk. */
  recordPrefetchRead(bytes: number): void {
    this.prefetchReads += 1
    this.prefetchBytes += bytes
  }

  /** Speculation declined: the disk is already the constraint. */
  recordPrefetchSuppressed(): void {
    this.prefetchSuppressed += 1
  }

  /** A tick served by a fragment speculation had already landed. */
  recordPrefetchHit(): void {
    this.prefetchHits += 1
  }

  /** One window-warm read taken while the drag was live, and what it cost. */
  recordWarmRead(bytes: number): void {
    this.warmReads += 1
    this.warmBytes += bytes
  }

  /** A tick served by a fragment the window warm had already landed. */
  recordWarmHit(): void {
    this.warmHits += 1
  }

  /** Pushes written off after the ack timeout — dropped work, never silent. */
  recordAckTimeout(pushes: number): void {
    this.ackTimeouts += pushes
  }

  /** A frame abandoned on its deadline — dropped work, counted every time. */
  recordDeadlineMiss(): void {
    this.deadlineMisses += 1
  }

  /** A landing re-aimed at the newer finger position it also covered. */
  recordRetarget(): void {
    this.retargets += 1
  }

  /** A whole-segment read that had to degrade to a GOP range on size. */
  recordOversizeSegment(): void {
    this.oversizeSegments += 1
  }

  /** This drag is not running on the scrub profile — every gate is off. */
  recordProfileDegraded(profile: string): void {
    this.degradedProfile = profile
  }

  /** One read aimed ahead of the finger, and by how much. */
  recordLead(leadMs: number): void {
    this.leadMs.add(Math.abs(leadMs))
  }

  /** A tick served by the read another tick already had in flight. */
  recordResolveJoin(): void {
    this.resolveJoins += 1
  }

  /** A swallowed `scrubTick` throw — the branch where a dark failure hides. */
  recordFailure(): void {
    this.failures += 1
  }

  /** One push→render round trip, measured from the push that the ack settles. */
  recordAckRtt(rttMs: number): void {
    this.ackMs.add(rttMs)
  }

  toLogFields(dragMs: number, demux?: DemuxPathCounts): ScrubDragLogFields {
    const vel = this.velocity.summary()
    const locate = this.locateMs.summary()
    const read = this.readMs.summary()
    const dmx = this.demuxMs.summary()
    const tick = this.tickMs.summary()
    const ack = this.ackMs.summary()
    const lead = this.leadMs.summary()
    return {
      ticks: this.ticks,
      dragMs: Math.round(dragMs),
      firstPushMs: this.firstPushMs,
      mapFine: this.mapFine,
      mapCoarse: this.mapCoarse,
      mapUnknown: this.mapUnknown,
      velPxPerSP50: vel.p50Ms,
      velPxPerSMax: vel.maxMs,
      coverMemo: this.coverMemo,
      coverCache: this.coverCache,
      coverMiss: this.coverMiss,
      locateCalls: this.locateCalls,
      locateMsP50: locate.p50Ms,
      locateMsMax: locate.maxMs,
      gopReads: this.gopReads,
      wholeReads: this.wholeReads,
      readBytes: this.readBytes,
      readMsP50: read.p50Ms,
      readMsMax: read.maxMs,
      demuxCalls: dmx.n,
      demuxMsP50: dmx.p50Ms,
      demuxMsMax: dmx.maxMs,
      demuxJs: demux?.js ?? 0,
      demuxFfmpeg: demux?.ffmpeg ?? 0,
      demuxFallback: demux?.lastFallbackReason ?? null,
      jumps: this.jumps,
      jumpsBack: this.jumpsBack,
      sweeps: this.sweeps,
      backSweeps: this.backSweeps,
      aus: this.aus,
      travel: this.travel,
      bytes: this.bytes,
      parks: this.parks,
      prefetchReads: this.prefetchReads,
      prefetchBytes: this.prefetchBytes,
      prefetchHits: this.prefetchHits,
      prefetchSuppressed: this.prefetchSuppressed,
      warmReads: this.warmReads,
      warmBytes: this.warmBytes,
      warmHits: this.warmHits,
      ackTimeouts: this.ackTimeouts,
      deadlineMisses: this.deadlineMisses,
      retargets: this.retargets,
      resolveJoins: this.resolveJoins,
      leadMsP50: lead.p50Ms,
      leadMsMax: lead.maxMs,
      oversizeSegments: this.oversizeSegments,
      degradedProfile: this.degradedProfile,
      failures: this.failures,
      creditEndedAt: this.creditEndedAt,
      acks: ack.n,
      ackMsMin: ack.minMs,
      ackMsP50: ack.p50Ms,
      ackMsMax: ack.maxMs,
      tickMsP50: tick.p50Ms,
      tickMsMax: tick.maxMs,
    }
  }
}
