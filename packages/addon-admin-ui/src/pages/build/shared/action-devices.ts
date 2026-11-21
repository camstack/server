/**
 * The devices an action's steps name directly, for the quick modal. A step that
 * targets a variable, a type or a room names no device here — it is resolved
 * when the action runs — so the list is "named devices", never "every device
 * the action will touch".
 */
import { z } from 'zod'

/** The fields of a step this walk reads, whatever the step kind. */
interface StepNode {
  target?: { kind: string; ids?: number[] }
  steps?: StepNode[]
  else?: StepNode[]
  branches?: { steps: StepNode[] }[]
}

const StepNodeSchema: z.ZodType<StepNode> = z.lazy(() =>
  z.object({
    target: z.object({ kind: z.string(), ids: z.array(z.number()).optional() }).optional(),
    steps: z.array(StepNodeSchema).optional(),
    else: z.array(StepNodeSchema).optional(),
    branches: z.array(z.object({ steps: z.array(StepNodeSchema) })).optional(),
  }),
)

function collect(steps: readonly StepNode[], into: Set<number>): void {
  for (const step of steps) {
    if (step.target?.kind === 'devices') {
      for (const id of step.target.ids ?? []) into.add(id)
    }
    collect(step.steps ?? [], into)
    collect(step.else ?? [], into)
    for (const branch of step.branches ?? []) collect(branch.steps, into)
  }
}

/** Distinct device ids named by the steps, in first-seen order. */
export function actionDeviceIds(steps: readonly unknown[]): readonly number[] {
  const seen = new Set<number>()
  const parsed = z.array(StepNodeSchema).safeParse(steps)
  if (parsed.success) collect(parsed.data, seen)
  return [...seen]
}
