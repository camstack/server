/**
 * D898 measurement — a synthetic 1 GB day file (the hub's measured daily
 * volume). Heavy: runs only with `CAMSTACK_HEAVY_SPECS=1`.
 *
 *   CAMSTACK_HEAVY_SPECS=1 npx vitest run \
 *     src/builtins/winston-logging/__tests__/log-file-reader-1gb.heavy.spec.ts
 *
 * Prints: cold index build, first page for a busy device, first page for a
 * rare device (one line per ~50 MB), and a text search slice.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LogFileIndexStore } from '../log-file-index-store.js'
import { CancelBook, serveRead } from '../log-file-read-protocol.js'
import { readLogFilesBackward } from '../log-file-reader.js'
import { row } from './log-file-fixture.js'

const FILE = 'camstack-2026-10-21.log'
const TARGET_BYTES = 1024 * 1024 * 1024
const T0 = Date.parse('2026-10-21T00:00:00.000Z')

let dir: string
const results: Record<string, number> = {}

function report(): void {
  process.stdout.write(`\nD898 1 GB bench: ${JSON.stringify(results, null, 2)}\n`)
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-logbench-'))
  const fd = fs.openSync(path.join(dir, FILE), 'w')
  let written = 0
  let i = 0
  const pad = 'x'.repeat(120)
  while (written < TARGET_BYTES) {
    const lines: string[] = []
    for (let k = 0; k < 10_000; k += 1, i += 1) {
      const rare = i % 170_000 === 0
      lines.push(
        row({
          id: `bench.${String(i)}`,
          ts: T0 + Math.floor(i / 40),
          deviceId: rare ? 2 : 100 + (i % 20),
          addonId: rare ? 'rare-addon' : `addon-${String(i % 12)}`,
          agentId: i % 3 === 0 ? 'agent-1' : 'hub',
          level: i % 97 === 0 ? 'warn' : 'info',
          message: `frame ${String(i)} processed ${pad}`,
        }),
      )
    }
    const chunk = `${lines.join('\n')}\n`
    fs.writeSync(fd, chunk)
    written += Buffer.byteLength(chunk)
  }
  fs.closeSync(fd)
  results['fileBytes'] = written
  results['lines'] = i
}, 600_000)

afterAll(() => {
  report()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('1 GB day file', () => {
  const store = (): LogFileIndexStore => new LogFileIndexStore(dir)

  it('measures a first page with no index at all (nothing skipped)', async () => {
    const t = performance.now()
    const out = await readLogFilesBackward(
      { logsDir: dir, indexOf: async () => null, isCancelled: () => false },
      { deviceId: 105, limit: 200 },
    )
    results['busyFirstPageNoIndexMs'] = Math.round(performance.now() - t)
    expect(out.result.entries).toHaveLength(200)
  }, 600_000)

  it('builds the index and pages a busy and a rare device', async () => {
    const s = store()
    let t = performance.now()
    await s.indexOf(FILE, { wait: true })
    results['indexBuildMs'] = Math.round(performance.now() - t)
    results['indexBytes'] = fs.statSync(path.join(dir, `${FILE}.idx`)).size

    t = performance.now()
    const busy = await serveRead(dir, s, new CancelBook(), { deviceId: 105, limit: 200 })
    results['busyFirstPageMs'] = Math.round(performance.now() - t)
    results['busyScannedBytes'] = busy.result.scannedBytes
    expect(busy.result.entries).toHaveLength(200)

    t = performance.now()
    const rare = await serveRead(dir, s, new CancelBook(), {
      deviceId: 2,
      limit: 200,
      budgetMs: 5000,
    })
    results['rareFirstPageMs'] = Math.round(performance.now() - t)
    results['rareScannedBytes'] = rare.result.scannedBytes
    results['rareFound'] = rare.result.entries.length
    expect(rare.result.done).toBe(true)
    expect(rare.result.entries.length).toBeGreaterThan(10)

    t = performance.now()
    const rareNoIndex = await readLogFilesBackward(
      { logsDir: dir, indexOf: async () => null, isCancelled: () => false },
      { deviceId: 2, limit: 200, budgetMs: 5000 },
    )
    results['rareNoIndex5sSliceMs'] = Math.round(performance.now() - t)
    results['rareNoIndex5sSliceScannedBytes'] = rareNoIndex.result.scannedBytes

    t = performance.now()
    const text = await serveRead(dir, s, new CancelBook(), {
      text: 'frame 12345 ',
      limit: 200,
      budgetMs: 1000,
    })
    results['textSliceMs'] = Math.round(performance.now() - t)
    results['textSliceScannedBytes'] = text.result.scannedBytes
  }, 600_000)
})
