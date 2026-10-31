import { describe, expect, it } from 'vitest'
import { probeHungChild, sampleOutputPath } from '../hang-probe'
import { restartIntentExists } from '../node-supervisor-io'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { RESTART_INTENT_FILE, SERVER_ROOT_DIRNAME } from '@camstack/node-root'

describe('hang probe', () => {
  it('is a no-op off macOS and without a pid', async () => {
    await expect(probeHungChild(123, '/nonexistent', 'linux')).resolves.toBeUndefined()
    await expect(probeHungChild(123, '/nonexistent', 'win32')).resolves.toBeUndefined()
    await expect(probeHungChild(null, '/nonexistent', 'darwin')).resolves.toBeUndefined()
  })
  it('names the sample file by timestamp in the log dir', () => {
    expect(sampleOutputPath('/logs', 7)).toBe(path.join('/logs', 'hang-7.txt'))
  })
})

describe('restartIntentExists', () => {
  it('is true for a fresh marker, false when absent or stale', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-'))
    try {
      expect(restartIntentExists(dir)).toBe(false)
      fs.mkdirSync(path.join(dir, SERVER_ROOT_DIRNAME))
      const f = path.join(dir, SERVER_ROOT_DIRNAME, RESTART_INTENT_FILE)
      fs.writeFileSync(f, '{}')
      expect(restartIntentExists(dir)).toBe(true)
      expect(restartIntentExists(dir, Date.now() + 10 * 60_000)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
