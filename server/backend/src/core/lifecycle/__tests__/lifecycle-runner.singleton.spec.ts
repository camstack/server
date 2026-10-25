import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { LifecycleJobRunnerDeps } from '../../../api/core/lifecycle-job-runner.js'
import {
  initLifecycleRunner,
  getLifecycleRunner,
  __resetLifecycleRunnerForTests,
} from '../lifecycle-runner.singleton.js'

function makeDeps(): LifecycleJobRunnerDeps {
  return {
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ljr-singleton-')),
    fetchTarball: async () => Buffer.from('x'),
    extract: async (_t, d) => {
      fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ version: '1.0.1' }))
    },
    applyAddonUpdate: async () => {},
    emit: () => {},
  }
}

describe('lifecycle-runner singleton', () => {
  beforeEach(() => {
    __resetLifecycleRunnerForTests()
  })

  it('getLifecycleRunner throws before init', () => {
    expect(() => getLifecycleRunner()).toThrow(/not.*initial/i)
  })

  it('initLifecycleRunner is idempotent — returns the same instance', () => {
    const a = initLifecycleRunner(makeDeps())
    const b = initLifecycleRunner(makeDeps())
    expect(b).toBe(a)
    expect(getLifecycleRunner()).toBe(a)
  })

  it('startJob records the createdBy passed per-call', async () => {
    const runner = initLifecycleRunner(makeDeps())
    const { jobId } = await runner.startJob({
      kind: 'update',
      targets: [{ name: '@camstack/addon-x', version: '1.0.1' }],
      createdBy: 'alice',
    })
    const job = runner.getJob(jobId)
    expect(job?.createdBy).toBe('alice')
  })
})
