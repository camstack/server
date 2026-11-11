/**
 * `shutdown()` resolves only once the rotating file stream is closed: a
 * caller that removes the logs directory right after must not see the file
 * open (or its ENOENT) land afterwards.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WinstonDestination } from '../winston-destination.js'

describe('WinstonDestination — shutdown', () => {
  it('leaves nothing open under the logs directory', async () => {
    const uncaught: unknown[] = []
    const onUncaught = (err: unknown): void => {
      uncaught.push(err)
    }
    process.on('uncaughtException', onUncaught)
    try {
      for (let i = 0; i < 100; i++) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-winston-shutdown-'))
        const dest = new WinstonDestination({ inProcess: true, backgroundPassMs: 0 })
        await dest.initialize({ level: 'info', retentionDays: 30, logsDir: dir })
        await dest.shutdown()
        // Fails with ENOTEMPTY when a file was created after shutdown resolved.
        fs.rmSync(dir, { recursive: true })
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    } finally {
      process.off('uncaughtException', onUncaught)
    }
    expect(uncaught.map(String)).toEqual([])
  })
})
