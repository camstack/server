// packages/types/src/types/pipeline-schema.ts
//
// All types here are derived from the Zod schemas in pipeline-executor.cap.ts.
// This ensures z.infer<PipelineSchemaSchema> === PipelineSchema — no manual
// sync required.  Types that have no Zod equivalent remain as TS interfaces.
import type { z } from 'zod'
import type {
  PipelineSchemaSchema,
  PipelineAddonSchemaSchema,
  PipelineSlotSchemaSchema,
  PipelineModelOptionSchema,
  AvailableEngineSchema,
} from '../capabilities/pipeline-executor.cap.js'
import type { PipelineDefaultStepOutput } from '../capabilities/pipeline-executor.cap.js'

// ── Schema returned by pipeline.getSchema() ───────────────────────

export type PipelineAddonSchema = z.infer<typeof PipelineAddonSchemaSchema>
export type PipelineModelOption = z.infer<typeof PipelineModelOptionSchema>
export type PipelineSlotSchema = z.infer<typeof PipelineSlotSchemaSchema>
export type AvailableEngine = z.infer<typeof AvailableEngineSchema>
export type PipelineSchema = z.infer<typeof PipelineSchemaSchema>

// ── Default step (server-resolved, used by UI and detection wiring) ──

/**
 * A fully-resolved pipeline step.
 * Runtime/backend are NOT per-step — they come from PipelineConfig.engine.
 */
export type PipelineDefaultStep = PipelineDefaultStepOutput
