/**
 * D898 — the winston destination reads back what it wrote, through its real
 * reader THREAD, with the line's id intact.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LogReadResult } from '@camstack/types'
import { LogManager } from '../../../logging/log-manager.js'
import { WinstonDestination } from '../winston-destination.js'

const WORKER = fileURLToPath(new URL('../log-file-read-worker.ts', import.meta.url))

let dir: string
let dest: WinstonDestination
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-winston-read-'))
  dest = new WinstonDestination({
    workerPath: WORKER,
    workerExecArgv: ['--import', 'tsx'],
    backgroundPassMs: 0,
  })
  await dest.initialize({ level: 'info', retentionDays: 30, logsDir: dir })
})
afterEach(async () => {
  await dest.shutdown()
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function eventually(
  read: () => Promise<LogReadResult>,
  ok: (r: LogReadResult) => boolean,
): Promise<LogReadResult> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const result = await read()
    if (ok(result) || Date.now() > deadline) return result
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('WinstonDestination — history read (D898)', () => {
  it('says it can read, with every filter server-side', async () => {
    const caps = await dest.describeRead()
    expect(caps.readable).toBe(true)
    expect(Object.values(caps.filters).every(Boolean)).toBe(true)
    expect(caps.retentionDays).toBe(30)
  })

  it('reads its own lines back through the thread, newest first, ids intact', async () => {
    const mgr = new LogManager()
    mgr.addDestination(dest, { replay: false, addonId: 'winston-logging' })
    const log = mgr.createLogger('cam')
    log.info('first', { tags: { deviceId: 101, addonId: 'provider-x' } })
    log.info('noise', { tags: { deviceId: 1 } })
    log.warn('second', { tags: { deviceId: 101, addonId: 'provider-x' } })
    const live = mgr.query({}).map((e) => e.id)

    const page = await eventually(
      () => dest.read({ deviceId: 101, limit: 10 }),
      (r) => r.entries.length === 2,
    )
    expect(page.entries.map((e) => e.message)).toEqual(['second', 'first'])
    expect(page.entries[0]?.tags?.['deviceId']).toBe(101)
    for (const entry of page.entries) expect(live).toContain(entry.id)
    expect(page.done).toBe(true)
  })
})
