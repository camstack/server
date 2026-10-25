import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { JobJournal } from '../job-journal.js'
import type { LifecycleJob } from '@camstack/types'

let dir: string
let journal: JobJournal

const baseJob = (): LifecycleJob => ({
  jobId: 'j1',
  kind: 'update',
  createdAtMs: 1,
  createdBy: 'admin',
  scope: 'single',
  state: 'running',
  schemaVersion: 1,
  tasks: [
    {
      taskId: 't1',
      nodeId: 'hub',
      packageName: '@camstack/addon-x',
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
    },
  ],
})

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'))
  journal = new JobJournal(dir)
})

describe('JobJournal', () => {
  it('creates and reads back a job', () => {
    journal.createJob(baseJob())
    expect(journal.getJob('j1')?.tasks[0]?.phase).toBe('queued')
  })

  it('patches a task immutably and persists', () => {
    journal.createJob(baseJob())
    expect(
      journal.patchTask('j1', 't1', { phase: 'fetching', startedAtMs: 5 }).tasks[0]?.phase,
    ).toBe('fetching')
    expect(journal.getJob('j1')?.tasks[0]?.startedAtMs).toBe(5)
  })

  it('appends log entries', () => {
    journal.createJob(baseJob())
    journal.appendLog('j1', 't1', {
      tsMs: 1,
      nodeId: 'hub',
      packageName: '@camstack/addon-x',
      phase: 'fetching',
      message: 'x',
    })
    expect(journal.getJob('j1')?.tasks[0]?.steps).toHaveLength(1)
  })

  it('lists active only when asked', () => {
    journal.createJob(baseJob())
    journal.setJobState('j1', 'completed')
    expect(journal.listJobs({ activeOnly: true })).toHaveLength(0)
    expect(journal.listJobs()).toHaveLength(1)
  })

  it('returns null for unknown job', () => {
    expect(journal.getJob('nope')).toBeNull()
  })
})
