import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { PythonEnvManager } from '../src/python/python-env-manager'

describe('PythonEnvManager', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-python-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('probe returns a PythonProbeResult with available field', async () => {
    const manager = new PythonEnvManager(tmpDir)
    const result = await manager.probe()
    expect(result).toHaveProperty('available')
    expect(typeof result.available).toBe('boolean')
  })

  it('probe caches the result on repeated calls', async () => {
    const manager = new PythonEnvManager(tmpDir)
    const r1 = await manager.probe()
    const r2 = await manager.probe()
    // Same object reference means it was cached
    expect(r1).toBe(r2)
  })

  it('probe returns version and path when Python is available', async () => {
    const manager = new PythonEnvManager(tmpDir)
    const result = await manager.probe()
    if (result.available) {
      expect(result.version).toBeDefined()
      expect(result.path).toBeDefined()
      expect(typeof result.version).toBe('string')
      expect(typeof result.path).toBe('string')
    }
  })

  it('spawn throws when venv not initialized', () => {
    const manager = new PythonEnvManager(tmpDir)
    expect(() => manager.spawn('script.py', [])).toThrow('Python venv not initialized')
  })

  it('has the correct venv path under dataDir', () => {
    const manager = new PythonEnvManager(tmpDir)
    // Access private field via any to verify path construction
    const venvPath = (manager as unknown as { venvPath: string }).venvPath
    expect(venvPath).toBe(path.join(tmpDir, '.venv'))
  })
})
