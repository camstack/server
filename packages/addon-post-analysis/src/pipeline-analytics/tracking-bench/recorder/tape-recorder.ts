/**
 * The tracking-tape recorder (D681, spec §3.3).
 *
 * Per camera whose `trackingTape` switch is on: every frame given to the
 * tracker, every dropout skip, every `dropTrack`, every processor build,
 * every scene change, every recognizer verdict and every L2 fusion (tape v2,
 * D683) is appended to the camera's current SEGMENT — 10 minutes
 * of frame time, self-contained (own header), relative time only. The origin
 * lives in the file name; nothing inside the file is absolute.
 *
 * The frame path is synchronous. Opening a segment is not (a sink, the
 * lighting), so records built before the sink is ready wait in a bounded
 * pending list and are flushed behind the header.
 *
 * Nothing here may throw into the frame path (Task 10): every public entry is
 * a try/catch — no closure, so the unarmed cost stays one lookup — and a
 * throw is logged, reported `failing` and backed off like a sink that could
 * not open. A tape is an observer; a broken observer loses its tape, never a
 * frame.
 *
 * A switched-off camera costs `onFrame` ONE map lookup. A rebuild pending when
 * a new segment opens is written as that segment's first record: a segment
 * boundary is not a tracker reset, and the replay must not treat it as one.
 */
import type { FaceIdentityVerdict } from '../../face-recognizer.js'
import {
  TAPE_FORMAT,
  TAPE_RECORDER_ID,
  TAPE_VERSION,
  type TapeEndReason,
  type TapeHeader,
  type TapePlane,
  type TapeProcessorInputs,
  type TapeProcessorRecord,
  type TapeRecord,
  type TapeScene,
  type TapeStationaryEntry,
} from '../tape-schema.js'
import { buildFrameRecord, buildIdentityRecord, buildSkipRecord, tapeBox } from './frame-record.js'
import { TapeSegmentWriter } from './segment-writer.js'
import type {
  TapeCameraStatus,
  TapeDropInput,
  TapeFrameInput,
  TapeFusionInput,
  TapeRecorderDeps,
  TapeSkipInput,
  TapeStopOutcome,
} from './tape-recorder-types.js'

export const SEGMENT_MS = 10 * 60_000
export const OPEN_RETRY_MS = 60_000
/** How long addon shutdown waits for open segments to close. A hung disk must
 *  not hold the rest of `onShutdown` hostage; a segment it abandons has no
 *  gzip trailer and is read as a `restart` gap (plan decision 11). */
export const STOP_DEADLINE_MS = 5_000
/** Which entry point a failure came through, for the log line. */
type TapeEntryPoint = 'arm' | 'processor' | 'frame' | 'skip' | 'drop' | 'identity' | 'fusion'

/** Records held while a sink opens; beyond, they are counted as lost. */
const MAX_PENDING_RECORDS = 2_000

const EMPTY_SCENE: TapeScene = {
  zones: [],
  rules: [],
  zoneMembershipMinOverlap: 0,
  lowScoreFloor: null,
}

/** Record time lost while a sink was still opening. */
interface LostSpan {
  readonly fromT: number
  readonly toT: number
}

/** What a segment's header is built from, captured when it opens. */
interface SegmentHeaderParts {
  readonly planes: TapeHeader['planes']
  readonly entries: readonly TapeStationaryEntry[]
  readonly scene: TapeScene
}

interface OpenSegment {
  readonly originMs: number
  readonly tapeId: string
  writer: TapeSegmentWriter | null
  readonly pending: TapeRecord[]
  lastT: number
  lost: LostSpan | null
  closing: TapeEndReason | null
  /** `startSink` for this segment — settles once the segment is open, or
   *  once a close requested while it was opening has finished (L5). Never
   *  rejects. */
  opening: Promise<void> | null
}

interface CameraTape {
  armed: boolean
  armedSinceMs: number | undefined
  segment: OpenSegment | null
  readonly inputs: Map<TapePlane, TapeProcessorInputs>
  readonly pendingProcessor: Map<TapePlane, TapeProcessorRecord['reason']>
  scene: TapeScene | null
  sceneJson: string | null
  failing: string | null
  retryAtMs: number
  frames: number
  gaps: number
  segments: number
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class TapeRecorder {
  private readonly deps: TapeRecorderDeps
  private readonly cameras = new Map<number, CameraTape>()

  constructor(deps: TapeRecorderDeps) {
    this.deps = deps
  }

  private camera(deviceId: number): CameraTape {
    const known = this.cameras.get(deviceId)
    if (known !== undefined) return known
    const fresh: CameraTape = {
      armed: false,
      armedSinceMs: undefined,
      segment: null,
      inputs: new Map(),
      pendingProcessor: new Map(),
      scene: null,
      sceneJson: null,
      failing: null,
      retryAtMs: 0,
      frames: 0,
      gaps: 0,
      segments: 0,
    }
    this.cameras.set(deviceId, fresh)
    return fresh
  }

  setArmed(deviceId: number, armed: boolean): void {
    try {
      this.arm(deviceId, armed)
    } catch (err) {
      this.entryFailed(deviceId, 'arm', err)
    }
  }

  private arm(deviceId: number, armed: boolean): void {
    const known = this.cameras.get(deviceId)
    if (known === undefined && !armed) return
    const cam = known ?? this.camera(deviceId)
    if (cam.armed === armed) return
    cam.armed = armed
    if (armed) {
      cam.armedSinceMs = this.deps.now()
      cam.frames = 0
      cam.gaps = 0
      cam.segments = 0
      cam.failing = null
      // A processor built before the switch went on is in the next header.
      cam.pendingProcessor.clear()
      this.deps.logger.info('tracking tape switched on', { tags: { deviceId } })
      return
    }
    cam.armedSinceMs = undefined
    this.deps.logger.info('tracking tape switched off', { tags: { deviceId } })
    this.detachClose(deviceId, cam, 'switched-off')
  }

  isArmed(deviceId: number): boolean {
    return this.cameras.get(deviceId)?.armed === true
  }

  noteProcessor(deviceId: number, plane: TapePlane, inputs: TapeProcessorInputs): void {
    try {
      const cam = this.camera(deviceId)
      cam.pendingProcessor.set(plane, cam.inputs.has(plane) ? 'rebuilt' : 'created')
      cam.inputs.set(plane, inputs)
    } catch (err) {
      this.entryFailed(deviceId, 'processor', err)
    }
  }

  onFrame(input: TapeFrameInput): void {
    try {
      this.recordFrame(input)
    } catch (err) {
      this.entryFailed(input.deviceId, 'frame', err)
    }
  }

  private recordFrame(input: TapeFrameInput): void {
    const cam = this.cameras.get(input.deviceId)
    if (cam === undefined || !cam.armed) return
    const seg = this.segmentFor(input.deviceId, cam, input.frame.timestamp, input.scene)
    if (seg === null) return
    const t = input.frame.timestamp - seg.originMs
    this.flushControl(cam, seg, t, input.scene)
    this.append(
      seg,
      buildFrameRecord({
        t,
        plane: input.plane,
        frame: input.frame,
        injectedIds: input.injectedIds,
        observation: input.observation,
        faces: this.deps.faces,
      }),
      t,
    )
    cam.frames += 1
    // A frame reached its segment: whatever failed before is behind us. A
    // sink that later fails to open sets it again from `startSink`.
    cam.failing = null
  }

  onSkip(input: TapeSkipInput): void {
    try {
      this.recordSkip(input)
    } catch (err) {
      this.entryFailed(input.deviceId, 'skip', err)
    }
  }

  private recordSkip(input: TapeSkipInput): void {
    const cam = this.cameras.get(input.deviceId)
    if (cam === undefined || !cam.armed) return
    const seg = this.segmentFor(input.deviceId, cam, input.frame.timestamp, cam.scene)
    if (seg === null) return
    const t = input.frame.timestamp - seg.originMs
    this.append(
      seg,
      buildSkipRecord({ t, plane: input.plane, frame: input.frame, faces: this.deps.faces }),
      t,
    )
  }

  /**
   * A drop is a tracker input no frame carries: it must reach the tape even
   * when no segment is open (right after a rotation), or the replay diverges.
   * It opens one like a skip does; if none can open, the loss is logged.
   */
  onDrop(input: TapeDropInput): void {
    try {
      this.recordDrop(input)
    } catch (err) {
      this.entryFailed(input.deviceId, 'drop', err)
    }
  }

  private recordDrop(input: TapeDropInput): void {
    const cam = this.cameras.get(input.deviceId)
    if (cam === undefined || !cam.armed) return
    const seg = this.segmentFor(input.deviceId, cam, input.atMs, cam.scene)
    if (seg === null) {
      this.deps.logger.warn('tracking tape drop not recorded', {
        tags: { deviceId: input.deviceId },
        meta: { trackId: input.trackId, atMs: input.atMs, reason: cam.failing ?? 'no segment' },
      })
      return
    }
    const t = input.atMs - seg.originMs
    this.append(
      seg,
      { kind: 'drop', t, plane: input.plane, trk: input.trackId, reason: input.reason },
      t,
    )
  }

  /**
   * (Amended 2026-09-29 for D683 R3.) The FaceRecognizer's verdict on a live
   * track, recorded at ITS frame's time and appended NOW, in call order — not
   * through `flushControl`, which would stamp it with the next frame. The
   * verdict for frame k is observed after frames k+1…k+n went by (the
   * recognizer runs fire-and-forget and awaits crop captures), so the record
   * follows those frames: tape order = the order the live processor received
   * it. Never written at a time outside its own segment.
   */
  onIdentity(verdict: FaceIdentityVerdict): void {
    try {
      this.recordIdentity(verdict)
    } catch (err) {
      this.entryFailed(verdict.deviceId, 'identity', err)
    }
  }

  private recordIdentity(verdict: FaceIdentityVerdict): void {
    const cam = this.cameras.get(verdict.deviceId)
    if (cam === undefined || !cam.armed) return
    const seg = cam.segment
    // `timestamp < originMs` is how a verdict of an ALREADY-CLOSED segment is
    // recognised. That holds only because frame timestamps are monotonically
    // non-decreasing per camera (a segment opens at the first frame at or past
    // the previous one's end). A per-camera clock that could step backwards
    // would let a closed segment's verdict land in the current one.
    const lost =
      seg === null ? 'no-segment' : verdict.timestamp < seg.originMs ? 'segment-closed' : null
    if (seg === null || lost !== null) {
      this.deps.logger.warn('tracking tape identity not recorded', {
        tags: { deviceId: verdict.deviceId },
        meta: {
          trackId: verdict.trackId,
          timestamp: verdict.timestamp,
          reason: lost ?? 'no-segment',
        },
      })
      return
    }
    const t = verdict.timestamp - seg.originMs
    this.append(
      seg,
      buildIdentityRecord({
        t,
        trackId: verdict.trackId,
        identityId: verdict.identityId,
        faces: this.deps.faces,
      }),
      t,
    )
  }

  /**
   * (D683 Task 12) An L2 fusion the live tracker committed — from a frame or
   * from the silence sweep, which has no frame record (`applyTrackFusions`
   * is where both paths meet). Follows `onIdentity`: armed cameras only,
   * stamped at the fusion's OWN frame time, appended at call time; one whose
   * frame time falls before the open segment's origin (or with no segment
   * open) is logged, never written at a wrong time.
   */
  onFusion(input: TapeFusionInput): void {
    try {
      this.recordFusion(input)
    } catch (err) {
      this.entryFailed(input.deviceId, 'fusion', err)
    }
  }

  private recordFusion(input: TapeFusionInput): void {
    const cam = this.cameras.get(input.deviceId)
    if (cam === undefined || !cam.armed) return
    const { fusion } = input
    const seg = cam.segment
    const lost = seg === null ? 'no-segment' : fusion.t < seg.originMs ? 'segment-closed' : null
    if (seg === null || lost !== null) {
      this.deps.logger.warn('tracking tape fusion not recorded', {
        tags: { deviceId: input.deviceId },
        meta: {
          survivorId: fusion.survivorId,
          absorbedId: fusion.absorbedId,
          t: fusion.t,
          reason: lost ?? 'no-segment',
        },
      })
      return
    }
    const t = fusion.t - seg.originMs
    this.append(
      seg,
      {
        kind: 'fusion',
        t,
        plane: input.plane,
        survivor: fusion.survivorId,
        absorbed: fusion.absorbedId,
        members: [...fusion.members],
      },
      t,
    )
  }

  /** This recorder's session — what every segment it writes carries. */
  sessionId(): string {
    return this.deps.session
  }

  async rotateNow(deviceId: number): Promise<void> {
    const cam = this.cameras.get(deviceId)
    if (cam !== undefined) await this.closeSegment(deviceId, cam, 'segment-end')
  }

  /**
   * Push every open segment's pending gzip output to disk without rotating
   * (D681 follow-up). A silent / quiet camera otherwise keeps its tail only
   * in the zlib buffer until the next frame or the 10-minute cut — a crash
   * loses it, and `bytesLastHour` lags behind what was already recorded.
   * Never throws: a per-camera flush fault is logged inside the writer.
   */
  async flushOpenSegments(): Promise<void> {
    const pending: Promise<void>[] = []
    for (const cam of this.cameras.values()) {
      const writer = cam.segment?.writer
      if (writer !== undefined && writer !== null) pending.push(writer.flushToDisk())
    }
    await Promise.all(pending)
  }

  /**
   * Close the camera's open segment only if it holds time at or before
   * `atMs` — what a promotion of a window ending at `atMs` needs on disk
   * (Task 12 fix round, H1). A window wholly before the open segment leaves
   * it alone: an unneeded rotation is one more `segment-end` boundary a boot
   * could follow with no `addon-stopped`. Returns whether it rotated.
   */
  async rotateCovering(deviceId: number, atMs: number): Promise<boolean> {
    const cam = this.cameras.get(deviceId)
    const seg = cam?.segment ?? null
    if (cam === undefined || seg === null || seg.originMs > atMs) return false
    await this.closeSegment(deviceId, cam, 'segment-end')
    return true
  }

  async stopAll(deadlineMs: number = STOP_DEADLINE_MS): Promise<TapeStopOutcome> {
    const pending = new Set<number>()
    const closing = Promise.all(
      [...this.cameras].map(async ([deviceId, cam]) => {
        pending.add(deviceId)
        await this.closeLogged(deviceId, cam, 'addon-stopped')
        pending.delete(deviceId)
      }),
    ).then((): TapeStopOutcome => 'stopped')
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<TapeStopOutcome>((resolve) => {
      timer = setTimeout(() => resolve('timed-out'), deadlineMs)
      timer.unref?.()
    })
    const outcome = await Promise.race([closing, deadline])
    clearTimeout(timer)
    if (outcome === 'timed-out') {
      for (const deviceId of pending) {
        this.deps.logger.warn('tracking tapes did not stop in time', {
          tags: { deviceId },
          meta: { deadlineMs },
        })
      }
    }
    return outcome
  }

  status(deviceId: number): TapeCameraStatus {
    const cam = this.cameras.get(deviceId)
    const writer = cam?.segment?.writer ?? null
    const base = {
      deviceId,
      framesInSegment: writer?.counts.frames ?? 0,
      rawBytesInSegment: writer?.rawBytesWritten ?? 0,
      framesSinceArmed: cam?.frames ?? 0,
      gapsSinceArmed: (cam?.gaps ?? 0) + (writer?.counts.gaps ?? 0),
      segmentsSinceArmed: cam?.segments ?? 0,
    }
    if (cam === undefined || !cam.armed) return { ...base, state: 'off' }
    const armedSince = cam.armedSinceMs === undefined ? {} : { armedSinceMs: cam.armedSinceMs }
    if (cam.failing !== null)
      return { ...base, ...armedSince, state: 'failing', reason: cam.failing }
    const origin = cam.segment === null ? {} : { segmentOriginMs: cam.segment.originMs }
    return { ...base, ...armedSince, ...origin, state: 'recording' }
  }

  private segmentFor(
    deviceId: number,
    cam: CameraTape,
    timestamp: number,
    scene: TapeScene | null,
  ): OpenSegment | null {
    if (cam.failing !== null && this.deps.now() < cam.retryAtMs) return null
    const current = cam.segment
    if (current !== null) {
      const full = current.writer?.isFull === true
      if (!full && timestamp - current.originMs < SEGMENT_MS) return current
      this.detachClose(deviceId, cam, full ? 'size-cap' : 'segment-end')
    }
    return this.openSegment(deviceId, cam, timestamp, scene ?? EMPTY_SCENE)
  }

  private openSegment(
    deviceId: number,
    cam: CameraTape,
    originMs: number,
    scene: TapeScene,
  ): OpenSegment {
    // Everything that can throw comes BEFORE the segment is installed: a
    // half-installed segment (writer never started) would swallow every later
    // record into `pending` and then into `lost`, with no line saying why.
    const entries: TapeStationaryEntry[] = this.deps.stationaryEntries(deviceId).map((e) => ({
      id: e.id,
      cls: e.className,
      b: tapeBox(e.bbox.x, e.bbox.y, e.bbox.w, e.bbox.h),
      since: e.becameStationaryAt - originMs,
    }))
    const pipeline = cam.inputs.get('pipeline')
    const onboard = cam.inputs.get('onboard')
    const planes: TapeHeader['planes'] = {
      ...(pipeline !== undefined ? { pipeline } : {}),
      ...(onboard !== undefined ? { onboard } : {}),
    }
    const sceneJson = JSON.stringify(scene)
    const seg: OpenSegment = {
      originMs,
      tapeId: this.deps.mintTapeId(),
      writer: null,
      pending: [],
      lastT: 0,
      lost: null,
      closing: null,
      opening: null,
    }
    cam.segment = seg
    cam.segments += 1
    cam.scene = scene
    cam.sceneJson = sceneJson
    seg.opening = this.startSink(deviceId, cam, seg, { planes, entries, scene })
    return seg
  }

  private async startSink(
    deviceId: number,
    cam: CameraTape,
    seg: OpenSegment,
    parts: SegmentHeaderParts,
  ): Promise<void> {
    try {
      const lighting = await this.deps.lighting(deviceId, seg.originMs)
      const sink = await this.deps.openSink(this.deps.segmentFile(deviceId, seg.originMs))
      const writer = new TapeSegmentWriter({
        sink,
        deviceId,
        segmentOriginMs: seg.originMs,
        logger: this.deps.logger,
        ...(this.deps.maxRawBytes !== undefined ? { maxRawBytes: this.deps.maxRawBytes } : {}),
      })
      const header: TapeHeader = {
        kind: 'header',
        format: TAPE_FORMAT,
        version: TAPE_VERSION,
        tapeId: seg.tapeId,
        deviceId,
        lighting,
        recorder: TAPE_RECORDER_ID,
        planes: parts.planes,
        scene: parts.scene,
        stationaryEntries: [...parts.entries],
        session: this.deps.session,
      }
      writer.append(header, 0)
      for (const r of seg.pending.splice(0)) writer.append(r, seg.lastT)
      if (seg.lost !== null) writer.writeGap(seg.lost.fromT, seg.lost.toT, 'backpressure')
      seg.lost = null
      seg.writer = writer
      cam.failing = null
      if (seg.closing !== null) await this.finishSegment(deviceId, cam, seg, seg.closing)
    } catch (err) {
      cam.failing = errorText(err)
      cam.retryAtMs = this.deps.now() + OPEN_RETRY_MS
      if (cam.segment === seg) cam.segment = null
      this.deps.logger.warn('tracking tape segment could not open', {
        tags: { deviceId },
        meta: { originMs: seg.originMs, error: cam.failing },
      })
    }
  }

  private flushControl(cam: CameraTape, seg: OpenSegment, t: number, scene: TapeScene): void {
    for (const [plane, reason] of cam.pendingProcessor) {
      const inputs = cam.inputs.get(plane)
      if (inputs !== undefined) this.append(seg, { kind: 'processor', t, plane, inputs, reason }, t)
    }
    cam.pendingProcessor.clear()
    const json = JSON.stringify(scene)
    if (json !== cam.sceneJson) {
      cam.sceneJson = json
      cam.scene = scene
      this.append(seg, { kind: 'scene', t, scene }, t)
    }
  }

  private append(seg: OpenSegment, record: TapeRecord, t: number): void {
    seg.lastT = Math.max(seg.lastT, t)
    if (seg.writer !== null) {
      seg.writer.append(record, t)
      return
    }
    if (seg.pending.length < MAX_PENDING_RECORDS) {
      seg.pending.push(record)
      return
    }
    seg.lost = seg.lost === null ? { fromT: t, toT: t } : { fromT: seg.lost.fromT, toT: t }
  }

  /**
   * A throw inside an entry point: logged, the camera reported `failing`, and
   * backed off for `OPEN_RETRY_MS` (`segmentFor` honours it) — one line a
   * minute per camera, not one per frame.
   */
  private entryFailed(deviceId: number, record: TapeEntryPoint, err: unknown): void {
    const error = errorText(err)
    const cam = this.cameras.get(deviceId)
    const segmentEnded = cam !== undefined && cam.segment !== null
    if (cam !== undefined) {
      cam.failing = error
      cam.retryAtMs = this.deps.now() + OPEN_RETRY_MS
      // M1: never resume the SAME segment after the backoff — a minute of
      // missing frames with no `gap` would replay as a tracker that saw
      // nothing move. Ending it puts the loss BETWEEN segments, where a
      // promotion reads it as a `restart` gap, and the next segment restates
      // processors, scene and stationary entries in its own header — whatever
      // a half-finished record left behind is not carried forward.
      if (cam.segment !== null) {
        cam.gaps += 1
        this.detachClose(deviceId, cam, 'recorder-error')
      }
    }
    this.deps.logger.warn('tracking tape record failed', {
      tags: { deviceId },
      meta: { record, error, retryInMs: OPEN_RETRY_MS, segmentEnded },
    })
  }

  /** A close started from a synchronous path. Its rejection has no caller to
   *  reach, and an unhandled one would take the process down. */
  private detachClose(deviceId: number, cam: CameraTape, reason: TapeEndReason): void {
    void this.closeLogged(deviceId, cam, reason)
  }

  /** `closeSegment` that never rejects: a throw is logged under the same line
   *  a sink that cannot finish writes. `stopAll` (addon shutdown) uses it too. */
  private async closeLogged(
    deviceId: number,
    cam: CameraTape,
    reason: TapeEndReason,
  ): Promise<void> {
    try {
      await this.closeSegment(deviceId, cam, reason)
    } catch (err) {
      this.deps.logger.warn('tracking tape segment could not close', {
        tags: { deviceId },
        meta: { reason, error: errorText(err) },
      })
    }
  }

  private async closeSegment(
    deviceId: number,
    cam: CameraTape,
    reason: TapeEndReason,
  ): Promise<void> {
    const seg = cam.segment
    if (seg === null) return
    cam.segment = null
    if (seg.writer === null) {
      // Still opening: `startSink` finishes it with this reason once the sink
      // is up. Wait for that, so a caller that rotates to READ the segment
      // (a promotion) never reads it mid-write (L5).
      seg.closing = reason
      await seg.opening
      return
    }
    await this.finishSegment(deviceId, cam, seg, reason)
  }

  // `TapeSegmentWriter.close()` (Task 8, fix round 1) no longer throws on a
  // sink failure — it catches it itself, logs its own device-tagged line, and
  // returns a `CloseOutcome` (`'closed' | 'close-failed'`). This reads that
  // outcome rather than wrapping the call in a `try`/`catch`: a `catch` here
  // would never fire (Task 8's own review is what removed the throw), and
  // reporting the outcome is what actually gates `onSegmentClosed` — closed
  // segments feed the shelf sweep, and a segment whose sink could not finish
  // must not be treated as one that did.
  private async finishSegment(
    deviceId: number,
    cam: CameraTape,
    seg: OpenSegment,
    reason: TapeEndReason,
  ): Promise<void> {
    const writer = seg.writer
    if (writer === null) return
    const outcome = await writer.close(reason, seg.lastT)
    if (outcome !== 'closed') {
      // Task 8's `close()` already logged `tracking tape segment close
      // failed` with the underlying reason (tagged `deviceId`) — this line is
      // the RECORDER's own decision, not a repeat of the writer's: it names
      // which segment this was and that `onSegmentClosed` was withheld.
      this.deps.logger.warn('tracking tape segment could not close', {
        tags: { deviceId },
        meta: { originMs: seg.originMs, reason },
      })
      return
    }
    cam.gaps += writer.counts.gaps
    this.deps.logger.info('tracking tape segment closed', {
      tags: { deviceId },
      meta: { originMs: seg.originMs, reason, ...writer.counts, rawBytes: writer.rawBytesWritten },
    })
    this.deps.onSegmentClosed(deviceId)
  }
}
