import { promises as realFs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GridLastFrameFileStore } from '../grid-last-frame-store.js'
import type { GridFrameFs } from '../grid-last-frame-store.js'
import type { GridStreamLogger } from '../grid-stream-session.js'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3])
const NEWER = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 9, 9, 9])

let dataDir = ''

function makeLogger(): GridStreamLogger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

const logger = makeLogger()

beforeEach(async () => {
  dataDir = await realFs.mkdtemp(join(tmpdir(), 'grid-frame-'))
})

afterEach(async () => {
  await realFs.rm(dataDir, { recursive: true, force: true })
})

describe('GridLastFrameFileStore', () => {
  it('reads back what it kept — that is the whole point of surviving a restart', async () => {
    const store = new GridLastFrameFileStore({ dataDir, logger })
    await store.put(4581, JPEG)
    // A SECOND store over the same directory: the value is on disk, not in the
    // object that wrote it. A RAM-only cache is the defect this replaces.
    expect((await new GridLastFrameFileStore({ dataDir, logger }).get(4581))?.equals(JPEG)).toBe(
      true,
    )
  })

  it('answers null for a grid that was never composed — absent is a real answer', async () => {
    expect(await new GridLastFrameFileStore({ dataDir, logger }).get(4581)).toBeNull()
  })

  it('keeps grids apart', async () => {
    const store = new GridLastFrameFileStore({ dataDir, logger })
    await store.put(4581, JPEG)
    expect(await store.get(4582)).toBeNull()
  })

  it('THROTTLES: one recent frame is the value, a newer one is not worth the disk', async () => {
    let now = 1_000_000
    const store = new GridLastFrameFileStore({
      dataDir,
      logger,
      minIntervalMs: 60_000,
      now: () => now,
    })
    await store.put(4581, JPEG)
    await store.put(4581, NEWER)
    expect((await store.get(4581))?.equals(JPEG)).toBe(true)
    now += 60_000
    await store.put(4581, NEWER)
    expect((await store.get(4581))?.equals(NEWER)).toBe(true)
  })

  /**
   * A filesystem that REFUSES everything.
   *
   * This used to be spelled `dataDir: '/proc/definitely-not-writable'`, which
   * is not a fact about the store — it is a fact about the machine. On a
   * developer Mac there is no `/proc`, so `mkdir` answered ENOENT and the test
   * passed for a reason unrelated to what it claims; on the CI runner (Linux,
   * root, in a container) the same call HANGS forever, and the test failed
   * with a 5 s vitest timeout. See `never leaves the caller waiting on the
   * disk` below — that hang was a live defect, not a runner quirk. Told,
   * not simulated (D551).
   */
  function refusingFs(): GridFrameFs {
    const refuse = async (): Promise<never> => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    }
    return { mkdir: refuse, writeFile: refuse, rename: refuse, readFile: refuse }
  }

  it('never throws on a directory it cannot write — persistence is a bonus, not the answer', async () => {
    const store = new GridLastFrameFileStore({ dataDir, logger, fs: refusingFs() })
    await expect(store.put(4581, JPEG)).resolves.toBeUndefined()
    await expect(store.get(4581)).resolves.toBeNull()
  })

  it('never leaves the caller waiting on the disk — a hung filesystem answers, bounded', async () => {
    // Measured, not imagined: on Linux as root (the CI container), `fs.mkdir`
    // with `recursive: true` on a path whose parent exists but cannot hold a
    // directory — procfs answers ENOENT rather than EPERM — never settles.
    // Node's recursive mkdir walks up to the existing parent and retries the
    // child forever. `put` is AWAITED on the grid snapshot answer path
    // (`GridSnapshotSource.keep`), so an unsettled write means the snapshot
    // RPC never answers at all. A `try/catch` does not catch a hang: the bound
    // has to be here.
    const neverSettles = (): Promise<never> => new Promise<never>(() => {})
    const hungFs: GridFrameFs = {
      mkdir: neverSettles,
      writeFile: neverSettles,
      rename: neverSettles,
      readFile: neverSettles,
    }
    const warn = vi.fn()
    const store = new GridLastFrameFileStore({
      dataDir,
      logger: { ...makeLogger(), warn },
      fs: hungFs,
      deadlineMs: 20,
    })
    await expect(store.put(4581, JPEG)).resolves.toBeUndefined()
    await expect(store.get(4581)).resolves.toBeNull()
    // A branch that drops work names it, per camera.
    expect(warn).toHaveBeenCalledTimes(2)
    for (const call of warn.mock.calls) expect(call[1]).toMatchObject({ tags: { deviceId: 4581 } })
  })

  it('refuses to keep an empty buffer — a zero-length frame is not a frame', async () => {
    const store = new GridLastFrameFileStore({ dataDir, logger })
    await store.put(4581, Buffer.alloc(0))
    expect(await store.get(4581)).toBeNull()
  })
})
