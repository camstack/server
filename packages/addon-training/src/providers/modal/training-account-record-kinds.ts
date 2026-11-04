import { defineEntryKind, entryBody } from '@camstack/types'
import { z } from 'zod'

export const TRAINING_MODAL_OWNER = 'training-modal'

export const TrainingAccountBodySchema = entryBody({
  tokenId: z.string(),
  /** Absent until the operator enters it; a keychain marker bound to the row. */
  tokenSecret: z.string().optional().meta({ secret: true }),
  environment: z.string(),
  gpuType: z.string(),
  region: z.string(),
  costCapUsd: z.number(),
  maxRuntimeHours: z.number(),
  failedDatasetGraceHours: z.number(),
  /** The account's own switch (D996). Absent means on. */
  enabled: z.boolean().optional(),
})
export type TrainingAccountBody = z.infer<typeof TrainingAccountBodySchema>

export const trainingAccountEntryKind = defineEntryKind('training-account', {
  title: 'Modal training accounts',
  schema: TrainingAccountBodySchema,
  writeTrigger: 'an operator adds or edits a cloud training provider account',
})
