/**
 * Frame admission — what runs BEFORE `processFrame`: the departure
 * confirmation look (a one-shot occupancy burst asked of the runner) and the
 * inference-result handler (runner attribution, delivery-lag fold, then the
 * hand-off to `processFrame`). Moved out of `pipeline-analytics/index.ts`
 * verbatim (Plan B, extraction 6): only the visibility of the two entry points
 * changed. Every dependency is read through the deps object.
 */
import {
  type AddonContext,
  type DetailStepAnnounce,
  type DetectionSource,
  type FrameHandle,
  type FrameResult,
  type InferenceOccasion,
  nodePin,
  type PipelineInferenceResultPayload,
} from '@camstack/types'
import { type FrameLagObserver, isAlarmingLagReport, lagVerdict } from '../frame-lag-observer.js'
import type { FrameState } from './frame-state.js'

/** The ask the stationary registry makes of {@link FrameAdmission.requestConfirmationLook}. */
export interface ConfirmationLookAsk {
  deviceId: number
  entryId: string
  afterMs: number
  frames: number
}

/** `processFrame`'s arguments, in order — the one thing admission hands on. */
export type ProcessFrameFn = (
  deviceId: number,
  frame: FrameResult,
  source: DetectionSource,
  rawFrameHandle?: FrameHandle,
  detailSteps?: readonly DetailStepAnnounce[],
  occasion?: InferenceOccasion,
  producerNodeId?: string,
) => Promise<void>

/** What frame admission reads from the addon. */
export interface FrameAdmissionDeps {
  /** The addon context — throws outside the initialized window. */
  readonly ctx: () => AddonContext
  readonly frameState: FrameState
  readonly frameLag: FrameLagObserver
  readonly shuttingDown: () => boolean
  readonly processFrame: ProcessFrameFn
}

export class FrameAdmission {
  constructor(private readonly deps: FrameAdmissionDeps) {}

  private get ctx(): AddonContext {
    return this.deps.ctx()
  }

  private get frameState(): FrameState {
    return this.deps.frameState
  }

  /**
   * Ask the runner to look at a camera once more, shortly after a departure was
   * armed — see `StationaryRegistryDeps.requestConfirmationLook` for why, and
   * the cap's `requestOccupancyBurst` for the two numbers that shape the ask.
   *
   * Pinned to the node whose frames we have been analysing: an unpinned call
   * would be served by whichever runner answers, and a runner that does not
   * hold the camera refuses it — correctly, but uselessly.
   *
   * Fire-and-forget by construction. This is an OPTIMISATION of a path that
   * already terminates on its own (the entry ages out), so a failure here must
   * cost nothing but a log line.
   */
  requestConfirmationLook(ask: ConfirmationLookAsk): void {
    const key = `${String(ask.deviceId)}:${ask.entryId}`
    // An entry that re-arms while a look is pending keeps the first timer: the
    // second would land inside the same window and be refused as already
    // bursting, and stacking them is how a quiet camera acquires a queue.
    if (this.frameState.pendingConfirmationLooks.has(key)) return
    const nodeId = this.frameState.lastRunnerNodeByDevice.get(ask.deviceId)
    const runnerApi = this.ctx.api.pipelineRunner
    if (nodeId === undefined || !runnerApi?.requestOccupancyBurst) return
    const timer = setTimeout(() => {
      this.frameState.pendingConfirmationLooks.delete(key)
      if (this.deps.shuttingDown()) return
      void runnerApi.requestOccupancyBurst
        .mutate(
          {
            deviceId: ask.deviceId,
            frames: ask.frames,
            reason: 'stationary-departure-confirm',
          },
          nodePin(nodeId),
        )
        .then((answer) => {
          // A refusal is NAMED by the runner, so it is logged as one. Three of
          // the four are protections working (asleep, mid-session, already
          // bursting) and one is a routing fault (not attached here) — folding
          // them into one line would hide the only one that is a bug.
          if (!answer.started) {
            this.ctx.logger.debug('departure confirmation look refused', {
              tags: { deviceId: ask.deviceId },
              meta: {
                entryId: ask.entryId,
                nodeId,
                refusedBecause: answer.refusedBecause,
              },
            })
          }
        })
        .catch((err: unknown) => {
          this.ctx.logger.debug('departure confirmation look failed', {
            tags: { deviceId: ask.deviceId },
            meta: { entryId: ask.entryId, nodeId, error: String(err) },
          })
        })
    }, ask.afterMs)
    timer.unref?.()
    this.frameState.pendingConfirmationLooks.set(key, timer)
  }

  async handleInferenceResult(data: PipelineInferenceResultPayload): Promise<void> {
    if (this.deps.shuttingDown()) return
    const { deviceId, frame } = data
    // WHICH runner is analysing this camera. Taken from the frames themselves
    // rather than from a placement read: the payload already names its producer,
    // and a camera this node never hears from is one it must not pin a call at.
    if (data.nodeId.length > 0) this.frameState.lastRunnerNodeByDevice.set(deviceId, data.nodeId)
    // Delivery lag, before a single line of analysis runs. This process — ONE
    // process for every camera — goes silent for 10+ s about three times an
    // hour (measured 2026-09-09), and a silence followed by a burst-drain is
    // produced identically by two different mechanisms:
    //
    //   busLagMs ~ 13 000  → STARVED: the runner or hub-main delivered late.
    //                        Analytics is innocent; the fix is upstream.
    //   busLagMs ~ 0 while positions still land 13 s late
    //                      → WAITING: the stall is inside `processFrame`, and
    //                        `RawGlobalStoreMirror.resolve()` — the one
    //                        cross-camera serializer on this path — is the
    //                        first place to look.
    //
    // Read the DELTA against a camera's own baseline, never the absolute:
    // `emittedAt` is stamped on the runner's node and this clock is ours.
    // `frame-lag-observer.ts` carries the full reasoning, the throttle (one
    // aggregate line per device per 30 s, worst-case preserved) and why an
    // absent stamp is `unknown` and never 0 (D8).
    const lag = this.deps.frameLag.observe(deviceId, Date.now(), data.emittedAt, data.capturedAt)
    if (lag !== null) {
      const verdict = lagVerdict(lag)
      const line = isAlarmingLagReport(lag)
        ? this.ctx.logger.warn.bind(this.ctx.logger)
        : this.ctx.logger.info.bind(this.ctx.logger)
      line('pipeline-analytics frame lag', {
        tags: { deviceId },
        meta: {
          verdict,
          frames: lag.frames,
          windowMs: lag.windowMs,
          busLagMaxMs: lag.busLagMaxMs,
          busLagMinMs: lag.busLagMinMs,
          busLagUnknownFrames: lag.busLagUnknownFrames,
          captureLagMaxMs: lag.captureLagMaxMs,
          captureLagUnknownFrames: lag.captureLagUnknownFrames,
        },
      })
    }
    // WHICH root detector produced these boxes. Absent is `'pipeline'` — a
    // runner older than the field emits nothing else. The camera-native plane
    // arrives HERE now, on this payload, instead of through a door of its own:
    // that is what gives an onboard-born track the `detailSteps` announce and
    // the frame handle it needs for a face, a plate or an embedding.
    await this.deps.processFrame(
      deviceId,
      frame,
      data.source ?? 'pipeline',
      data.frameHandle,
      data.detailSteps,
      // Absent is `'session'` — a runner older than the field only ever told us
      // about session frames, which is exactly why the ledger's burst tallies
      // read zero on the whole fleet.
      data.occasion ?? 'session',
      // WHICH node ran it — the runner's own id on the payload. With the
      // frame's `rootDeviceKey` / `rootModelId` it is where a track opened and
      // closed (`trackPlacementOf`).
      data.nodeId,
    )
  }
}
