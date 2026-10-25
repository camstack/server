/**
 * Shared bench-facing schemas: the minimal recursive step tree. Extracted from
 * `bench-actions.ts` so the capacity-ramp schemas (`capacity/capacity-schemas.ts`)
 * can reuse it without a bench-actions ↔ capacity-schemas import cycle.
 *
 * Local mirror of pipeline-executor's step shape ON PURPOSE (not a cap-package
 * coupling): addonId + modelId + enabled + children.
 *
 * There is no engine choice here any more (D646). A bench names the pool it
 * measures by `deviceKey`; the engine override it used to carry was honoured by
 * swapping the executor's shared engine state under live cameras.
 */
import { z } from 'zod'

/** Recursive step shape — matches PipelineStepInput minimally for cap input. */
export interface BenchStepShape {
  readonly addonId: string
  readonly modelId: string
  readonly enabled: boolean
  readonly children?: readonly BenchStepShape[]
}

export const BenchStepSchema: z.ZodType<BenchStepShape> = z.lazy(() =>
  z.object({
    addonId: z.string(),
    modelId: z.string(),
    enabled: z.boolean(),
    children: z.array(BenchStepSchema).optional(),
  }),
)
