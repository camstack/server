import { defineEntryKind, entryBody } from '@camstack/types'
import { z } from 'zod'

export const TRAINING_MODAL_OWNER = 'training-modal'

export const TrainingAccountBodySchema = entryBody({
  tokenId: z.string(),
  tokenSecret: z.string().meta({ secret: true }),
  environment: z.string(),
  gpuType: z.string(),
  region: z.string(),
  costCapUsd: z.number(),
  maxRuntimeHours: z.number(),
  failedDatasetGraceHours: z.number(),
})
export type TrainingAccountBody = z.infer<typeof TrainingAccountBodySchema>

export const trainingAccountEntryKind = defineEntryKind('training-account', {
  title: 'Modal training accounts',
  schema: TrainingAccountBodySchema,
  writeTrigger: 'an operator adds or edits a cloud training provider account',
})
