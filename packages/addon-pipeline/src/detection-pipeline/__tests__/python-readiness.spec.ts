// packages/addon-pipeline/src/detection-pipeline/__tests__/python-readiness.spec.ts
import { describe, it, expect, vi } from 'vitest'
import { ensurePythonReady } from '../python-readiness.js'

function makeLog() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child() {
      return this
    },
    withTags() {
      return this
    },
  }
}

describe('ensurePythonReady', () => {
  it('reports ok=true and the path when python resolves', async () => {
    const deps = { ensurePython: async () => '/data/deps/python/bin/python3' }
    const res = await ensurePythonReady(deps, makeLog())
    expect(res).toEqual({ pythonPath: '/data/deps/python/bin/python3', ok: true })
  })

  it('reports ok=false and logs an error when python is unavailable', async () => {
    const deps = { ensurePython: async () => null }
    const log = makeLog()
    const res = await ensurePythonReady(deps, log)
    expect(res.ok).toBe(false)
    expect(res.pythonPath).toBeNull()
    expect(log.error).toHaveBeenCalled()
  })

  it('reports ok=false and logs when ensurePython throws', async () => {
    const deps = {
      ensurePython: async () => {
        throw new Error('download failed')
      },
    }
    const log = makeLog()
    const res = await ensurePythonReady(deps, log)
    expect(res.ok).toBe(false)
    expect(log.error).toHaveBeenCalled()
  })
})
