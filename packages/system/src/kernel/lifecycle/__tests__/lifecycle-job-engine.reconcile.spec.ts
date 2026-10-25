import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { LifecycleJob, LifecycleTask, TaskPhase } from '@camstack/types'
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
    packageName: '@camstack/kernel',
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

function makeJob(jobId: string, tasks: LifecycleTask[]): LifecycleJob {
  return {
    jobId,
    kind: 'update',
    state: 'running',
    createdAtMs: 1000,
    createdBy: 'admin',
    scope: tasks.length === 1 ? 'single' : 'bulk',
    schemaVersion: 1,
    tasks,
  }
}

describe('LifecycleJobEngine — reconcileJob (§10)', () => {
  let journal: JobJournal
  let journalDir: string
  let stagingDir: string
  let emit: EmitFn
  let fetchSpy: string[]
  let applySpy: { name: string; stagedPath: string }[]
  let applyAddonUpdate: ApplyAddonUpdateFn
  let applyThrowFor: Set<string>
  let stagedPathExistsResult: boolean

  beforeEach(() => {
    journalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-recon-'))
    stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-recon-'))
    journal = new JobJournal(journalDir)
    emit = () => {}
    fetchSpy = []
    applySpy = []
    applyThrowFor = new Set()
    stagedPathExistsResult = false
    applyAddonUpdate = async (input) => {
      if (applyThrowFor.has(input.name)) {
        throw new Error(`apply failed for ${input.name}`)
      }
      applySpy.push({ name: input.name, stagedPath: input.stagedPath })
    }
  })

  function makeStaging(): StagingArea {
    return new StagingArea(stagingDir, {
      fetchTarball: async (name) => {
        fetchSpy.push(name)
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

  function makeEngine(): LifecycleJobEngine {
    return new LifecycleJobEngine({
      journal,
      staging: makeStaging(),
      applyAddonUpdate,
      emit,
      now: () => 1000,
      fetchTimeoutMs: 5000,
      stagedPathExists: () => stagedPathExistsResult,
    })
  }

  // §10: queued/fetching → re-fetch+stage, then apply
  it.each<[string, TaskPhase]>([
    ['queued', 'queued'],
    ['fetching', 'fetching'],
  ])('re-fetches a %s addon task then applies → done', async (_label, phase) => {
    const task = makeAddonTask('@camstack/addon-x', { phase, stagedPath: null })
    const job = makeJob('job-1', [task])
    journal.createJob(job)

    const result = await makeEngine().reconcileJob(journal.getJob('job-1')!)

    expect(fetchSpy).toContain('@camstack/addon-x')
    expect(applySpy.map((a) => a.name)).toContain('@camstack/addon-x')
    expect(result.tasks[0]?.phase).toBe('done')
    expect(result.state).toBe('completed')
  })

  // §10: staged/validating → reuse valid stagedPath else re-fetch
  it.each<[TaskPhase]>([
    ['staged'],
    ['validating'],
  ])('reuses a valid stagedPath for a %s addon task (no re-fetch)', async (phase) => {
    stagedPathExistsResult = true
    const stagedPath = path.join(stagingDir, 'existing-staged')
    const task = makeAddonTask('@camstack/addon-y', { phase, stagedPath })
    const job = makeJob('job-2', [task])
    journal.createJob(job)

    const result = await makeEngine().reconcileJob(journal.getJob('job-2')!)

    expect(fetchSpy).not.toContain('@camstack/addon-y')
    expect(applySpy).toEqual([{ name: '@camstack/addon-y', stagedPath }])
    expect(result.tasks[0]?.phase).toBe('done')
  })

  it('re-fetches a staged addon task when the stagedPath dir is gone', async () => {
    stagedPathExistsResult = false
    const task = makeAddonTask('@camstack/addon-z', {
      phase: 'staged',
      stagedPath: '/gone/path',
    })
    const job = makeJob('job-3', [task])
    journal.createJob(job)

    const result = await makeEngine().reconcileJob(journal.getJob('job-3')!)

    expect(fetchSpy).toContain('@camstack/addon-z')
    expect(applySpy.map((a) => a.name)).toContain('@camstack/addon-z')
    expect(result.tasks[0]?.phase).toBe('done')
  })

  // §10: applying → reuse stagedPath (idempotent re-apply) else re-fetch
  it('reuses a valid stagedPath for an applying addon task (idempotent re-apply)', async () => {
    stagedPathExistsResult = true
    const stagedPath = path.join(stagingDir, 'mid-apply-staged')
    const task = makeAddonTask('@camstack/addon-mid', { phase: 'applying', stagedPath })
    const job = makeJob('job-4', [task])
    journal.createJob(job)

    const result = await makeEngine().reconcileJob(journal.getJob('job-4')!)

    expect(fetchSpy).not.toContain('@camstack/addon-mid')
    expect(applySpy).toEqual([{ name: '@camstack/addon-mid', stagedPath }])
    expect(result.tasks[0]?.phase).toBe('done')
  })

  // §10: restarting → re-apply same toVersion (reuse stagedPath)
  it('re-applies a restarting addon task reusing its stagedPath → done', async () => {
    stagedPathExistsResult = true
    const stagedPath = path.join(stagingDir, 'restart-staged')
    const task = makeAddonTask('@camstack/addon-r', { phase: 'restarting', stagedPath })
    const job = makeJob('job-5', [task])
    journal.createJob(job)

    const result = await makeEngine().reconcileJob(journal.getJob('job-5')!)

    expect(applySpy).toEqual([{ name: '@camstack/addon-r', stagedPath }])
    expect(result.tasks[0]?.phase).toBe('done')
  })

  // §10: restarting → apply throws (runner never returns) → failed
  it('marks a restarting addon task failed when re-apply throws', async () => {
    stagedPathExistsResult = true
    applyThrowFor.add('@camstack/addon-bad')
    const stagedPath = path.join(stagingDir, 'bad-staged')
    const task = makeAddonTask('@camstack/addon-bad', { phase: 'restarting', stagedPath })
    const job = makeJob('job-6', [task])
    journal.createJob(job)

    const result = await makeEngine().reconcileJob(journal.getJob('job-6')!)

    expect(result.tasks[0]?.phase).toBe('failed')
    expect(result.state).toBe('failed')
  })

  // terminal tasks are skipped
  it('skips terminal tasks (done/failed/skipped) — no fetch, no apply', async () => {
    const tasks = [
      makeAddonTask('@camstack/addon-done', { phase: 'done' }),
      makeAddonTask('@camstack/addon-failed', { phase: 'failed' }),
      makeAddonTask('@camstack/addon-skipped', { phase: 'skipped' }),
    ]
    const job = makeJob('job-7', tasks)
    journal.createJob(job)

    await makeEngine().reconcileJob(journal.getJob('job-7')!)

    expect(fetchSpy).toEqual([])
    expect(applySpy).toEqual([])
  })

  // framework present + non-terminal → skipped so the job can finalize.
  // Framework updates no longer run through the engine (single-copy collapse —
  // they ship via applyServerUpdate), so a stray non-terminal framework task is
  // marked `skipped` during reconcile instead of hanging the job `running`.
  it('re-drives an addon task and skips a non-terminal framework task, finalizing the job', async () => {
    stagedPathExistsResult = true
    const stagedPath = path.join(stagingDir, 'fw-mixed-staged')
    const addon = makeAddonTask('@camstack/addon-mix', { phase: 'applying', stagedPath })
    const framework = makeFrameworkTask({ phase: 'staged', stagedPath: '/tmp/fw' })
    const job = makeJob('job-8', [addon, framework])
    journal.createJob(job)

    const result = await makeEngine().reconcileJob(journal.getJob('job-8')!)

    const addonTask = result.tasks.find((t) => t.target === 'addon')
    const fwTask = result.tasks.find((t) => t.target === 'framework')
    expect(addonTask?.phase).toBe('done')
    // framework skipped (never applied by the engine)
    expect(fwTask?.phase).toBe('skipped')
    // job finalized — every task is terminal (addon done + framework skipped)
    expect(result.state).toBe('completed')
  })

  // all-addon job finalizes completed
  it('finalizes an all-addon job to completed', async () => {
    stagedPathExistsResult = true
    const tasks = [
      makeAddonTask('@camstack/addon-1', {
        phase: 'applying',
        stagedPath: path.join(stagingDir, 's1'),
      }),
      makeAddonTask('@camstack/addon-2', {
        phase: 'staged',
        stagedPath: path.join(stagingDir, 's2'),
      }),
    ]
    const job = makeJob('job-9', tasks)
    journal.createJob(job)

    const result = await makeEngine().reconcileJob(journal.getJob('job-9')!)

    expect(result.tasks.every((t) => t.phase === 'done')).toBe(true)
    expect(result.state).toBe('completed')
  })

  it('finalizes a mixed-result addon job to partially-failed', async () => {
    stagedPathExistsResult = true
    applyThrowFor.add('@camstack/addon-fail')
    const tasks = [
      makeAddonTask('@camstack/addon-ok', {
        phase: 'applying',
        stagedPath: path.join(stagingDir, 'ok'),
      }),
      makeAddonTask('@camstack/addon-fail', {
        phase: 'applying',
        stagedPath: path.join(stagingDir, 'fail'),
      }),
    ]
    const job = makeJob('job-10', tasks)
    journal.createJob(job)

    const result = await makeEngine().reconcileJob(journal.getJob('job-10')!)

    expect(result.state).toBe('partially-failed')
  })
})
