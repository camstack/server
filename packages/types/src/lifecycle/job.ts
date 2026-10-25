import { z } from 'zod'

export const jobKindSchema = z.enum(['install', 'update', 'uninstall', 'restart'])
export type JobKind = z.infer<typeof jobKindSchema>

export const taskPhaseSchema = z.enum([
  'queued',
  'fetching',
  'staged',
  'validating',
  'applying',
  'restarting',
  'applied',
  'done',
  'failed',
  'skipped',
])
export type TaskPhase = z.infer<typeof taskPhaseSchema>

export const taskTargetSchema = z.enum(['framework', 'addon'])
export type TaskTarget = z.infer<typeof taskTargetSchema>

export const taskLogEntrySchema = z.object({
  tsMs: z.number(),
  nodeId: z.string(),
  packageName: z.string(),
  phase: taskPhaseSchema,
  message: z.string(),
})
export type TaskLogEntry = z.infer<typeof taskLogEntrySchema>

export const lifecycleTaskSchema = z.object({
  taskId: z.string(),
  nodeId: z.string(),
  packageName: z.string(),
  fromVersion: z.string().nullable(),
  toVersion: z.string(),
  target: taskTargetSchema,
  phase: taskPhaseSchema,
  stagedPath: z.string().nullable(),
  attempts: z.number(),
  steps: z.array(taskLogEntrySchema),
  error: z.string().nullable(),
  startedAtMs: z.number().nullable(),
  finishedAtMs: z.number().nullable(),
})
export type LifecycleTask = z.infer<typeof lifecycleTaskSchema>

export const lifecycleJobStateSchema = z.enum([
  'running',
  'completed',
  'failed',
  'partially-failed',
  'cancelled',
])
export type LifecycleJobState = z.infer<typeof lifecycleJobStateSchema>
export const lifecycleJobScopeSchema = z.enum(['single', 'bulk', 'cluster'])
export type LifecycleJobScope = z.infer<typeof lifecycleJobScopeSchema>

export const lifecycleJobSchema = z.object({
  jobId: z.string(),
  kind: jobKindSchema,
  createdAtMs: z.number(),
  createdBy: z.string(),
  scope: lifecycleJobScopeSchema,
  tasks: z.array(lifecycleTaskSchema),
  state: lifecycleJobStateSchema,
  schemaVersion: z.literal(1),
})
export type LifecycleJob = z.infer<typeof lifecycleJobSchema>
