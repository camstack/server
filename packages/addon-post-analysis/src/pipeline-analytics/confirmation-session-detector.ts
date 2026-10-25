/**
 * The detector the birth confirmation gate re-judges a birth WITH: the
 * session's own (D925).
 *
 * A birth is a claim made by one detector — the root model of the session that
 * produced the frame, on the inference-device pool it ran on. The gate asks
 * whether that claim holds on better pixels, so it must ask the SAME detector:
 * a different model has a different score scale and a different floor, and its
 * "no" says nothing about the claim. It used to ask the node's global default
 * (`getGlobalSteps`), which on a Coral node meant a CPU `yolov9t` re-judging an
 * `edgetpu` model's births.
 *
 * The identity rides the frame result (`rootStepId` / `rootModelId` /
 * `rootDeviceKey`, stamped by the executor with what it RAN), and the node is
 * the frame handle's — the same node the crop is cut on, so no new bytes cross
 * anywhere.
 *
 * When that detector cannot answer — no identity on the frame (an onboard
 * detector), the device in backoff or failed, or the executor running anything
 * other than exactly that model on exactly that pool — the answer is
 * `session-device-unavailable`: NO measurement. The gate defers the birth and
 * admits it once the deferral is exhausted. Another model is never asked.
 *
 * PURE apart from the injected `run`, so the matrix is testable without an
 * executor.
 */
import { errMsg, type FrameResult } from '@camstack/types'
import type { RedetectAnswer } from './confirmation-gate.js'
import {
  type ConfirmationRedetectResult,
  toConfirmationDetections,
} from './confirmation-redetect-result.js'

/** The session's detector: root step + model, the device pool it ran on, and its node. */
export interface SessionDetector {
  readonly stepId: string
  readonly modelId: string
  readonly deviceKey: string
  readonly nodeId: string
}

/** The single detection-only step the re-detect runs — no crop/classifier subtree. */
export interface SessionRedetectStep {
  readonly addonId: string
  readonly modelId: string
  readonly enabled: true
}

/** The `pipelineExecutor.runPipeline` input of one pinned re-detect. */
export interface SessionRedetectRequest {
  readonly steps: readonly [SessionRedetectStep]
  readonly image: Uint8Array<ArrayBuffer>
  readonly deviceId: number
  readonly plane: 'frame'
  readonly deviceKey: string
}

/** Runs one re-detect on `nodeId` — the host wires `pipelineExecutor.runPipeline`. */
export type SessionRedetectRun = (
  request: SessionRedetectRequest,
  nodeId: string,
) => Promise<ConfirmationRedetectResult | null>

/** What the gate gets, plus the failure text the host logs. */
export interface SessionRedetectOutcome {
  readonly answer: RedetectAnswer
  readonly error?: string
}

/** The frame fields that name the session detector. */
export type SessionDetectorFrame = Pick<FrameResult, 'rootStepId' | 'rootModelId' | 'rootDeviceKey'>

/** The session detector named by a frame, or `null` when the frame names none in full. */
export function sessionDetectorOf(
  frame: SessionDetectorFrame,
  nodeId: string,
): SessionDetector | null {
  const { rootStepId, rootModelId, rootDeviceKey } = frame
  if (!rootStepId || !rootModelId || !rootDeviceKey || !nodeId) return null
  return { stepId: rootStepId, modelId: rootModelId, deviceKey: rootDeviceKey, nodeId }
}

/**
 * The executor's refusal of a device it will not dispatch to: the liveness
 * refusal (`InferenceDeviceUnusableError`), a device key whose backend this
 * node does not know, or a pinned pool that cannot serve. Read from the
 * message because the error crosses a process boundary without its class.
 */
const DEVICE_REFUSAL =
  /inference device ".+" is (failed|backoff)|unknown backend|device-not-servable|model-not-servable/

/** Re-detect a crop with the session detector, or say why it could not. */
export async function redetectWithSessionDetector(
  detector: SessionDetector | null,
  cropJpeg: Buffer,
  deviceId: number,
  run: SessionRedetectRun,
): Promise<SessionRedetectOutcome> {
  if (detector === null) {
    return unavailable('the frame names no session detector')
  }
  let result: ConfirmationRedetectResult | null
  try {
    result = await run(
      {
        steps: [{ addonId: detector.stepId, modelId: detector.modelId, enabled: true }],
        image: new Uint8Array(cropJpeg),
        deviceId,
        plane: 'frame',
        deviceKey: detector.deviceKey,
      },
      detector.nodeId,
    )
  } catch (err) {
    const message = errMsg(err)
    if (DEVICE_REFUSAL.test(message)) return unavailable(message)
    return { answer: null, error: message }
  }
  // What RAN is the executor's stamp. Anything but exactly the session's model
  // on exactly its pool is another detector's opinion, and is discarded.
  if (
    result !== null &&
    (result.rootModelId !== detector.modelId || result.rootDeviceKey !== detector.deviceKey)
  ) {
    return unavailable(
      `ran ${result.rootModelId ?? 'an unnamed model'} on ${result.rootDeviceKey ?? 'an unnamed pool'}, not ${detector.modelId} on ${detector.deviceKey}`,
    )
  }
  return { answer: toConfirmationDetections(result) }
}

function unavailable(detail: string): SessionRedetectOutcome {
  return { answer: { unavailable: 'session-device-unavailable', detail } }
}
