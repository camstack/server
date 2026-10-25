import type { PipelineSlot } from '../types/pipeline.js'
import type { RequiredStep } from './addon.js'

export interface IPipelineSlotProvider {
  readonly slot: PipelineSlot
  readonly inputClasses: readonly string[] | null
  readonly outputClasses: readonly string[]
  readonly requiredSteps?: readonly RequiredStep[]
  readonly slotPriority: number
}
