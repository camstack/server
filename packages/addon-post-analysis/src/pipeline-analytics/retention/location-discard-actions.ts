import { customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'

const DiscardStartInput = z.object({
  locationId: z.string().min(1),
})

const DiscardStarted = z.object({
  started: z.boolean(),
  alreadyRunning: z.boolean(),
  jobId: z.string().nullable(),
})

export const DiscardStatusSchema = z.object({
  running: z.boolean(),
  locationId: z.string().nullable(),
  jobId: z.string().nullable(),
  phase: z.enum([
    'idle',
    'scanning',
    'wiping-fs',
    'wiping-db',
    'cascading',
    'complete',
    'cancelled',
    'error',
  ]),
  camerasTotal: z.number(),
  camerasDone: z.number(),
  foldersRemoved: z.number(),
  dbRowsDeleted: z.number(),
  ownersCascaded: z.number(),
  detail: z.string(),
  startedAtMs: z.number().nullable(),
  finishedAtMs: z.number().nullable(),
  error: z.string().nullable(),
})

const DiscardCancel = z.object({
  requested: z.boolean(),
})

export const locationDiscardActions = defineCustomActions({
  'storage.discardLocation': customAction(DiscardStartInput, DiscardStarted, { auth: 'admin' }),
  'storage.discardLocationStatus': customAction(z.object({}), DiscardStatusSchema, {
    auth: 'admin',
  }),
  'storage.discardLocationCancel': customAction(z.object({}), DiscardCancel, { auth: 'admin' }),
})

export type LocationDiscardActions = typeof locationDiscardActions
export type DiscardStartInput = z.infer<typeof DiscardStartInput>
