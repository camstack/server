import { z } from 'zod'
import {
  RecordingBandSchema,
  RecordingBandModeSchema,
  RecordingBandTriggersSchema,
  RecordingWeekdaySchema,
} from '@dominevo/types'
import type { RecordingBand, RecordingBandMode, RecordingBandTriggers } from '@dominevo/types'

// Re-export the canonical band schema pieces from `@dominevo/types` under
// recorder's historical public names so the two never drift (single source
// of truth lives in `@dominevo/types/interfaces/recording-config`).
export const WeekdaySchema = RecordingWeekdaySchema
export const BandModeSchema = RecordingBandModeSchema
export type BandMode = RecordingBandMode
export const BandTriggersSchema = RecordingBandTriggersSchema
export type BandTriggers = RecordingBandTriggers
export { RecordingBandSchema }
export type { RecordingBand }

export const RecordingBandsConfigSchema = z.object({
  bands: z.array(RecordingBandSchema).default([]),
})
export type RecordingBandsConfig = z.infer<typeof RecordingBandsConfigSchema>
