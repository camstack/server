import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { JobJournal, LifecycleJobEngine, StagingArea } from '@camstack/system'
import type { LifecycleJob } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { applyStagedOrThrow } from '../staged-update-applier.js'

const PACKAGE = '@camstack/addon-test'

function job(): LifecycleJob {
  return {
    jobId: 'job-1',
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
        packageName: PACKAGE,
        fromVersion: '1.0.0',
        toVersion: '1.0.1',
        phase: 'queued',
        attempts: 0,
        startedAtMs: null,
        finishedAtMs: null,
        error: null,
        stagedPath: null,
        steps: [],
      },
    ],
  }
}

async function runWith(success: boolean): Promise<{ phase: string | undefined; error: unknown }> {
  const journal = new JobJournal(fs.mkdtempSync(path.join(os.tmpdir(), 'journal-')))
  const staging = new StagingArea(fs.mkdtempSync(path.join(os.tmpdir(), 'staging-')), {
    fetchTarball: async () => Buffer.from('x'),
    extract: async (_tgz, dir) => {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: PACKAGE, version: '1.0.1' }),
      )
    },
  })
  const target = {
    applyStagedAddonUpdate: async () =>
      success
        ? { success: true, version: '1.0.1', requiresRestart: false }
        : {
            success: false,
            version: '',
            requiresRestart: false,
            error: 'swap refused',
          },
  }
  const j = job()
  journal.createJob(j)
  const engine = new LifecycleJobEngine({
    journal,
    staging,
    applyAddonUpdate: (input) => applyStagedOrThrow(target, input),
    emit: () => undefined,
    now: () => 1000,
    fetchTimeoutMs: 5000,
  })
  const result = await engine.runJob(j)
  return { phase: result.tasks[0]?.phase, error: result.tasks[0]?.error }
}

describe('a staged swap that reports failure', () => {
  it('ends the lifecycle task failed, not done', async () => {
    const r = await runWith(false)
    expect(r.phase).toBe('failed')
    expect(String(r.error)).toContain('swap refused')
  })

  it('a successful swap still ends done', async () => {
    expect((await runWith(true)).phase).toBe('done')
  })
})
