import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { LifecycleJob, LifecycleTask } from '@camstack/types'
import {
  LifecycleJobEngine,
  type ApplyAddonUpdateFn,
  type EmitFn,
} from '../lifecycle-job-engine.js'
import { JobJournal } from '../job-journal.js'
import { StagingArea } from '../staging-area.js'

function makeAddonTask(name: string, overrides: Partial<LifecycleTask> = {}): LifecycleTask {
  return {
    taskId: `task-${name}`,
    target: 'addon',
    nodeId: 'hub',
    packageName: name,
    fromVersion: '1.0.0',
    toVersion: '1.0.1',
    phase: 'queued',
    attempts: 0,
    startedAtMs: null,
    finishedAtMs: null,
    error: null,
    stagedPath: null,
    steps: [],
    ...overrides,
  }
}

function makeFrameworkTask(overrides: Partial<LifecycleTask> = {}): LifecycleTask {
  return {
    taskId: 'task-framework',
    target: 'framework',
    nodeId: 'hub',
    packageName: '@camstack/system',
    fromVersion: '1.0.0',
    toVersion: '1.1.0',
    phase: 'queued',
    attempts: 0,
    startedAtMs: null,
    finishedAtMs: null,
    error: null,
    stagedPath: null,
    steps: [],
    ...overrides,
  }
}

function makeBulkJob(jobId: string, tasks: LifecycleTask[]): LifecycleJob {
  return {
    jobId,
    kind: 'update',
    state: 'running',
    createdAtMs: 1000,
    createdBy: 'admin',
    scope: 'bulk',
    schemaVersion: 1,
    tasks,
  }
}

describe('LifecycleJobEngine — bulk ordering', () => {
  let journal: JobJournal
  let journalDir: string
  let stagingDir: string
  let emit: EmitFn
  let applyOrder: string[]
  let applyAddonUpdate: ApplyAddonUpdateFn
  // concurrency instrumentation for fetchTarball
  let liveFetches: number
  let maxLiveFetches: number
  let failFetchFor: Set<string>

  beforeEach(() => {
    journalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-bulk-'))
    stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-bulk-'))
    journal = new JobJournal(journalDir)
    emit = () => {}
    applyOrder = []
    applyAddonUpdate = async (input) => {
      applyOrder.push(input.name)
    }
    liveFetches = 0
    maxLiveFetches = 0
    failFetchFor = new Set()
  })

  function makeStaging(): StagingArea {
    return new StagingArea(stagingDir, {
      fetchTarball: async (name) => {
        if (failFetchFor.has(name)) {
          throw new Error(`fetch failed for ${name}`)
        }
        liveFetches++
        maxLiveFetches = Math.max(maxLiveFetches, liveFetches)
        // give other queued fetches time to start so concurrency is observable
        await new Promise((r) => setTimeout(r, 20))
        liveFetches--
        return Buffer.from('fake')
      },
      extract: async (_t, d) => {
        fs.mkdirSync(d, { recursive: true })
        fs.writeFileSync(
          path.join(d, 'package.json'),
          JSON.stringify({ name: 'addon', version: '1.0.1' }),
        )
      },
    })
  }

  it('bounds fetch concurrency to fetchConcurrency (cap 3) for a 5-addon + framework bulk', async () => {
    const addonTasks = ['a', 'b', 'c', 'd', 'e'].map((n) => makeAddonTask(`@camstack/addon-${n}`))
    const job = makeBulkJob('job-bulk-1', [...addonTasks, makeFrameworkTask()])
    journal.createJob(job)

    const engine = new LifecycleJobEngine({
      journal,
      staging: makeStaging(),
      applyAddonUpdate,
      emit,
      now: () => 1000,
      fetchConcurrency: 3,
      fetchTimeoutMs: 5000,
    })

    await engine.runJob(job)

    expect(maxLiveFetches).toBeLessThanOrEqual(3)
    expect(maxLiveFetches).toBeGreaterThan(1) // proves it actually ran concurrently
  })

  it('applies addon tasks serially in original input order; framework task is skipped', async () => {
    const addonTasks = ['a', 'b', 'c', 'd', 'e'].map((n) => makeAddonTask(`@camstack/addon-${n}`))
    const job = makeBulkJob('job-bulk-2', [...addonTasks, makeFrameworkTask()])
    journal.createJob(job)

    const engine = new LifecycleJobEngine({
      journal,
      staging: makeStaging(),
      applyAddonUpdate,
      emit,
      now: () => 1000,
      fetchConcurrency: 3,
    })

    const result = await engine.runJob(job)

    // all 5 applied in original order
    expect(applyOrder).toEqual([
      '@camstack/addon-a',
      '@camstack/addon-b',
      '@camstack/addon-c',
      '@camstack/addon-d',
      '@camstack/addon-e',
    ])
    // framework updates ship via applyServerUpdate — the engine skips them,
    // never applies them, so a swept framework target does not fail the job.
    const fwTask = result.tasks.find((t) => t.target === 'framework')
    expect(fwTask?.phase).toBe('skipped')
    expect(fwTask?.finishedAtMs).toBe(1000)
    expect(result.state).toBe('completed')
    // staging job dir cleaned up (job finalized, no reboot handoff)
    expect(fs.existsSync(path.join(stagingDir, 'job-bulk-2'))).toBe(false)
  })

  it('isolates a mid-list fetch failure: other addons apply, framework skipped', async () => {
    failFetchFor.add('@camstack/addon-c')
    const addonTasks = ['a', 'b', 'c', 'd', 'e'].map((n) => makeAddonTask(`@camstack/addon-${n}`))
    const job = makeBulkJob('job-bulk-3', [...addonTasks, makeFrameworkTask()])
    journal.createJob(job)

    const engine = new LifecycleJobEngine({
      journal,
      staging: makeStaging(),
      applyAddonUpdate,
      emit,
      now: () => 1000,
      fetchConcurrency: 3,
    })

    const result = await engine.runJob(job)

    // the failed-fetch task never applies
    expect(applyOrder).toEqual([
      '@camstack/addon-a',
      '@camstack/addon-b',
      '@camstack/addon-d',
      '@camstack/addon-e',
    ])
    expect(applyOrder).not.toContain('@camstack/addon-c')

    const cTask = result.tasks.find((t) => t.packageName === '@camstack/addon-c')
    expect(cTask?.phase).toBe('failed')
    expect(cTask?.error).toMatch(/fetch failed/)
    expect(cTask?.finishedAtMs).toBe(1000)

    // framework skipped (not applied); one addon failed → partially-failed
    const fwTask = result.tasks.find((t) => t.target === 'framework')
    expect(fwTask?.phase).toBe('skipped')
    expect(result.state).toBe('partially-failed')
  })

  it('single addon task: identical fetch→apply→done path (regression)', async () => {
    const job = makeBulkJob('job-single', [makeAddonTask('@camstack/addon-only')])
    journal.createJob(job)

    const engine = new LifecycleJobEngine({
      journal,
      staging: makeStaging(),
      applyAddonUpdate,
      emit,
      now: () => 1000,
      fetchConcurrency: 3,
    })

    const result = await engine.runJob(job)

    expect(result.state).toBe('completed')
    expect(result.tasks[0]?.phase).toBe('done')
    expect(result.tasks[0]?.finishedAtMs).toBe(1000)
    expect(applyOrder).toEqual(['@camstack/addon-only'])
    expect(maxLiveFetches).toBe(1)
  })

  it('addon-only bulk with no failures finalizes completed and cleans staging', async () => {
    const addonTasks = ['a', 'b', 'c'].map((n) => makeAddonTask(`@camstack/addon-${n}`))
    const job = makeBulkJob('job-bulk-clean', addonTasks)
    journal.createJob(job)

    const engine = new LifecycleJobEngine({
      journal,
      staging: makeStaging(),
      applyAddonUpdate,
      emit,
      now: () => 1000,
      fetchConcurrency: 3,
    })

    const result = await engine.runJob(job)
    expect(result.state).toBe('completed')
    expect(result.tasks.every((t) => t.phase === 'done')).toBe(true)
    // staging job dir cleaned up
    expect(fs.existsSync(path.join(stagingDir, 'job-bulk-clean'))).toBe(false)
  })

  it('framework-only job: skipped, job completes without applying anything', async () => {
    const job = makeBulkJob('job-fw-only', [makeFrameworkTask()])
    journal.createJob(job)

    const engine = new LifecycleJobEngine({
      journal,
      staging: makeStaging(),
      applyAddonUpdate,
      emit,
      now: () => 1000,
      fetchConcurrency: 3,
    })

    const result = await engine.runJob(job)

    expect(applyOrder).toEqual([])
    expect(result.tasks[0]?.phase).toBe('skipped')
    expect(result.state).toBe('completed')
  })
})
