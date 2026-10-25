import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { LifecycleJob, LifecycleTask, TaskLogEntry } from '@camstack/types'
import {
  LifecycleJobEngine,
  type ApplyAddonUpdateFn,
  type EmitFn,
} from '../lifecycle-job-engine.js'
import { JobJournal } from '../job-journal.js'
import { StagingArea } from '../staging-area.js'

describe('LifecycleJobEngine', () => {
  let journal: JobJournal
  let staging: StagingArea
  let emitLog: { kind: string; job: LifecycleJob; entry?: TaskLogEntry }[]
  let emit: EmitFn
  let applyAddonUpdateCalls: { name: string; version: string; stagedPath: string }[]
  let applyAddonUpdate: ApplyAddonUpdateFn
  let now: () => number
  let currentTime: number
  let journalDir: string
  let stagingDir: string

  beforeEach(() => {
    journalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'))
    stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-'))

    journal = new JobJournal(journalDir)

    const fakeTgz = Buffer.from('fake')
    const writePkg = (v: string) => async (_t: Buffer, d: string) => {
      fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(
        path.join(d, 'package.json'),
        JSON.stringify({ name: '@camstack/addon-test', version: v }),
      )
    }

    staging = new StagingArea(stagingDir, {
      fetchTarball: async () => fakeTgz,
      extract: writePkg('1.0.1'),
    })

    emitLog = []
    currentTime = 1000
    now = () => currentTime
    applyAddonUpdateCalls = []
    applyAddonUpdate = async (input) => {
      applyAddonUpdateCalls.push(input)
    }
    emit = (kind, job, entry) => {
      emitLog.push({ kind, job, entry })
    }
  })

  it('drives a successful addon update to done + emits phase progress', async () => {
    // Setup
    const job: LifecycleJob = {
      jobId: 'job-123',
      kind: 'update',
      state: 'running',
      createdAtMs: 1000,
      createdBy: 'admin',
      scope: 'single',
      schemaVersion: 1,
      tasks: [
        {
          taskId: 'task-1',
          target: 'addon',
          nodeId: 'hub',
          packageName: '@camstack/addon-test',
          fromVersion: '1.0.0',
          toVersion: '1.0.1',
          phase: 'queued',
          attempts: 0,
          startedAtMs: null,
          finishedAtMs: null,
          error: null,
          stagedPath: null,
          steps: [],
        } as LifecycleTask,
      ],
    }

    journal.createJob(job)

    const engine = new LifecycleJobEngine({
      journal,
      staging,
      applyAddonUpdate,
      emit,
      now,
      fetchTimeoutMs: 5000,
    })

    // Execute
    const result = await engine.runJob(job)

    // Assert
    expect(result.state).toBe('completed')
    expect(result.tasks[0]?.phase).toBe('done')
    expect(result.tasks[0]?.finishedAtMs).toBe(1000)
    expect(applyAddonUpdateCalls).toHaveLength(1)
    expect(applyAddonUpdateCalls[0]).toEqual({
      name: '@camstack/addon-test',
      version: '1.0.1',
      stagedPath: expect.any(String),
    })

    // Verify all phases were emitted
    const phases = emitLog.filter((e) => e.kind === 'progress').map((e) => e.job.tasks[0]?.phase)
    expect(phases).toContain('fetching')
    expect(phases).toContain('staged')
    expect(phases).toContain('validating')
    expect(phases).toContain('applying')
    expect(phases).toContain('restarting')
    expect(phases).toContain('done')
  })

  it('marks failed when apply throws', async () => {
    // Setup
    const job: LifecycleJob = {
      jobId: 'job-456',
      kind: 'update',
      state: 'running',
      createdAtMs: 1000,
      createdBy: 'admin',
      scope: 'single',
      schemaVersion: 1,
      tasks: [
        {
          taskId: 'task-2',
          target: 'addon',
          nodeId: 'hub',
          packageName: '@camstack/addon-test',
          fromVersion: '1.0.0',
          toVersion: '1.0.1',
          phase: 'queued',
          attempts: 0,
          startedAtMs: null,
          finishedAtMs: null,
          error: null,
          stagedPath: null,
          steps: [],
        } as LifecycleTask,
      ],
    }

    journal.createJob(job)

    const failingApply: ApplyAddonUpdateFn = async () => {
      throw new Error('apply failed')
    }

    const engine = new LifecycleJobEngine({
      journal,
      staging,
      applyAddonUpdate: failingApply,
      emit,
      now,
    })

    // Execute
    const result = await engine.runJob(job)

    // Assert
    expect(result.state).toBe('failed')
    expect(result.tasks[0]?.phase).toBe('failed')
    expect(result.tasks[0]?.error).toBe('apply failed')
    expect(result.tasks[0]?.finishedAtMs).toBe(1000)
  })

  it('a DIST-TAG request records the version that was actually installed', async () => {
    // `addons.updatePackage` with no explicit version resolves to the literal
    // `'latest'` (cap-providers.ts) and hands it to this engine as `toVersion`.
    // The staging area already resolves the tag — it reads the unpacked
    // package.json and returns `resolvedVersion` — and the engine dropped it,
    // so `applyAddonUpdate` was called with the STRING 'latest'. Downstream
    // that string became the manifest's installed version, the registry's
    // displayed version, and the `toVersion` on the `addon.updated` event the
    // operator read as "@camstack/addon-terminal 0.0.0 → latest".
    const resolving = new StagingArea(stagingDir, {
      fetchTarball: async () => Buffer.from('fake'),
      extract: async (_t: Buffer, d: string) => {
        fs.mkdirSync(d, { recursive: true })
        fs.writeFileSync(
          path.join(d, 'package.json'),
          JSON.stringify({ name: '@camstack/addon-terminal', version: '0.1.51' }),
        )
      },
    })
    const job: LifecycleJob = {
      jobId: 'job-tag',
      kind: 'update',
      state: 'running',
      createdAtMs: 1000,
      createdBy: 'admin',
      scope: 'single',
      schemaVersion: 1,
      tasks: [
        {
          taskId: 'task-tag',
          target: 'addon',
          nodeId: 'hub',
          packageName: '@camstack/addon-terminal',
          fromVersion: '0.1.47',
          toVersion: 'latest',
          phase: 'queued',
          attempts: 0,
          startedAtMs: null,
          finishedAtMs: null,
          error: null,
          stagedPath: null,
          steps: [],
        } as LifecycleTask,
      ],
    }
    journal.createJob(job)

    const engine = new LifecycleJobEngine({
      journal,
      staging: resolving,
      applyAddonUpdate,
      emit,
      now,
      fetchTimeoutMs: 5000,
    })
    const result = await engine.runJob(job)

    expect(result.state).toBe('completed')
    // The apply — and therefore the manifest, the registry and the event.
    expect(applyAddonUpdateCalls[0]?.version).toBe('0.1.51')
    // And the journal the Addons page reads back.
    expect(result.tasks[0]?.toVersion).toBe('0.1.51')
    expect(journal.getJob('job-tag')?.tasks[0]?.toVersion).toBe('0.1.51')
  })
})
