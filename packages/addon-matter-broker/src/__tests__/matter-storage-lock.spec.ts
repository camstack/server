import { describe, expect, it } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { reclaimStaleFabricLock, type StorageLockFs } from '../matter-storage-lock.js'

function logger(warns: string[]): IScopedLogger {
  const l: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string) => {
      warns.push(message)
    },
    error: () => undefined,
    child: () => l,
    withTags: () => l,
  }
  return l
}

function fakeFs(files: Record<string, string>): { fs: StorageLockFs; removed: string[] } {
  const removed: string[] = []
  return {
    removed,
    fs: {
      readText: async (path) => {
        const value = files[path]
        if (value === undefined) throw new Error('ENOENT')
        return value
      },
      remove: async (path) => {
        removed.push(path)
      },
    },
  }
}

const DIR = '/data/inst-a'
const RUNNER = 'node\0runner.js\0--addon=matter-broker'

describe('reclaimStaleFabricLock', () => {
  it('removes the lock when the recorded pid is a live unrelated process', async () => {
    const warns: string[] = []
    const { fs, removed } = fakeFs({
      [`${DIR}/matter.pid`]: '263 abcd',
      '/proc/268/cmdline': RUNNER,
      '/proc/263/cmdline': 'ffmpeg\0-i\0x',
    })
    const outcome = await reclaimStaleFabricLock({
      fabricDir: DIR,
      brokerId: 'inst-a',
      selfPid: 268,
      logger: logger(warns),
      fs,
    })
    expect(outcome).toBe('removed')
    expect(removed).toEqual([`${DIR}/matter.lock`, `${DIR}/matter.pid`])
    expect(warns).toHaveLength(1)
  })

  it('keeps the lock when the recorded pid is a runner of this addon', async () => {
    const { fs, removed } = fakeFs({
      [`${DIR}/matter.pid`]: '263 abcd',
      '/proc/268/cmdline': RUNNER,
      '/proc/263/cmdline': RUNNER,
    })
    const outcome = await reclaimStaleFabricLock({
      fabricDir: DIR,
      brokerId: 'inst-a',
      selfPid: 268,
      logger: logger([]),
      fs,
    })
    expect(outcome).toBe('kept')
    expect(removed).toEqual([])
  })

  it('deletes nothing where /proc is missing', async () => {
    const { fs, removed } = fakeFs({ [`${DIR}/matter.pid`]: '263 abcd' })
    const outcome = await reclaimStaleFabricLock({
      fabricDir: DIR,
      brokerId: 'inst-a',
      selfPid: 268,
      logger: logger([]),
      fs,
    })
    expect(outcome).toBe('none')
    expect(removed).toEqual([])
  })
})
