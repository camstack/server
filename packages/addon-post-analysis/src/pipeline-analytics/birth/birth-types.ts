/**
 * The birth path's named types: what each piece of `birth/` reads from the
 * addon, and what the frame path hands it (Plan B, extraction 5).
 */
import type {
  AddonContext,
  DetectionSource,
  FrameHandle,
  FrameResult,
  IScopedLogger,
} from '@camstack/types'
import type { BirthConfirmationRun, ConfirmationOutcome } from '../confirmation-gate.js'
import type { ConfirmationGateSettings } from '../confirmation-gate-settings.js'
import type { SessionDetector } from '../confirmation-session-detector.js'
import type { FrameState } from '../frame/frame-state.js'
import type { CaptureCropFn } from '../pipeline/capture-crop.js'
import type { DebugCropCaptureInput } from '../pipeline/debug-crop-capture.js'
import type { DisplayCropFn } from '../pipeline/display-crop.js'
import type {
  FrameProcessor,
  FrameProcessorResult,
  TrackedDetectionOut,
} from '../pipeline/frame-processor.js'
import type { PhantomCellRegistry } from '../pipeline/stationary/phantom-cells.js'
import type { TrackResidentState } from '../pipeline/track-resident-state.js'
import type { CaptureScheduler } from '../runtime/capture-scheduler.js'
import type { EventMediaDispatcher } from '../services/event-media-dispatcher.js'
import type { BirthDecisionLedgerStore } from '../store/birth-decision-ledger-store.js'
import type { MediaStore } from '../store/media-store.js'
import type { TrackStore } from '../store/track-store.js'
import type { BirthGate } from './birth-gate.js'
import type { BirthLedger } from './birth-ledger.js'

/** What the gate reads from the addon. */
export interface BirthGateDeps {
  readonly ctx: () => AddonContext
  readonly frameState: FrameState
  readonly captureScheduler: () => CaptureScheduler
  readonly captureCrop: () => CaptureCropFn | null
  readonly captureDisplayCropFn: () => DisplayCropFn | null
  readonly phantomCells: () => PhantomCellRegistry | null
  readonly resolveDeviceConfirmationGateSettings: (
    deviceId: number,
  ) => Promise<ConfirmationGateSettings>
  readonly procKey: (deviceId: number, source: DetectionSource) => string
}

/** What the ledger record reads from the addon. */
export interface BirthLedgerDeps {
  readonly ctx: () => AddonContext
  readonly frameState: FrameState
  readonly birthDecisionLedger: () => BirthDecisionLedgerStore | null
}

/** A fresh id offered to the gate this frame, with its detection. */
export interface BornCandidate {
  readonly id: string
  readonly t: TrackedDetectionOut
}

/** What the frame path hands the candidate collection. */
export interface BirthRoundInput {
  readonly deviceId: number
  readonly source: DetectionSource
  readonly key: string
  readonly log: IScopedLogger
  readonly frame: FrameResult
  readonly frameHandle: FrameHandle | undefined
  readonly result: FrameProcessorResult
  readonly prevIds: ReadonlySet<string>
  readonly currentTrackIds: ReadonlySet<string>
  readonly positionsCountById: ReadonlyMap<string, number>
}

/** The candidates and the gate's run, for the per-candidate verdicts. */
export interface BirthRound {
  readonly bornCandidates: readonly BornCandidate[]
  readonly exhaustedIds: ReadonlySet<string>
  readonly withBirthEvidence: ReadonlySet<string>
  readonly sessionDetector: SessionDetector | null
  readonly run: BirthConfirmationRun
}

/** What the candidate collection reads from the addon. */
export interface BirthCandidatesDeps {
  readonly ctx: () => AddonContext
  readonly frameState: FrameState
  readonly residents: TrackResidentState
  readonly eventMediaDispatcher: () => EventMediaDispatcher | null
  readonly birthGate: () => BirthGate
  readonly resolveDeviceConfirmationGateSettings: (
    deviceId: number,
  ) => Promise<ConfirmationGateSettings>
}

/** One candidate and everything its verdict is read against. */
export interface BirthVerdictInput extends BornCandidate {
  readonly deviceId: number
  readonly source: DetectionSource
  readonly key: string
  readonly log: IScopedLogger
  readonly frameHandle: FrameHandle | undefined
  readonly result: FrameProcessorResult
  readonly processor: FrameProcessor
  readonly outcome: ConfirmationOutcome
  readonly run: BirthConfirmationRun
  readonly exhaustedIds: ReadonlySet<string>
  readonly withBirthEvidence: ReadonlySet<string>
  readonly sessionDetector: SessionDetector | null
  readonly gateNowMs: number
}

/** What the verdict reads from the addon. */
export interface BirthVerdictDeps {
  readonly frameState: FrameState
  readonly trackStore: () => TrackStore | null
  readonly mediaStore: () => MediaStore | null
  readonly birthLedger: () => BirthLedger
  readonly offerDebugCrop: (input: DebugCropCaptureInput) => void
  readonly clearLiveTrackState: (deviceId: number, trackId: string) => void
}
