/**
 * The footgun this suite exists to keep closed: `eventMedia:default`,
 * `recordingsLow:default` and `recordings:default` share `/recordings`.
 * Wiping events or low must leave `high/` (and everything else) on disk.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveClassDir, wipeClassSubtrees } from '../location-class-wipe.js'

const planted = new Set<string>()

afterEach(() => {
  for (const dir of planted) rmSync(dir, { recursive: true, force: true })
  planted.clear()
})

function plantTree(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'class-wipe-'))
  planted.add(root)
  for (const cam of ['104', '101']) {
    for (const cls of ['events', 'high', 'mid', 'low']) {
      const dir = path.join(root, cam, cls, '2026', '01')
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, `${cls}.bin`), cls)
    }
  }
  return root
}

function exists(root: string, rel: string): boolean {
  try {
    readFileSync(path.join(root, rel))
    return true
  } catch {
    return false
  }
}

describe('resolveClassDir', () => {
  it('refuses a camera id that would walk out of the root', () => {
    expect(() => resolveClassDir('/recordings', '..', 'events')).toThrow(/illegal camera/)
    expect(() => resolveClassDir('/recordings', '104', '../high')).toThrow(/illegal subtree/)
  })

  it('resolves exactly <root>/<camera>/<subtree>', () => {
    expect(resolveClassDir('/recordings', '104', 'events')).toBe(
      path.resolve('/recordings/104/events'),
    )
  })
})

describe('wipeClassSubtrees', () => {
  it('eventMedia removes events/ and leaves high, mid, and low', async () => {
    const root = plantTree()
    const result = await wipeClassSubtrees({
      root,
      type: 'eventMedia',
      stop: () => false,
      onProgress: () => undefined,
    })
    expect(result.cancelled).toBe(false)
    expect(result.foldersRemoved).toBe(2)
    expect(exists(root, '104/events/2026/01/events.bin')).toBe(false)
    expect(exists(root, '104/high/2026/01/high.bin')).toBe(true)
    expect(exists(root, '104/mid/2026/01/mid.bin')).toBe(true)
    expect(exists(root, '104/low/2026/01/low.bin')).toBe(true)
    expect(exists(root, '101/high/2026/01/high.bin')).toBe(true)
  })

  it('recordingsLow removes low/ and leaves high, mid, and events', async () => {
    const root = plantTree()
    await wipeClassSubtrees({
      root,
      type: 'recordingsLow',
      stop: () => false,
      onProgress: () => undefined,
    })
    expect(exists(root, '104/low/2026/01/low.bin')).toBe(false)
    expect(exists(root, '104/high/2026/01/high.bin')).toBe(true)
    expect(exists(root, '104/events/2026/01/events.bin')).toBe(true)
  })

  it('recordings removes high/ and mid/ and leaves low and events', async () => {
    const root = plantTree()
    await wipeClassSubtrees({
      root,
      type: 'recordings',
      stop: () => false,
      onProgress: () => undefined,
    })
    expect(exists(root, '104/high/2026/01/high.bin')).toBe(false)
    expect(exists(root, '104/mid/2026/01/mid.bin')).toBe(false)
    expect(exists(root, '104/low/2026/01/low.bin')).toBe(true)
    expect(exists(root, '104/events/2026/01/events.bin')).toBe(true)
  })

  it('refuses a class directory that is a symlink (would follow into high)', async () => {
    const root = plantTree()
    rmSync(path.join(root, '104', 'events'), { recursive: true, force: true })
    symlinkSync(path.join(root, '104', 'high'), path.join(root, '104', 'events'))
    await expect(
      wipeClassSubtrees({
        root,
        type: 'eventMedia',
        stop: () => false,
        onProgress: () => undefined,
      }),
    ).rejects.toThrow(/symlink/)
    expect(exists(root, '104/high/2026/01/high.bin')).toBe(true)
  })

  it('stops between cameras when cancel is requested', async () => {
    const root = plantTree()
    let seen = 0
    const result = await wipeClassSubtrees({
      root,
      type: 'eventMedia',
      stop: () => seen >= 1,
      onProgress: () => {
        seen += 1
      },
    })
    expect(result.cancelled).toBe(true)
    expect(result.camerasDone).toBe(1)
    const remaining =
      Number(exists(root, '104/events/2026/01/events.bin')) +
      Number(exists(root, '101/events/2026/01/events.bin'))
    expect(remaining).toBe(1)
    expect(exists(root, '104/high/2026/01/high.bin')).toBe(true)
    expect(exists(root, '101/high/2026/01/high.bin')).toBe(true)
  })
})
