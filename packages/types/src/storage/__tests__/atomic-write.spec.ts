/** See `atomic-write.ts`. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeFileAtomic } from '../atomic-write.js'

/** Two complete, distinguishable payloads; each is a whole "JPEG" (SOI…EOI). */
function payload(fill: number, size: number): Buffer {
  const b = Buffer.alloc(size, fill)
  b[0] = 0xff
  b[1] = 0xd8
  b[size - 2] = 0xff
  b[size - 1] = 0xd9
  return b
}

describe('writeFileAtomic — a reader never sees a half-written file', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'atomic-write-'))
  })
  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true })
  })

  it('every concurrent read is one of the complete payloads, never a torn one', async () => {
    // A fixed-path single-instance kind (`lastFrame`, `lastSceneFrame`) is
    // overwritten every roll while a notification may be reading it. A plain
    // `writeFile` truncates first and writes in chunks, so a reader in between
    // gets a prefix — a JPEG with no end marker, or zero bytes.
    const size = 4 * 1024 * 1024
    const a = payload(0x11, size)
    const b = payload(0x22, size)
    const target = path.join(dir, 'lastSceneFrame.jpg')
    await writeFileAtomic(target, a)
    let writing = true
    const writer = (async () => {
      for (let i = 0; i < 30; i += 1) await writeFileAtomic(target, i % 2 === 0 ? b : a)
      writing = false
    })()
    const torn: number[] = []
    let reads = 0
    while (writing) {
      const got = await fs.promises.readFile(target)
      reads += 1
      if (!(got.equals(a) || got.equals(b))) torn.push(got.length)
    }
    await writer
    expect(reads).toBeGreaterThan(0)
    expect(torn).toEqual([])
  })

  it('leaves no temp file behind, on success or on failure', async () => {
    const target = path.join(dir, 'x.jpg')
    await writeFileAtomic(target, payload(0x33, 1024))
    expect(await fs.promises.readdir(dir)).toEqual(['x.jpg'])
    // A target that is a DIRECTORY makes the rename fail after the temp landed.
    const blocked = path.join(dir, 'blocked')
    await fs.promises.mkdir(path.join(blocked, 'child'), { recursive: true })
    await expect(writeFileAtomic(blocked, payload(0x44, 1024))).rejects.toThrow()
    expect((await fs.promises.readdir(dir)).toSorted()).toEqual(['blocked', 'x.jpg'])
  })
})
