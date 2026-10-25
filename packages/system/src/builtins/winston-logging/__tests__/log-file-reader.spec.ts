/**
 * D898 — paging the rotated log files through their sidecar index.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LogReadEntry, LogReadQuery } from '@camstack/types'
import { decodeFileCursor, encodeFileCursor } from '../log-file-cursor.js'
import { BLOCK_BYTES, extractLineFacts, indexPathOf, loadFileIndex } from '../log-file-index.js'
import { LogFileIndexStore } from '../log-file-index-store.js'
import { CancelBook, serveRead } from '../log-file-read-protocol.js'
import { readLogFilesBackward, type FileReadOutcome } from '../log-file-reader.js'
import { appendRows, busyRows, row, writeRows } from './log-file-fixture.js'

const DAY1 = 'camstack-2026-10-20.log'
const DAY2 = 'camstack-2026-10-21.log'
const T1 = Date.parse('2026-10-20T08:00:00.000Z')
const T2 = Date.parse('2026-10-21T08:00:00.000Z')

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-logread-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

async function read(
  query: LogReadQuery,
  store = new LogFileIndexStore(dir),
): Promise<FileReadOutcome> {
  return serveRead(dir, store, new CancelBook(), query)
}

/** Walk every page backward and return the entries in order. */
async function readAll(query: LogReadQuery): Promise<LogReadEntry[]> {
  const store = new LogFileIndexStore(dir)
  const out: LogReadEntry[] = []
  let before: string | undefined
  for (let guard = 0; guard < 10_000; guard += 1) {
    const page = await read({ ...query, ...(before !== undefined ? { before } : {}) }, store)
    out.push(...page.result.entries)
    if (page.result.nextBefore === null) break
    before = page.result.nextBefore
  }
  return out
}

describe('line facts — read off the raw text, a superset of the truth', () => {
  it('reads level, the LAST-key timestamp (not meta.timestamp) and every device/addon/node', () => {
    const facts = extractLineFacts(
      row({
        id: 'a.1',
        ts: T1,
        level: 'warn',
        deviceId: 101,
        addonId: 'provider-x@1.2.3',
        agentId: 'agent-a',
        meta: { timestamp: '1999-01-01T00:00:00.000Z', deviceId: 7 },
      }),
    )
    expect(facts.ts).toBe(T1)
    expect(facts.level).toBe(2)
    expect(facts.deviceIds.toSorted()).toEqual([101, 7].toSorted())
    expect(facts.addonIds).toEqual(['provider-x'])
    expect(facts.nodes).toEqual(['agent-a'])
  })
})

describe('the sidecar index', () => {
  it('tiles the file in ~1 MiB blocks on line boundaries and persists completed blocks', async () => {
    const file = writeRows(
      dir,
      DAY2,
      busyRows({ n: 12_000, startTs: T2, prefix: 'b', deviceId: 1 }),
    )
    const store = new LogFileIndexStore(dir)
    const index = await store.indexOf(DAY2, { wait: true })
    expect(index).not.toBeNull()
    const blocks = index?.blocks ?? []
    expect(blocks.length).toBeGreaterThanOrEqual(3)
    expect(blocks[0]?.s).toBe(0)
    const content = fs.readFileSync(file)
    for (let i = 0; i < blocks.length; i += 1) {
      const b = blocks[i]
      expect(b?.e).toBeGreaterThanOrEqual((b?.s ?? 0) + BLOCK_BYTES)
      expect(content[(b?.e ?? 1) - 1]).toBe(0x0a)
      if (i > 0) expect(b?.s).toBe(blocks[i - 1]?.e)
    }
    const stat = fs.statSync(file)
    const reloaded = await loadFileIndex(file, stat.ino, stat.size)
    expect(reloaded.rewrite).toBe(false)
    expect(reloaded.index.blocks).toEqual(blocks)
  })

  it('discards a torn or foreign sidecar and rebuilds the same blocks', async () => {
    const file = writeRows(dir, DAY2, busyRows({ n: 8000, startTs: T2, prefix: 'b', deviceId: 1 }))
    const built = (await new LogFileIndexStore(dir).indexOf(DAY2, { wait: true }))?.blocks ?? []
    const lines = fs.readFileSync(indexPathOf(file), 'utf8').split('\n')
    fs.writeFileSync(indexPathOf(file), `${lines.slice(0, 2).join('\n')}\n{"s":not json\n`)
    const stat = fs.statSync(file)
    const torn = await loadFileIndex(file, stat.ino, stat.size)
    expect(torn.rewrite).toBe(true)
    expect(torn.index.blocks).toHaveLength(1)
    const rebuilt = (await new LogFileIndexStore(dir).indexOf(DAY2, { wait: true }))?.blocks ?? []
    expect(rebuilt).toEqual(built)
    // Another inode (the file was replaced) ⇒ start over.
    expect((await loadFileIndex(file, stat.ino + 1, stat.size)).index.blocks).toHaveLength(0)
  })
})

describe('reading backward', () => {
  it('never reads a block whose index excludes the device', async () => {
    const rows = busyRows({ n: 12_000, startTs: T2, prefix: 'b', deviceId: 1 })
    rows.splice(6000, 0, { id: 'rare.1', ts: T2 + 6000, deviceId: 2, message: 'the rare line' })
    writeRows(dir, DAY2, rows)
    const store = new LogFileIndexStore(dir)
    const blocks = (await store.indexOf(DAY2, { wait: true }))?.blocks ?? []
    const out = await read({ deviceId: 2, limit: 50 }, store)
    expect(out.result.entries.map((e) => e.message)).toEqual(['the rare line'])
    // One block holds device 2; every other block is skipped unread, and the
    // only line parsed is the match itself.
    expect(out.stats.blocksRead).toBe(1)
    expect(out.stats.blocksSkipped).toBe(blocks.length - 1)
    expect(out.stats.linesParsed).toBe(1)
    expect(out.result.done).toBe(true)
  })

  it('pages across files and days, newest first, with no gap and no duplicate', async () => {
    writeRows(dir, DAY1, busyRows({ n: 700, startTs: T1, prefix: 'd1', deviceId: 3 }))
    writeRows(dir, DAY2, busyRows({ n: 900, startTs: T2, prefix: 'd2', deviceId: 3 }))
    const all = await readAll({ deviceId: 3, limit: 37 })
    const ids = all.map((e) => e.id)
    expect(ids).toHaveLength(1600)
    expect(new Set(ids).size).toBe(1600)
    expect(ids[0]).toBe('d2.899')
    expect(ids[899]).toBe('d2.0')
    expect(ids[900]).toBe('d1.699')
    expect(ids.at(-1)).toBe('d1.0')
  })

  it('a cursor still means the same lines after the file grew', async () => {
    const file = writeRows(dir, DAY2, busyRows({ n: 500, startTs: T2, prefix: 'g', deviceId: 4 }))
    const first = await read({ limit: 100 })
    expect(first.result.entries[0]?.id).toBe('g.499')
    const before = first.result.nextBefore ?? ''
    const expected = await read({ limit: 100, before })
    appendRows(file, busyRows({ n: 300, startTs: T2 + 10_000, prefix: 'late', deviceId: 4 }))
    const after = await read({ limit: 100, before })
    expect(after.result.entries.map((e) => e.id)).toEqual(expected.result.entries.map((e) => e.id))
    expect(after.result.entries[0]?.id).toBe('g.399')
  })

  it('applies level, text, addon and node filters before the limit', async () => {
    writeRows(dir, DAY2, [
      { id: 'f.1', ts: T2, level: 'debug', message: 'quiet', addonId: 'a1', agentId: 'hub' },
      {
        id: 'f.2',
        ts: T2 + 1,
        level: 'error',
        message: 'Disk FULL on /data',
        addonId: 'a1',
        agentId: 'hub',
      },
      {
        id: 'f.3',
        ts: T2 + 2,
        level: 'warn',
        message: 'full moon',
        addonId: 'a2@3.0.0',
        agentId: 'agent-1',
      },
      ...busyRows({ n: 3000, startTs: T2 + 10, prefix: 'noise', deviceId: 9 }),
    ])
    const ids = async (q: LogReadQuery): Promise<Array<string | undefined>> =>
      (await read({ limit: 10, ...q })).result.entries.map((e) => e.id)
    expect(await ids({ level: 'warn' })).toEqual(['f.3', 'f.2'])
    expect(await ids({ text: 'full' })).toEqual(['f.3', 'f.2'])
    expect(await ids({ fromAddonId: 'a2' })).toEqual(['f.3'])
    expect(await ids({ fromNodeId: 'agent-1' })).toEqual(['f.3'])
    expect(await ids({ fromAddonId: 'a1', level: 'error', text: 'disk' })).toEqual(['f.2'])
  })

  it('stops at the budget with a cursor that resumes exactly', async () => {
    const rows = busyRows({ n: 12_000, startTs: T2, prefix: 'b', deviceId: 1 })
    for (const at of [11_000, 7000, 3000, 10])
      rows[at] = { ...rows[at]!, message: `needle ${String(at)}` }
    writeRows(dir, DAY2, rows)
    const store = new LogFileIndexStore(dir)
    await store.indexOf(DAY2, { wait: true })
    const whole = await read({ text: 'needle', limit: 50 }, store)
    expect(whole.result.entries).toHaveLength(4)
    let clock = 0
    const ctx = {
      logsDir: dir,
      indexOf: (f: string) => store.indexOf(f),
      isCancelled: () => false,
      // Every clock read advances 600 ms: a 1 s budget ends after one chunk.
      now: () => (clock += 600),
    }
    const found: LogReadEntry[] = []
    let before: string | undefined
    let slices = 0
    let scanned = 0
    for (;;) {
      const slice = await readLogFilesBackward(ctx, {
        text: 'needle',
        budgetMs: 1000,
        limit: 50,
        ...(before !== undefined ? { before } : {}),
      })
      slices += 1
      scanned += slice.result.scannedBytes
      found.push(...slice.result.entries)
      if (slice.result.done) break
      expect(slice.result.nextBefore).not.toBeNull()
      before = slice.result.nextBefore ?? undefined
    }
    expect(slices).toBeGreaterThan(2)
    expect(found.map((e) => e.id)).toEqual(whole.result.entries.map((e) => e.id))
    // Each resume re-reads at most the one line that straddled the stop.
    const size = fs.statSync(path.join(dir, DAY2)).size
    expect(scanned).toBeGreaterThanOrEqual(size)
    expect(scanned).toBeLessThan(size + slices * 1000)
  })

  it('cancellation ends a slice and says so', async () => {
    writeRows(dir, DAY2, busyRows({ n: 12_000, startTs: T2, prefix: 'b', deviceId: 1 }))
    const store = new LogFileIndexStore(dir)
    const cancels = new CancelBook()
    cancels.cancel('req-1')
    const out = await serveRead(dir, store, cancels, {
      requestId: 'req-1',
      text: 'nothing matches this',
    })
    expect(out.result.cancelled).toBe(true)
    expect(out.result.done).toBe(false)
    expect(out.result.nextBefore).not.toBeNull()
    expect(out.result.scannedBytes).toBeLessThan(fs.statSync(path.join(dir, DAY2)).size)
    // The book is settled: the same id reads normally afterwards.
    expect(cancels.isCancelled('req-1')).toBe(false)
  })

  it('refuses a cursor it did not mint', async () => {
    writeRows(dir, DAY2, busyRows({ n: 10, startTs: T2, prefix: 'b', deviceId: 1 }))
    expect(
      decodeFileCursor('w1.' + Buffer.from('{"f":"../../etc/passwd","o":0}').toString('base64url')),
    ).toBeNull()
    expect(decodeFileCursor(encodeFileCursor({ f: DAY2, o: 5 }))).toEqual({ f: DAY2, o: 5 })
  })

  it('reads forward from nextAfter to what arrived since', async () => {
    const file = writeRows(dir, DAY2, busyRows({ n: 50, startTs: T2, prefix: 'p', deviceId: 5 }))
    const first = await read({ limit: 10 })
    appendRows(file, busyRows({ n: 3, startTs: T2 + 1000, prefix: 'new', deviceId: 5 }))
    const fwd = await read({ limit: 10, after: first.result.nextAfter ?? '' })
    expect(fwd.result.entries.map((e) => e.id)).toEqual(['new.2', 'new.1', 'new.0'])
  })
})
