/**
 * The grid's own motion / audio / detection, forwarded from its sources.
 *
 * ## Why the grid speaks a camera's language instead of a new one
 *
 * The operator asked for the grid's tile to light up in the viewer exactly as a
 * camera's card does, with NO app change. The app already knows how: it filters
 * `motion.on-motion-changed` by `deviceId` for the motion ring,
 * `pipeline.audio-inference-result` for the audio one, and `detection.result`
 * for the detection one. So the grid answers those three questions about its
 * own device id, in the same shapes. Nothing new is invented, and nothing in
 * the viewer is touched.
 *
 * The rules are the operator's: motion if AT LEAST ONE source has it, and the
 * LOUDEST source's level for audio.
 *
 * ## What speaking a camera's language costs, and why it is safe here
 *
 * Those categories have other listeners, and emitting on them makes the grid a
 * motion source for the whole system. Checked, one by one, before shipping:
 * the recorder's event capture, the HomeKit and Alexa exports and the Home
 * Assistant export are all per-device and do nothing until an operator enables
 * them for this camera — and if an operator DOES export a grid to HomeKit, a
 * grid reporting motion is correct, not a surprise.
 *
 * The one listener with no gate of its own was `pipeline-analytics`, which
 * would have opened a motion EPISODE per grid, duplicating the rows its sources
 * already write. Its gate turned out to be the `pipeline-analytics` WRAPPER
 * BINDING, so the answer is the one the operator gave: a derived camera is
 * created with the analytics wrappers OFF (`grid-analytics-defaults.ts`).
 * That is a binding, not a new flag, so an operator who wants a grid analysed
 * can simply turn it back on.
 *
 * ## Detection carries boxes whether or not anyone wanted them
 *
 * `detection.result` is the same event the viewer draws BOXES from, so a grid
 * that reports detections reports boxes. Sending the source's own pixel box
 * would draw it against the composed canvas at confidently wrong coordinates,
 * so every box is carried through the cell geometry first
 * (`grid-detection-mapping.ts`) and lands where the subject actually is.
 */
import {
  createEvent,
  EventCategory,
  type AudioResult,
  type DetectionResultPayload,
  type FrameResult,
  type IEventBus,
  type IScopedLogger,
  type MotionOnMotionChangedPayload,
  type ObjectDetection,
  type PipelineAudioInferenceResultPayload,
} from '@camstack/types'
import { GridActivityMirror, type GridMotionState } from './grid-activity-mirror.js'
import { mapDetectionToCanvas, type GridMappingCell } from './grid-detection-mapping.js'

/** Everything this needs to know about one grid, re-read on every event. */
export interface GridActivityTarget {
  readonly deviceId: number
  readonly canvas: { readonly width: number; readonly height: number }
  /** Every cell this source appears in. Empty ⇒ the grid does not show it. */
  cellsForSource(sourceDeviceId: number): readonly GridMappingCell[]
  /** Every source this grid composes, for the mirror's housekeeping. */
  readonly sourceDeviceIds: readonly number[]
}

export interface GridActivityDeps {
  readonly eventBus: IEventBus
  readonly logger: IScopedLogger
  readonly addonId: string
  /** The grids that contain this source, or empty. */
  gridsForSource(sourceDeviceId: number): readonly GridActivityTarget[]
  readonly now: () => number
}

/**
 * One mirror per grid, and the emission that follows an update.
 *
 * Deliberately NOT one mirror per source: the question is always "is THIS grid
 * lit", and a source shared by two grids answers it twice, differently, because
 * the other cells differ.
 */
export class GridActivityForwarder {
  private readonly mirrors = new Map<number, GridActivityMirror>()

  constructor(private readonly deps: GridActivityDeps) {}

  /** A source camera's motion push. */
  onSourceMotion(sourceDeviceId: number, detected: boolean, atMs: number): void {
    for (const grid of this.deps.gridsForSource(sourceDeviceId)) {
      const mirror = this.mirrorFor(grid)
      const before = mirror.motionAt(atMs).detected
      mirror.noteMotion(sourceDeviceId, detected, atMs)
      const after = mirror.motionAt(atMs)
      // Only the EDGE is emitted. `motion.on-motion-changed` is a transition,
      // and re-announcing "still moving" on every source's every push would
      // give a four-camera grid four times the traffic of a camera for the
      // same fact.
      if (after.detected === before) continue
      this.emitMotion(grid.deviceId, after, atMs)
    }
  }

  /** A source camera's audio window. */
  onSourceAudio(sourceDeviceId: number, dbfs: number, atMs: number): void {
    for (const grid of this.deps.gridsForSource(sourceDeviceId)) {
      const mirror = this.mirrorFor(grid)
      mirror.noteAudio(sourceDeviceId, dbfs, atMs)
      const loudest = mirror.loudestAt(atMs)
      if (loudest === null) continue
      this.emitAudio(grid.deviceId, loudest, atMs)
    }
  }

  /** A source camera's detection frame, with its boxes in SOURCE pixels. */
  onSourceDetections(frame: FrameResult): void {
    for (const grid of this.deps.gridsForSource(frame.deviceId)) {
      const cells = grid.cellsForSource(frame.deviceId)
      if (cells.length === 0) continue
      const detections: ObjectDetection[] = []
      for (const detection of frame.detections) {
        for (const bbox of mapDetectionToCanvas({
          bbox: detection.bbox,
          sourceFrame: { width: frame.width, height: frame.height },
          canvas: grid.canvas,
          cells,
        })) {
          // The box moves; everything else about the detection is unchanged,
          // because it is the same subject seen by the same camera. A mapped
          // box invalidates a `refinedBbox` and a `mask`, which are measured
          // against the SOURCE frame and have no meaning on the canvas, so
          // they are dropped rather than carried wrong.
          const { refinedBbox: _refined, mask: _mask, ...rest } = detection
          detections.push({ ...rest, bbox })
        }
      }
      if (detections.length === 0) continue
      this.emitDetections(grid, frame, detections)
    }
  }

  /** The grid's own motion answer, for `motion.getStatus`. */
  motionStatusFor(deviceId: number, nowMs: number): GridMotionState {
    return this.mirrors.get(deviceId)?.motionAt(nowMs) ?? { detected: false, lastDetectedAt: null }
  }

  /** Drop the mirror of a grid that no longer exists. */
  forget(deviceId: number): void {
    this.mirrors.delete(deviceId)
  }

  private mirrorFor(grid: GridActivityTarget): GridActivityMirror {
    let mirror = this.mirrors.get(grid.deviceId)
    if (mirror === undefined) {
      mirror = new GridActivityMirror()
      this.mirrors.set(grid.deviceId, mirror)
    }
    // A cell removed while its camera was moving would otherwise hold the grid
    // lit for a picture that source is no longer in.
    mirror.keepOnly(grid.sourceDeviceIds)
    return mirror
  }

  private source(deviceId: number) {
    return { type: 'device' as const, id: deviceId, addonId: this.deps.addonId, deviceId }
  }

  private emitMotion(deviceId: number, state: GridMotionState, atMs: number): void {
    const payload: MotionOnMotionChangedPayload = {
      deviceId,
      detected: state.detected,
      timestamp: atMs,
      // `onboard`, because that is what this IS from the system's point of
      // view: a push from the device, not a frame this node analysed. Claiming
      // `analyzer` would also route it into a handler that expects per-frame
      // regions this has none of.
      source: 'onboard',
    }
    this.deps.eventBus.emit(
      createEvent(EventCategory.MotionOnMotionChanged, this.source(deviceId), payload),
    )
    this.deps.logger.debug('camera grid: motion forwarded', {
      tags: { deviceId },
      meta: { detected: state.detected },
    })
  }

  private emitAudio(deviceId: number, dbfs: number, atMs: number): void {
    const frame: AudioResult = {
      kind: 'audio-window',
      // The window this LEVEL came out of belongs to a source camera, and two
      // sources' windows do not line up, so the grid names its own: the id is
      // the grid and the moment, and `startMs`/`endMs` are that moment. It is
      // not a window over the grid's audio — a grid takes no audio — it is the
      // envelope the level travels in, and saying otherwise would be inventing
      // an analysis nobody ran.
      windowId: `grid-${String(deviceId)}-${String(atMs)}`,
      deviceId,
      timestamp: atMs,
      startMs: atMs,
      endMs: atMs,
      level: { rms: 0, dbfs },
      detections: [],
    }
    const payload: PipelineAudioInferenceResultPayload = {
      deviceId,
      frame,
      // The node this grid is composed on. The field MEANS where the analyser
      // ran (D461), and for a forwarded level the honest answer is the node
      // that forwarded it.
      nodeId: 'hub',
    }
    this.deps.eventBus.emit(
      createEvent(EventCategory.PipelineAudioInferenceResult, this.source(deviceId), payload),
    )
  }

  private emitDetections(
    grid: GridActivityTarget,
    sourceFrame: FrameResult,
    detections: readonly ObjectDetection[],
  ): void {
    const frame: FrameResult = {
      kind: 'frame',
      // The source's frame id, prefixed. Two grids showing one camera would
      // otherwise announce the same frame id for two different pictures.
      frameId: `grid-${String(grid.deviceId)}-${sourceFrame.frameId}`,
      deviceId: grid.deviceId,
      timestamp: sourceFrame.timestamp,
      width: grid.canvas.width,
      height: grid.canvas.height,
      detections,
    }
    const payload: DetectionResultPayload = { frame, analysisResults: [] }
    this.deps.eventBus.emit(
      createEvent(EventCategory.DetectionResult, this.source(grid.deviceId), payload),
    )
  }
}
