/**
 * The `pipeline` measurement's step tree (D791), built on the measuring node
 * from its own catalog (`pipelineExecutor.getSchema`). Pure.
 *
 * The root is `object-detection`, pinned to the model being measured. Under
 * it: every cropper whose input the root produces (with its recognizers),
 * every classifier that takes the root's classes directly, and every refiner
 * — each enabled only when the operator chose it. A cropper is enabled with
 * any of its recognizers (they cannot run without its crop). Model ids of
 * detail steps are left to the node's format defaults.
 */
import type { PipelineStepInputOutput } from '../../capabilities/pipeline-executor.cap.js'
import type { PipelineSchema } from '../../types/pipeline-schema.js'

type SchemaAddon = PipelineSchema['slots'][number]['addons'][number]

export const BENCH_ROOT_STEP_ID = 'object-detection'

export interface BenchDetailStep {
  readonly id: string
  readonly name: string
  readonly slot: string
}

function slotAddons(schema: PipelineSchema, slot: string): readonly SchemaAddon[] {
  return schema.slots.find((s) => s.id === slot)?.addons ?? []
}

const feeds = (from: SchemaAddon, to: SchemaAddon): boolean =>
  to.inputClasses.some((c) => from.outputClasses.includes(c))

interface Layout {
  readonly root: SchemaAddon
  readonly croppers: readonly {
    readonly cropper: SchemaAddon
    readonly recognizers: readonly SchemaAddon[]
  }[]
  readonly classifiers: readonly SchemaAddon[]
  readonly refiners: readonly SchemaAddon[]
}

function layout(schema: PipelineSchema): Layout | null {
  const root = slotAddons(schema, 'detector').find((a) => a.id === BENCH_ROOT_STEP_ID)
  if (root === undefined) return null
  const classifiers = slotAddons(schema, 'classifier')
  const croppers = slotAddons(schema, 'cropper')
    .filter((c) => feeds(root, c))
    .map((cropper) => ({ cropper, recognizers: classifiers.filter((k) => feeds(cropper, k)) }))
  const underCropper = new Set(croppers.flatMap((c) => c.recognizers.map((r) => r.id)))
  return {
    root,
    croppers,
    classifiers: classifiers.filter((k) => feeds(root, k) && !underCropper.has(k.id)),
    refiners: slotAddons(schema, 'refiner'),
  }
}

/** The detail steps the operator can choose, in tree order. */
export function listBenchDetailSteps(schema: PipelineSchema): readonly BenchDetailStep[] {
  const l = layout(schema)
  if (l === null) return []
  const of = (a: SchemaAddon): BenchDetailStep => ({ id: a.id, name: a.name, slot: a.slot })
  return [
    ...l.croppers.flatMap((c) => [of(c.cropper), ...c.recognizers.map(of)]),
    ...l.classifiers.map(of),
    ...l.refiners.map(of),
  ]
}

/** Build the tree. Throws when the node's catalog has no object-detection root. */
export function buildBenchStepTree(
  schema: PipelineSchema,
  rootModelId: string,
  enabledStepIds: readonly string[],
): PipelineStepInputOutput[] {
  const l = layout(schema)
  if (l === null) throw new Error(`the node's catalog has no ${BENCH_ROOT_STEP_ID} step`)
  const on = new Set(enabledStepIds)
  const step = (a: SchemaAddon, enabled: boolean): PipelineStepInputOutput => ({
    addonId: a.id,
    enabled,
  })
  return [
    {
      addonId: l.root.id,
      modelId: rootModelId,
      enabled: true,
      children: [
        ...l.croppers.map(({ cropper, recognizers }) => ({
          ...step(cropper, on.has(cropper.id) || recognizers.some((r) => on.has(r.id))),
          children: recognizers.map((r) => step(r, on.has(r.id))),
        })),
        ...l.classifiers.map((k) => step(k, on.has(k.id))),
        ...l.refiners.map((r) => step(r, on.has(r.id))),
      ],
    },
  ]
}
