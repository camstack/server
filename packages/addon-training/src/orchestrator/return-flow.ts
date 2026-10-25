/**
 * The return flow (D805, D806): a verified result → Model Studio → a canary
 * on chosen accelerators → rollback. Every step is an operator click; nothing here
 * runs on its own (operator decision 2026-10-08: never auto-register).
 *
 * Register hands the staged bundle to `custom-model-registry.importModelBundle`
 * over `ctx.peerBytes`, with the catalog rows completed here (labels, licence,
 * the base's D741 floors) and every format URL rewritten to
 * `camstack-local://`. A canary pins the root detector of each chosen
 * ACCELERATOR — a model is chosen by the accelerator that runs it (D927) — to
 * the variant that matches what that accelerator ran (INT8 where its pin was
 * INT8), and remembers EXACTLY what it replaced so a rollback restores it.
 */
import {
  type ModelCatalogEntry,
  type ModelFormatEntry,
  type TrainingAcceleratorRef,
  type TrainingCanary,
  type TrainingCatalogDraft,
  type TrainingJob,
  type TrainingResult,
  TrainingResultSchema,
} from '@camstack/types'
import { type BaseModelSpec, findBaseModel } from './base-models.js'
import { ARTIFACT_RETENTION_MS } from './job-engine.js'
import type { JobMutator } from './job-mutator.js'
import type { DetectorDevice, EnginePorts } from './ports.js'

export const DETECTOR_STEP_ID = 'object-detection'
const TRAINER_SOURCE_URL = 'https://huggingface.co/camstack/camstack-trainer'

function localFormat(
  id: string,
  fmt: TrainingCatalogDraft['formats']['onnx'],
): ModelFormatEntry | undefined {
  if (fmt === undefined) return undefined
  return {
    url: `camstack-local://${id}/${fmt.url}`,
    sizeMB: fmt.sizeMB,
    revision: fmt.revision,
    ...(fmt.isDirectory !== undefined ? { isDirectory: fmt.isDirectory } : {}),
    ...(fmt.files !== undefined ? { files: [...fmt.files] } : {}),
    ...(fmt.runtimes !== undefined ? { runtimes: [...fmt.runtimes] } : {}),
  }
}

/** A trainer draft completed into a registry row. */
export function catalogEntryFromDraft(input: {
  readonly draft: TrainingCatalogDraft
  readonly job: TrainingJob
  readonly result: TrainingResult
  readonly base: BaseModelSpec
  readonly int8: boolean
}): ModelCatalogEntry {
  const { draft, job, result, base } = input
  const supplied = input.int8 ? base.suppliedLabelFloorsInt8 : base.suppliedLabelFloors
  const formats: ModelCatalogEntry['formats'] = {}
  const onnx = localFormat(draft.id, draft.formats.onnx)
  const openvino = localFormat(draft.id, draft.formats.openvino)
  const coreml = localFormat(draft.id, draft.formats.coreml)
  if (onnx !== undefined) formats.onnx = onnx
  if (openvino !== undefined) formats.openvino = openvino
  if (coreml !== undefined) formats.coreml = coreml
  return {
    id: draft.id,
    name: draft.name,
    description: `${draft.description} Fine-tuned from ${base.modelId} by CamStack Training (job ${job.id}, ${String(job.frameCount)} frames from ${String(job.request.selection.collectionIds.length)} collection(s)).`,
    inputSize: { ...draft.inputSize },
    labels: [],
    preprocessMode: 'letterbox',
    defaultClassFloors: { ...draft.defaultClassFloors },
    ...(Object.keys(supplied).length > 0 ? { suppliedLabelFloors: { ...supplied } } : {}),
    license: {
      weights: 'AGPL-3.0-only',
      code: 'AGPL-3.0-only',
      upstream: { name: 'Ultralytics YOLOv9', url: 'https://github.com/ultralytics/ultralytics' },
      attribution: `© Ultralytics, AGPL-3.0 (YOLOv9 weights); ${result.licence}. Corresponding source: ${TRAINER_SOURCE_URL} at revision ${result.trainer.revision}.`,
      modifications: `fine-tuned on the operator's own frames (${String(job.frameCount)} frames; collections ${job.request.selection.collectionIds.join(', ')}) and exported by CamStack Training`,
    },
    formats,
  }
}

export interface CanaryWrite {
  readonly nodeId: string
  readonly deviceKey: string
  readonly modelId: string
}

function acceleratorKey(a: TrainingAcceleratorRef): string {
  return `${a.nodeId}|${a.deviceKey}`
}

/**
 * Which registered variant each chosen accelerator gets: INT8 where its pin
 * was INT8. An accelerator that does not run the root detector is REFUSED by
 * name — a canary that silently skipped one would report a pin it never made.
 */
export function planCanary(input: {
  readonly accelerators: readonly TrainingAcceleratorRef[]
  readonly devices: readonly DetectorDevice[]
  readonly baseId: string
  readonly int8Id: string | null
}): CanaryWrite[] {
  const byKey = new Map(input.devices.map((d) => [acceleratorKey(d), d]))
  return input.accelerators.map((a) => {
    const d = byKey.get(acceleratorKey(a))
    if (d === undefined)
      throw new Error(`${a.nodeId} · ${a.deviceKey} does not run the root detector`)
    return {
      nodeId: d.nodeId,
      deviceKey: d.deviceKey,
      modelId:
        input.int8Id !== null && d.pinnedModelId?.endsWith('-int8') === true
          ? input.int8Id
          : input.baseId,
    }
  })
}

export class ReturnFlow {
  constructor(
    private readonly ports: EnginePorts,
    private readonly mutator: JobMutator,
  ) {}

  async readResult(job: TrainingJob): Promise<TrainingResult | null> {
    if (job.artifacts === null) return null
    const text = await this.ports.artifacts.readResult(job.id)
    if (text === null) return null
    const parsed = TrainingResultSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  }

  async register(
    id: string,
    canaryAccelerators: readonly TrainingAcceleratorRef[],
  ): Promise<TrainingJob> {
    const job = await this.requireJob(id)
    if (job.state !== 'ready')
      throw new Error(`only a ready result can be registered (this one is ${job.state})`)
    const result = await this.readResult(job)
    const base = findBaseModel(job.request.baseModelId)
    if (
      result === null ||
      result.catalogDraft == null ||
      result.files === undefined ||
      job.artifacts === null ||
      base === null
    ) {
      throw new Error(
        'the staged result is missing or unreadable — fetch it again or discard the job',
      )
    }
    const entries = [
      catalogEntryFromDraft({ draft: result.catalogDraft.base, job, result, base, int8: false }),
    ]
    if (result.catalogDraft.int8 !== null) {
      entries.push(
        catalogEntryFromDraft({ draft: result.catalogDraft.int8, job, result, base, int8: true }),
      )
    }
    const ticket = await this.ports.artifacts.offerBundle(id)
    const answer = await this.ports.registry.importBundle({
      stepId: DETECTOR_STEP_ID,
      entries,
      bundle: { ticket, bytes: job.artifacts.bundleBytes, sha256: job.artifacts.bundleSha256 },
      files: result.files.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })),
      distribute: true,
    })
    if (answer.kind === 'refused')
      throw new Error(`Model Studio refused the bundle: ${answer.reason} — ${answer.detail}`)
    const now = this.ports.now()
    const registered = await this.mutator.update(id, (j) => ({
      ...j,
      state: 'registered',
      registeredModelIds: [...answer.modelIds],
      artifacts:
        j.artifacts === null ? null : { ...j.artifacts, expiresAt: now + ARTIFACT_RETENTION_MS },
    }))
    this.ports.logger.info('training result registered', {
      meta: { jobId: id, modelIds: [...answer.modelIds], distributed: answer.distributed.length },
    })
    if (canaryAccelerators.length > 0) return this.canary(id, canaryAccelerators)
    return registered ?? job
  }

  async canary(id: string, accelerators: readonly TrainingAcceleratorRef[]): Promise<TrainingJob> {
    const job = await this.requireJob(id)
    if (job.state !== 'registered' && job.state !== 'canary')
      throw new Error('register the result before a canary')
    const [baseId, int8Id] = job.registeredModelIds
    if (baseId === undefined) throw new Error('no registered model to canary')
    const already = new Set((job.canary?.accelerators ?? []).map(acceleratorKey))
    const fresh = accelerators.filter((a) => !already.has(acceleratorKey(a)))
    const writes = planCanary({
      accelerators: fresh,
      devices: await this.ports.pins.listDetectorDevices(),
      baseId,
      int8Id: int8Id ?? null,
    })
    const previous: Array<TrainingCanary['previous'][number]> = []
    for (const w of writes) {
      previous.push({
        nodeId: w.nodeId,
        deviceKey: w.deviceKey,
        modelId: await this.ports.pins.getPin(w.nodeId, w.deviceKey),
      })
      // The pin only: a threshold is bound to the model it was set for (D738),
      // so the previous model's floors stop applying by themselves.
      await this.ports.pins.setPin(w.nodeId, w.deviceKey, w.modelId)
    }
    const updated = await this.mutator.update(id, (j) => ({
      ...j,
      state: 'canary',
      canary: {
        accelerators: [
          ...(j.canary?.accelerators ?? []),
          ...writes.map((w) => ({ nodeId: w.nodeId, deviceKey: w.deviceKey })),
        ],
        since: j.canary?.since ?? this.ports.now(),
        previous: [...(j.canary?.previous ?? []), ...previous],
      },
    }))
    this.ports.logger.info('training canary pinned', {
      meta: { jobId: id, accelerators: writes.map((w) => acceleratorKey(w)) },
    })
    return updated ?? job
  }

  async rollback(id: string): Promise<TrainingJob> {
    const job = await this.requireJob(id)
    if (job.canary === null) return job
    for (const p of job.canary.previous) {
      await this.ports.pins.setPin(p.nodeId, p.deviceKey, p.modelId)
    }
    const updated = await this.mutator.update(id, (j) => ({
      ...j,
      state: 'registered',
      canary: null,
    }))
    this.ports.logger.info('training canary rolled back', {
      meta: { jobId: id, restored: job.canary.previous.length },
    })
    return updated ?? job
  }

  async discard(id: string): Promise<TrainingJob> {
    const job = await this.requireJob(id)
    if (job.state !== 'ready')
      throw new Error(`only an unregistered result can be discarded (this one is ${job.state})`)
    await this.ports.artifacts.remove(id)
    return (
      (await this.mutator.update(id, (j) => ({ ...j, state: 'discarded', artifacts: null }))) ?? job
    )
  }

  private async requireJob(id: string): Promise<TrainingJob> {
    const job = await this.ports.jobs.get(id)
    if (job === null) throw new Error(`training job "${id}" does not exist`)
    return job
  }
}
