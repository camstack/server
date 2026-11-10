import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { CLUSTER_UPDATE_JOB_FILE, FileClusterUpdateJobStore } from '../cluster-update-job-store.js'

const logger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
  withTags: () => logger,
}

describe('FileClusterUpdateJobStore.load', () => {
  it('absent is null; content that is not a job is null; an unreadable file throws', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-store-'))
    const store = new FileClusterUpdateJobStore(dir, logger)
    expect(store.load()).toBeNull()

    fs.mkdirSync(path.dirname(store.filePath), { recursive: true })
    fs.writeFileSync(store.filePath, '{not json')
    expect(store.load()).toBeNull()

    // A path that exists but cannot be read as a file: unreadable, not absent.
    fs.rmSync(store.filePath)
    fs.mkdirSync(store.filePath)
    expect(() => store.load()).toThrow()
    expect(CLUSTER_UPDATE_JOB_FILE).toContain('job.json')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
