import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createLifecycleJobRunner } from '../lifecycle-job-runner.js'

describe('createLifecycleJobRunner', () => {
  it('startJob stages, applies via the swap callback, and getJob returns the terminal job', async () => {
    const applied: Array<{ name: string; version: string; stagedPath: string }> = []
    const runner = createLifecycleJobRunner({
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ljr-')),
      fetchTarball: async () => Buffer.from('x'),
      extract: async (_t, d) => {
        fs.mkdirSync(d, { recursive: true })
        fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ version: '1.0.1' }))
      },
      applyAddonUpdate: async (i) => {
        applied.push(i)
      },
      emit: () => {},
      now: (() => {
        let n = 0
        return () => ++n
      })(),
    })
    const { jobId } = await runner.startJob({
      kind: 'update',
      targets: [{ name: '@camstack/addon-x', version: '1.0.1' }],
      createdBy: 'admin',
    })
    const job = runner.getJob(jobId)
    expect(job?.state).toBe('completed')
    expect(job?.createdBy).toBe('admin') // createdBy now travels on the startJob input
    expect(job?.tasks[0]?.phase).toBe('done')
    expect(applied[0]).toMatchObject({ name: '@camstack/addon-x', version: '1.0.1' })
    expect(typeof applied[0]?.stagedPath).toBe('string') // staged dir IS the swap source
  })
})
