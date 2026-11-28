import { describe, expect, it } from 'vitest'
import type { IScopedLogger } from '@dominevo/types'
import {
  prepareFabricStorage,
  reclaimStaleFabricLock,
  recordFabricOwner,
  startTicksOf,
  type StorageLockFs,
} from '../matter-storage-lock.js'

interface LogLine {
  readonly level: string
  readonly message: string
}

function logger(lines: LogLine[]): IScopedLogger {
  const at =
    (level: string) =>
    (message: string): void => {
      lines.push({ level, message })
    }
  const l: IScopedLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => l,
    withTags: () => l,
  }
  return l
}

function fakeFs(
  files: Record<string, string>,
  mtimes: Record<string, number> = {},
): {
  fs: StorageLockFs
  removed: string[]
  written: Record<string, string>
} {
  const removed: string[] = []
  const written: Record<string, string> = {}
  return {
    removed,
    written,
    fs: {
      readText: async (path) => {
        const value = written[path] ?? files[path]
        if (value === undefined) throw new Error('ENOENT')
        return value
      },
      writeText: async (path, content) => {
        written[path] = content
      },
      mtimeMs: async (path) => {
        const value = mtimes[path]
        if (value === undefined) throw new Error('ENOENT')
        return value
      },
      remove: async (path) => {
        removed.push(path)
      },
    },
  }
}

/** A `/proc/<pid>/stat` line: field 22 is the start time; the comm holds spaces and parentheses. */
function stat(pid: number, startTicks: string): string {
  // fields 3..21 (19 values) then field 22
  const between = Array.from({ length: 19 }, () => '0')
  return `${pid} (node (runner)) ${between.join(' ')} ${startTicks} 0 0`
}

const DIR = '/data/inst-a'
const BOOT = 'boot-1'
const owner = (pid: number, startTicks: string, bootId = BOOT): string =>
  JSON.stringify({ pid, startTicks, bootId })

const base = {
  fabricDir: DIR,
  brokerId: 'inst-a',
  selfPid: 268,
}

describe('startTicksOf', () => {
  it('reads field 22 past a command name with spaces and parentheses', () => {
    expect(startTicksOf(stat(263, '98765'))).toBe('98765')
  })
})

describe('reclaimStaleFabricLock', () => {
  it('reclaims a lock whose pid is now ANOTHER runner with the very same command line', async () => {
    const lines: LogLine[] = []
    const { fs, removed } = fakeFs({
      [`${DIR}/matter.pid`]: '263 abcd',
      [`${DIR}/camstack-owner.json`]: owner(263, '1000'),
      '/proc/263/stat': stat(263, '5555'),
      '/proc/263/cmdline': 'node\0runner.js',
      '/proc/sys/kernel/random/boot_id': `${BOOT}\n`,
    })
    const outcome = await reclaimStaleFabricLock({
      ...base,
      logger: logger(lines),
      fs,
    })
    expect(outcome).toBe('removed')
    expect(removed).toEqual([`${DIR}/matter.lock`, `${DIR}/matter.pid`])
    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(1)
  })

  it('reclaims a lock written before the last boot, even when pid and start time collide', async () => {
    const { fs, removed } = fakeFs({
      [`${DIR}/matter.pid`]: '263 abcd',
      [`${DIR}/camstack-owner.json`]: owner(263, '1000', 'boot-0'),
      '/proc/263/stat': stat(263, '1000'),
      '/proc/sys/kernel/random/boot_id': BOOT,
    })
    expect(await reclaimStaleFabricLock({ ...base, logger: logger([]), fs })).toBe('removed')
    expect(removed).toHaveLength(2)
  })

  // No owner record: boot time 1_000 s, a tick is 10 ms, so start 5000 ticks = 1_050 s.
  const unrecorded = (lockMtimeMs: number) =>
    fakeFs(
      {
        [`${DIR}/matter.pid`]: '263 abcd',
        '/proc/263/stat': stat(263, '5000'),
        '/proc/268/stat': stat(268, '9000'),
        '/proc/stat': 'cpu 1 2 3\nbtime 1000\n',
        '/proc/sys/kernel/random/boot_id': BOOT,
      },
      { [`${DIR}/matter.pid`]: lockMtimeMs },
    )

  it('no record: a live pid that started AFTER the lock was written cannot be its writer', async () => {
    const { fs, removed } = unrecorded(1_040_000)
    expect(await reclaimStaleFabricLock({ ...base, logger: logger([]), fs })).toBe('removed')
    expect(removed).toHaveLength(2)
  })

  it('no record: a live pid that started BEFORE the lock was written is kept, with a warning', async () => {
    const lines: LogLine[] = []
    const { fs, removed } = unrecorded(1_060_000)
    expect(await reclaimStaleFabricLock({ ...base, logger: logger(lines), fs })).toBe('kept')
    expect(removed).toEqual([])
    expect(lines.some((l) => l.level === 'warn')).toBe(true)
  })

  it('no record: a dead pid is left to matter.js, which takes a dead owner over', async () => {
    const { fs, removed } = fakeFs({
      [`${DIR}/matter.pid`]: '263 abcd',
      '/proc/268/stat': stat(268, '9000'),
      '/proc/sys/kernel/random/boot_id': BOOT,
    })
    expect(await reclaimStaleFabricLock({ ...base, logger: logger([]), fs })).toBe('none')
    expect(removed).toEqual([])
  })

  it('keeps the lock when the recorded owner is the same live process, and says so', async () => {
    const lines: LogLine[] = []
    const { fs, removed } = fakeFs({
      [`${DIR}/matter.pid`]: '263 abcd',
      [`${DIR}/camstack-owner.json`]: owner(263, '1000'),
      '/proc/263/stat': stat(263, '1000'),
      '/proc/sys/kernel/random/boot_id': BOOT,
    })
    expect(await reclaimStaleFabricLock({ ...base, logger: logger(lines), fs })).toBe('kept')
    expect(removed).toEqual([])
    expect(lines.some((l) => l.message.includes('kept'))).toBe(true)
  })

  it('deletes nothing where /proc is missing, and logs that it did not judge', async () => {
    const lines: LogLine[] = []
    const { fs, removed } = fakeFs({ [`${DIR}/matter.pid`]: '263 abcd' })
    expect(await reclaimStaleFabricLock({ ...base, logger: logger(lines), fs })).toBe('none')
    expect(removed).toEqual([])
    expect(lines.some((l) => l.level === 'info')).toBe(true)
  })
})

describe('recordFabricOwner', () => {
  it('writes the pid, start time and boot id of this process beside the lock', async () => {
    const { fs, written } = fakeFs({
      '/proc/268/stat': stat(268, '4242'),
      '/proc/sys/kernel/random/boot_id': BOOT,
    })
    await recordFabricOwner({ ...base, logger: logger([]), fs })
    expect(JSON.parse(written[`${DIR}/camstack-owner.json`] ?? 'null')).toEqual({
      pid: 268,
      startTicks: '4242',
      bootId: BOOT,
    })
  })

  it('round trip: a lock this process recorded is kept by the next reader while it lives', async () => {
    const { fs, removed } = fakeFs({
      [`${DIR}/matter.pid`]: '268 abcd',
      '/proc/268/stat': stat(268, '4242'),
      '/proc/sys/kernel/random/boot_id': BOOT,
    })
    await recordFabricOwner({ ...base, selfPid: 268, logger: logger([]), fs })
    const outcome = await reclaimStaleFabricLock({
      ...base,
      selfPid: 300,
      logger: logger([]),
      fs,
    })
    expect(outcome).toBe('kept')
    expect(removed).toEqual([])
  })
})

describe('prepareFabricStorage', () => {
  it('a kept lock throws and leaves the live owner record untouched', async () => {
    const { fs, written } = fakeFs({
      [`${DIR}/matter.pid`]: '263 abcd',
      [`${DIR}/camstack-owner.json`]: owner(263, '1000'),
      '/proc/263/stat': stat(263, '1000'),
      '/proc/268/stat': stat(268, '9000'),
      '/proc/sys/kernel/random/boot_id': BOOT,
    })
    await expect(prepareFabricStorage({ ...base, logger: logger([]), fs })).rejects.toThrow(
      'held by another live process',
    )
    expect(written).toEqual({})
  })

  it('a free storage records this process as its owner', async () => {
    const { fs, written } = fakeFs({
      '/proc/268/stat': stat(268, '9000'),
      '/proc/sys/kernel/random/boot_id': BOOT,
    })
    await prepareFabricStorage({ ...base, logger: logger([]), fs })
    expect(Object.keys(written)).toEqual([`${DIR}/camstack-owner.json`])
  })
})
