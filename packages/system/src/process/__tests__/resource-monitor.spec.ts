import { describe, expect, it, vi } from 'vitest'
import type { ProcReader } from '../proc-stat.js'
import { getPidStats } from '../resource-monitor.js'

/**
 * `getPidStats` answers `$process.list`, `getAddonStats` and the hub's own
 * runner census. It used to be one `ps -p` fork per call — from hub-main,
 * which is the process whose fork is the most expensive on the host (D452).
 * On Linux every number `ps` printed is in `/proc/<pid>/stat` and
 * `/proc/<pid>/status`; the fork is kept only where `/proc` does not exist.
 */

const statFor = (pid: number, ticks: number, startTicks: number) =>
  `${pid} (node) S 1 ${pid} ${pid} 0 -1 4194560 100 0 0 0 ${ticks} 0 0 0 20 0 12 0 ${startTicks} 999 1000 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0`

function fakeReader(): ProcReader {
  const stats = new Map<number, string>([
    [7, statFor(7, 2000, 12345)],
    [31, statFor(31, 10, 90000)],
  ])
  const statuses = new Map<number, string>([
    [7, 'VmRSS:\t 1955504 kB\nRssAnon:\t 1900000 kB\nRssFile:\t 55504 kB\n'],
    [31, 'VmRSS:\t 4096 kB\nRssAnon:\t 3072 kB\nRssFile:\t 1024 kB\n'],
  ])
  const read = (map: ReadonlyMap<number, string>) => async (pid: number) => {
    const value = map.get(pid)
    if (value === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return value
  }
  return {
    listPids: async () => [7, 31],
    readStat: read(stats),
    readCmdline: async () => '',
    readStatus: read(statuses),
    readUptimeSec: async () => 1000,
  }
}

describe('getPidStats on linux', () => {
  it('reads cpu, rss, private and shared bytes from /proc and never forks', async () => {
    const spawnPs = vi.fn(async () => '')
    const stats = await getPidStats([7, 31, 500], {
      platform: 'linux',
      reader: fakeReader(),
      spawnPs,
    })
    expect(spawnPs).not.toHaveBeenCalled()
    expect(stats.get(7)).toEqual({
      cpu: 2.3,
      memory: 1955504 * 1024,
      privateBytes: 1900000 * 1024,
      sharedBytes: 55504 * 1024,
    })
    expect(stats.get(31)?.cpu).toBe(0.1)
  })

  it('omits a dead pid rather than answering zeros for it', async () => {
    const stats = await getPidStats([500], {
      platform: 'linux',
      reader: fakeReader(),
      spawnPs: async () => '',
    })
    expect(stats.size).toBe(0)
  })

  it('answers an empty ask with an empty map and reads nothing', async () => {
    const reader = fakeReader()
    const readStat = vi.spyOn(reader, 'readStat')
    const stats = await getPidStats([], { platform: 'linux', reader, spawnPs: async () => '' })
    expect(stats.size).toBe(0)
    expect(readStat).not.toHaveBeenCalled()
  })
})

describe('getPidStats without /proc', () => {
  it('forks ps -p for the asked pids and parses its output', async () => {
    const spawnPs = vi.fn(async () => '  7  2.3 1955504\n 31  0.1    4096\n')
    const reader = fakeReader()
    const readStat = vi.spyOn(reader, 'readStat')
    const stats = await getPidStats([7, 31], { platform: 'darwin', reader, spawnPs })
    expect(spawnPs).toHaveBeenCalledWith([7, 31])
    expect(readStat).not.toHaveBeenCalled()
    expect(stats.get(7)).toEqual({ cpu: 2.3, memory: 1955504 * 1024 })
  })
})
