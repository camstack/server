/**
 * What the training engine needs from the rest of the system, as plain
 * functions. Production wires them to `ctx.api` (the provider cap, pipeline-
 * analytics, Model Studio, the pipeline orchestrator) and to the hub's disk;
 * tests wire them to the fake provider and memory. The engine never touches
 * `ctx` itself — that is what keeps the state machine testable end to end.
 */
import type {
  ImportModelBundleInput,
  ImportModelBundleResult,
  IScopedLogger,
  ITrainingCloudProvider,
  PeerBytesTicket,
  RetrainDatasetStats,
  RetrainExportFilter,
  RetrainExportLayout,
  RetrainTrainingCorpusResolveResult,
  TrainingCorpusSelection,
} from '@camstack/types'
import type { JobStore } from './stores.js'

/** One provider addon, as the engine calls it (the cap's provider shape). */
export type ProviderPort = ITrainingCloudProvider

export interface DatasetPort {
  /** `pipelineAnalytics.offerRetrainArchive`. */
  readonly offerArchive: (input: {
    readonly filter: RetrainExportFilter
    readonly layout: RetrainExportLayout
  }) => Promise<{ readonly ticket: PeerBytesTicket; readonly frames: number }>
}

/** Live corpus selection → frame ids + stats (`pipelineAnalytics.resolveRetrainTrainingCorpus`). */
export interface CorpusPort {
  readonly resolve: (
    selection: TrainingCorpusSelection,
  ) => Promise<RetrainTrainingCorpusResolveResult>
}

/** Convenience shape when a resolve succeeded (tests / accepted plans). */
export interface ResolvedCorpusSnapshot {
  readonly frameIds: readonly string[]
  readonly stats: RetrainDatasetStats
  readonly annotationHash: string
  readonly layout: RetrainExportLayout
}

/** The hub-side staging of a job's artefacts. */
export interface ArtifactPort {
  /** Take the bundle behind `ticket` into staging; bounded, hashed on the way. */
  readonly receiveBundle: (
    jobId: string,
    ticket: PeerBytesTicket,
    maxBytes: number,
  ) => Promise<{ readonly bytes: number; readonly sha256: string }>
  readonly writeResult: (jobId: string, text: string) => Promise<void>
  readonly readResult: (jobId: string) => Promise<string | null>
  /** Offer the staged bundle to Model Studio (same host). */
  readonly offerBundle: (jobId: string) => Promise<PeerBytesTicket>
  readonly remove: (jobId: string) => Promise<void>
}

export interface RegistryPort {
  readonly importBundle: (
    input: Omit<ImportModelBundleInput, 'addonId'>,
  ) => Promise<ImportModelBundleResult>
}

/** One accelerator that runs the root detector, and the base model pinned on it. */
export interface DetectorDevice {
  readonly nodeId: string
  readonly deviceKey: string
  readonly pinnedModelId: string | null
}

/**
 * The root-detector pin of an ACCELERATOR — a model is chosen by the
 * accelerator that runs it (D927); no camera carries one.
 */
export interface PinPort {
  readonly listDetectorDevices: () => Promise<readonly DetectorDevice[]>
  /** The accelerator's stored root-detector pin; null = it runs its default. */
  readonly getPin: (nodeId: string, deviceKey: string) => Promise<string | null>
  /** Pin `modelId` on the accelerator, or drop its pin (`null`). Every other setting is kept. */
  readonly setPin: (nodeId: string, deviceKey: string, modelId: string | null) => Promise<void>
}

export interface EnginePorts {
  readonly provider: ProviderPort
  readonly datasets: DatasetPort
  readonly corpus: CorpusPort
  readonly jobs: JobStore
  readonly artifacts: ArtifactPort
  readonly registry: RegistryPort
  readonly pins: PinPort
  readonly now: () => number
  readonly newId: () => string
  readonly logger: IScopedLogger
}
