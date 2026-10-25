/**
 * The retained shelf is AGE-only since D485. This pins the one thing that goes
 * catastrophically wrong when a count bound is removed carelessly:
 * `Array.prototype.slice(undefined)` is a full copy, not an empty one, so an
 * absent `maxEntries` would condemn every fresh entry on the shelf — the whole
 * library, on the very first sweep, silently.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { NcArtifactStore } from './artifact-store.js'

const DAY_MS = 24 * 3600_000

function logger(): IScopedLogger {
  const noop = (): void => undefined
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as IScopedLogger
}

let root: string
let now: number

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-shelf-'))
  // The sweep compares a file's real mtime against this clock, so the two must
  // be the same clock. Age is created by backdating the FILE, not the clock.
  now = Date.now()
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

/** Push every existing file back in time — the only honest way to age a shelf
 *  whose sweep reads mtime from the filesystem. */
async function backdateAll(dir: string, byMs: number): Promise<void> {
  const when = new Date(Date.now() - byMs)
  for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    await fs.utimes(path.join(entry.parentPath, entry.name), when, when)
  }
}

async function store(keptMaxAgeMs: number): Promise<NcArtifactStore> {
  const s = new NcArtifactStore({ rootDir: root, logger: logger(), keptMaxAgeMs, now: () => now })
  await s.start()
  return s
}

describe('the retained shelf, bounded by age alone', () => {
  it('keeps everything inside the window, however many there are', async () => {
    const s = await store(14 * DAY_MS)
    const ids: string[] = []
    // Comfortably more than the 2 000-row bound this shelf used to carry would
    // be too slow to write here; 40 is enough to prove the bound is not a count.
    for (let i = 0; i < 40; i += 1) {
      const a = await s.put(Buffer.from(`artifact-${i}`), 'image/jpeg', { retain: true })
      ids.push(a.id)
    }

    await s.sweep()

    const survivors = await Promise.all(ids.map(async (id) => (await s.read(id)) !== null))
    expect(survivors.every(Boolean), 'nothing inside the window may be swept').toBe(true)
  })

  it('sweeps what falls out of the window, and only that', async () => {
    const s = await store(14 * DAY_MS)
    const old = await s.put(Buffer.from('old'), 'image/jpeg', { retain: true })
    await backdateAll(root, 20 * DAY_MS)
    const fresh = await s.put(Buffer.from('fresh'), 'image/jpeg', { retain: true })

    await s.sweep()

    expect(await s.read(old.id)).toBeNull()
    expect(await s.read(fresh.id)).not.toBeNull()
  })
})
