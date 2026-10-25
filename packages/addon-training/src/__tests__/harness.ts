/**
 * The engine under test, wired to the fake provider and memory everywhere
 * else. Every port is the real interface; only the storage behind it is RAM.
 */
import { createHash } from 'node:crypto'
import type {
  ImportModelBundleInput,
  ImportModelBundleResult,
  IScopedLogger,
  RetrainDatasetStats,
  RetrainTrainingCorpusResolveResult,
  TrainingCorpusSelection,
  TrainingJob,
  TrainingJobSpec,
  TrainingResult,
} from '@camstack/types'
import { TRAINING_RESULT_SCHEMA } from '@camstack/types'
import { TrainingEngine } from '../orchestrator/job-engine.js'
import type {
  ArtifactPort,
  CorpusPort,
  DetectorDevice,
  EnginePorts,
  PinPort,
} from '../orchestrator/ports.js'
import type { JobStore } from '../orchestrator/stores.js'
import { FakeTrainingProvider } from '../providers/fake/fake-provider.js'
import { MemoryPeerBytes } from '../providers/fake/memory-peer-bytes.js'

export const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

export function silentLogger(): IScopedLogger {
  const noop = (): void => undefined
  const logger: IScopedLogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

export class MemoryJobStore implements JobStore {
  readonly rows = new Map<string, TrainingJob>()
  readonly put = async (job: TrainingJob): Promise<void> => {
    this.rows.set(job.id, job)
  }
  readonly get = async (id: string): Promise<TrainingJob | null> => this.rows.get(id) ?? null
  readonly list = async (): Promise<readonly TrainingJob[]> =>
    [...this.rows.values()].toSorted((a, b) => b.createdAt - a.createdAt)
  readonly findByIdempotencyKey = async (key: string): Promise<TrainingJob | null> =>
    [...this.rows.values()].find((j) => j.idempotencyKey === key) ?? null
}

export function corpusStats(overrides: Partial<RetrainDatasetStats> = {}): RetrainDatasetStats {
  const cameras = [101, 102, 108, 620, 621, 622]
  return {
    frames: 300,
    completeFrames: 300,
    completeness: 1,
    subjects: 900,
    modelErrors: 0,
    hardNegatives: 40,
    cells: cameras.flatMap((deviceId) =>
      (['person', 'vehicle', 'animal'] as const).map((macroClass) => ({
        macroClass,
        deviceId,
        lighting: 'day' as const,
        subjects: 50,
        frames: 50,
      })),
    ),
    cameras: cameras.map((deviceId, i) => ({ deviceId, frames: 50, completeFrames: 60 - i })),
    ...overrides,
  }
}

/** In-memory corpus resolve — known collection ids map to a canned snapshot. */
export class MemoryCorpusPort implements CorpusPort {
  readonly known = new Set<string>(['col-1'])
  /** Per-collection resolve override; absent → default rich corpus. */
  readonly byCollection = new Map<string, RetrainTrainingCorpusResolveResult>()

  readonly resolve = async (
    selection: TrainingCorpusSelection,
  ): Promise<RetrainTrainingCorpusResolveResult> => {
    for (const id of selection.collectionIds) {
      if (!this.known.has(id)) {
        return {
          kind: 'refused',
          reason: 'unknown-collection',
          detail: `collection "${id}" does not exist`,
        }
      }
      const override = this.byCollection.get(id)
      if (override !== undefined) return override
    }
    const frameIds = Array.from({ length: 300 }, (_, i) => `f${String(i)}`)
    return {
      kind: 'resolved',
      frameIds,
      stats: corpusStats(),
      annotationHash: 'hash-1',
      layout: 'frames',
    }
  }
}

export class MemoryArtifacts implements ArtifactPort {
  readonly bundles = new Map<string, Buffer>()
  readonly results = new Map<string, string>()
  constructor(private readonly peer: MemoryPeerBytes) {}
  readonly receiveBundle: ArtifactPort['receiveBundle'] = async (jobId, ticket, maxBytes) => {
    const taken = await this.peer.take(ticket)
    if (taken.bytes.length > maxBytes) throw new Error('bundle over its declared size')
    this.bundles.set(jobId, taken.bytes)
    return { bytes: taken.bytes.length, sha256: taken.sha256 }
  }
  readonly writeResult: ArtifactPort['writeResult'] = async (jobId, text) => {
    this.results.set(jobId, text)
  }
  readonly readResult: ArtifactPort['readResult'] = async (jobId) => this.results.get(jobId) ?? null
  readonly offerBundle: ArtifactPort['offerBundle'] = async (jobId) => {
    const bundle = this.bundles.get(jobId)
    if (bundle === undefined) throw new Error('no staged bundle')
    return this.peer.offer(bundle)
  }
  readonly remove: ArtifactPort['remove'] = async (jobId) => {
    this.bundles.delete(jobId)
    this.results.delete(jobId)
  }
}

export class MemoryPins implements PinPort {
  readonly devices: DetectorDevice[] = [
    { nodeId: 'hub', deviceKey: 'npu', pinnedModelId: 'yolov9m-640-int8' },
    { nodeId: 'mac', deviceKey: 'ane', pinnedModelId: 'yolov9m-640' },
  ]
  /** `node|deviceKey` → the accelerator's stored root-detector pin. */
  readonly pins = new Map<string, string>()
  readonly listDetectorDevices = async () => this.devices
  readonly getPin = async (nodeId: string, deviceKey: string) =>
    this.pins.get(`${nodeId}|${deviceKey}`) ?? null
  readonly setPin = async (nodeId: string, deviceKey: string, modelId: string | null) => {
    const key = `${nodeId}|${deviceKey}`
    if (modelId === null) this.pins.delete(key)
    else this.pins.set(key, modelId)
  }
}

export interface Harness {
  readonly engine: TrainingEngine
  readonly provider: FakeTrainingProvider
  readonly peer: MemoryPeerBytes
  readonly jobs: MemoryJobStore
  readonly corpus: MemoryCorpusPort
  readonly artifacts: MemoryArtifacts
  readonly pins: MemoryPins
  readonly imports: Array<Omit<ImportModelBundleInput, 'addonId'>>
  readonly clock: { now: number }
  importAnswer: (input: Omit<ImportModelBundleInput, 'addonId'>) => ImportModelBundleResult
  readonly ports: EnginePorts
}

export const TRAINER = { repo: 'camstack/camstack-trainer', revision: 'abcdef1' }

export async function harness(): Promise<Harness> {
  const clock = { now: Date.UTC(2026, 9, 8, 12) }
  const peer = new MemoryPeerBytes()
  const provider = new FakeTrainingProvider({ peer, now: () => clock.now })
  const jobs = new MemoryJobStore()
  const corpus = new MemoryCorpusPort()
  const artifacts = new MemoryArtifacts(peer)
  const pins = new MemoryPins()
  const imports: Array<Omit<ImportModelBundleInput, 'addonId'>> = []
  let n = 0
  const h: Omit<Harness, 'engine' | 'ports'> & { importAnswer: Harness['importAnswer'] } = {
    provider,
    peer,
    jobs,
    corpus,
    artifacts,
    pins,
    imports,
    clock,
    importAnswer: (input) => ({
      kind: 'imported',
      modelIds: input.entries.map((e) => e.id),
      distributed: [],
    }),
  }
  const ports: EnginePorts = {
    provider,
    datasets: {
      offerArchive: async (input) => ({
        ticket: peer.offer(Buffer.from(`archive:${input.filter.frameIds?.length ?? 0}`)),
        frames: input.filter.frameIds?.length ?? 0,
      }),
    },
    corpus,
    jobs,
    artifacts,
    registry: {
      importBundle: async (input) => {
        imports.push(input)
        // Take the bundle like Model Studio does, so a ticket left untaken shows.
        await peer.take(input.bundle.ticket)
        return h.importAnswer(input)
      },
    },
    pins,
    now: () => clock.now,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    logger: silentLogger(),
  }
  const engine = new TrainingEngine(ports, TRAINER)
  return Object.assign(h, { engine, ports }) as Harness
}

/** A succeeded `result.json` and its bundle, consistent with each other. */
export function fakeResult(specJson: string): {
  resultText: string
  bundle: Buffer
  result: TrainingResult
} {
  const spec = JSON.parse(specJson) as TrainingJobSpec
  const id = spec.catalog.id
  const onnx = Buffer.from(`onnx:${id}`)
  const int8Bin = Buffer.from(`int8:${id}`)
  const int8Xml = Buffer.from('<xml/>')
  const bundle = Buffer.from(`tar-of:${id}`)
  const result: TrainingResult = {
    schema: TRAINING_RESULT_SCHEMA,
    jobKey: spec.jobKey,
    status: 'succeeded',
    error: null,
    trainer: { version: '0.1.0', revision: 'abcdef1' },
    toolchain: { ultralytics: '8.4.98' },
    dataset: {
      versionId: spec.dataset.versionId,
      annotationHash: spec.dataset.annotationHash,
      sha256: spec.dataset.sha256,
      frames: { train: 200, val: 40, holdout: 60 },
      holdoutCameras: spec.split.holdoutCameras,
      replayImages: spec.replay.count,
    },
    training: { epochsRun: 40, bestEpoch: 31, bestMap50: 0.71, bestMap50_95: 0.48, seconds: 3600 },
    evaluation: {
      holdoutFrames: 60,
      baseline: { frames: 60, classes: {} },
      candidate: { frames: 60, classes: {} },
      candidateInt8: { frames: 60, classes: {} },
      recallDeltaByCamera: null,
      map50: { candidate: 0.71, candidateInt8: 0.7 },
    },
    floors: {
      baseline: spec.baseline.floors,
      candidate: { person: 0.5 },
      candidateInt8: { person: 0.5 },
      notes: [],
    },
    int8: { kept: true, map50Fp16: 0.71, map50Int8: 0.7, reason: null },
    exportsDropped: [],
    files: [
      {
        path: `${id}.onnx`,
        bytes: onnx.length,
        sha256: sha(onnx),
        format: 'onnx',
        variant: 'base',
      },
      {
        path: `${id}-int8.xml`,
        bytes: int8Xml.length,
        sha256: sha(int8Xml),
        format: 'openvino',
        variant: 'int8',
      },
      {
        path: `${id}-int8.bin`,
        bytes: int8Bin.length,
        sha256: sha(int8Bin),
        format: 'openvino',
        variant: 'int8',
      },
    ],
    bundle: { path: 'bundle.tar', bytes: bundle.length, sha256: sha(bundle) },
    catalogDraft: {
      base: {
        id,
        name: spec.catalog.name,
        description: 'fine-tuned',
        labels: [],
        inputSize: { width: 640, height: 640 },
        preprocessMode: 'letterbox',
        defaultClassFloors: { person: 0.5 },
        formats: { onnx: { url: `${id}.onnx`, sizeMB: 0.1, revision: sha(onnx) } },
      },
      int8: {
        id: `${id}-int8`,
        name: `${spec.catalog.name} (INT8)`,
        description: 'fine-tuned int8',
        labels: [],
        inputSize: { width: 640, height: 640 },
        preprocessMode: 'letterbox',
        defaultClassFloors: { person: 0.5 },
        formats: {
          openvino: {
            url: `${id}-int8.xml`,
            files: [`${id}-int8.bin`],
            runtimes: ['python'],
            sizeMB: 0.1,
            revision: sha(int8Bin),
          },
        },
      },
    },
    licence: 'AGPL-3.0 (Ultralytics derivative)',
  }
  return { resultText: JSON.stringify(result), bundle, result }
}
