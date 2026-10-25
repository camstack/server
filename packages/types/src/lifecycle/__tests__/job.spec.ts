import { describe, it, expect } from 'vitest'
import { lifecycleJobSchema, lifecycleTaskSchema, taskPhaseSchema } from '../job.js'

const task = {
  taskId: 't1',
  nodeId: 'hub',
  packageName: '@camstack/addon-pipeline',
  fromVersion: '1.0.0',
  toVersion: '1.0.1',
  target: 'addon',
  phase: 'queued',
  stagedPath: null,
  attempts: 0,
  steps: [],
  error: null,
  startedAtMs: null,
  finishedAtMs: null,
}
const job = {
  jobId: 'j1',
  kind: 'update',
  createdAtMs: 1,
  createdBy: 'admin',
  scope: 'single',
  tasks: [task],
  state: 'running',
  schemaVersion: 1,
}

describe('lifecycle schemas', () => {
  it('parses a valid task', () => {
    expect(lifecycleTaskSchema.parse(task)).toEqual(task)
  })
  it('rejects an unknown phase', () => {
    expect(taskPhaseSchema.safeParse('bogus').success).toBe(false)
  })
  it('round-trips a job through JSON', () => {
    const parsed = lifecycleJobSchema.parse(JSON.parse(JSON.stringify(job)))
    expect(parsed.tasks[0]?.packageName).toBe('@camstack/addon-pipeline')
    expect(parsed.schemaVersion).toBe(1)
  })
  it('rejects schemaVersion != 1', () => {
    expect(lifecycleJobSchema.safeParse({ ...job, schemaVersion: 2 }).success).toBe(false)
  })
})
