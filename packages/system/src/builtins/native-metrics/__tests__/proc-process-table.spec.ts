import { describe, expect, it, vi } from 'vitest'
import type { ProcReader } from '../../../process/proc-stat.js'
import { readProcProcessTable, readProcessTable } from '../proc-process-table.js'

/**
 * The process table native-metrics publishes every cadence used to be a
 * `ps -eo` fork from hub-main — a `fork()` of the largest process on the
 * host, 26 times a minute, p50 91 ms of main thread each (D441, D452). On
 * Linux the same rows are read from `/proc` with no fork at all; `ps` is
 * kept only for a platform without `/proc`.
 */

function statLine(input: {
  pid: number
  comm: string
  ppid: number
  pgid: number
  utime: number
  stime: number
  startTicks: number
}): string {
  const { pid, comm, ppid, pgid, utime, stime, startTicks } = input
  return `${pid} (${comm}) S ${ppid} ${pgid} ${pgid} 0 -1 4194560 100 0 0 0 ${utime} ${stime} 0 0 20 0 12 0 ${startTicks} 999 1000 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0`
}

function fakeReader(): ProcReader {
  const stats = new Map<number, string>([
    [
      7,
      statLine({
        pid: 7,
        comm: 'node',
        ppid: 1,
        pgid: 7,
        utime: 1500,
        stime: 500,
        startTicks: 12345,
      }),
    ],
    [
      42,
      statLine({
        pid: 42,
        comm: 'kworker/0:1',
        ppid: 2,
        pgid: 0,
        utime: 0,
        stime: 3,
        startTicks: 100,
      }),
    ],
    [
      99,
      statLine({
        pid: 99,
        comm: 'some (weird) name',
        ppid: 7,
        pgid: 7,
        utime: 10,
        stime: 0,
        startTicks: 90000,
      }),
    ],
  ])
  const cmdlines = new Map<number, string>([
    [7, 'node\0/app/starter.js\0'],
    [42, ''],
    [99, '/usr/bin/python3\0inference_pool.py\0'],
  ])
  const statuses = new Map<number, string>([
    [7, 'Name:\tnode\nVmRSS:\t 1955504 kB\nRssAnon:\t 1900000 kB\nRssFile:\t 55504 kB\n'],
    [42, 'Name:\tkworker/0:1\n'],
    [99, 'Name:\tpython3\nVmRSS:\t 2048 kB\nRssAnon:\t 1024 kB\nRssFile:\t 1024 kB\n'],
  ])
  const read = (map: ReadonlyMap<number, string>) => async (pid: number) => {
    const value = map.get(pid)
    if (value === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return value
  }
  return {
    // 500 is listed but has no files: it exited between the readdir and the read.
    listPids: async () => [7, 42, 99, 500],
    readStat: read(stats),
    readCmdline: read(cmdlines),
    readStatus: read(statuses),
    readUptimeSec: async () => 1000,
  }
}

describe('readProcProcessTable', () => {
  it('produces the same row `ps -eo pid,ppid,pgid,pcpu,rss,etime,command` did, from /proc', async () => {
    const rows = await readProcProcessTable(fakeReader())
    const hub = rows.find((r) => r.pid === 7)
    expect(hub).toEqual({
      pid: 7,
      ppid: 1,
      pgid: 7,
      // 20 s of CPU over 876.55 s elapsed → 2.3 %, the lifetime average ps prints
      cpuPercent: 2.3,
      memoryRssBytes: 1955504 * 1024,
      uptimeSec: 876,
      command: 'node /app/starter.js',
    })
  })

  it('renders a process with no cmdline as [comm], the way ps does for kernel threads', async () => {
    const rows = await readProcProcessTable(fakeReader())
    const kworker = rows.find((r) => r.pid === 42)
    expect(kworker?.command).toBe('[kworker/0:1]')
    // No VmRSS on a kernel thread: reported as 0 bytes resident, like ps.
    expect(kworker?.memoryRssBytes).toBe(0)
  })

  it('keeps a comm with spaces and parentheses and the fields after it', async () => {
    const rows = await readProcProcessTable(fakeReader())
    const weird = rows.find((r) => r.pid === 99)
    expect(weird?.ppid).toBe(7)
    expect(weird?.command).toBe('/usr/bin/python3 inference_pool.py')
    expect(weird?.uptimeSec).toBe(100)
  })

  it('omits a pid that vanished between the listing and the read — never a partial row', async () => {
    const rows = await readProcProcessTable(fakeReader())
    expect(rows.map((r) => r.pid).sort((a, b) => a - b)).toEqual([7, 42, 99])
  })
})

describe('readProcessTable — which source per platform', () => {
  it('on linux reads /proc and never forks ps', async () => {
    const spawnPs = vi.fn(async () => [])
    const rows = await readProcessTable({ platform: 'linux', reader: fakeReader(), spawnPs })
    expect(spawnPs).not.toHaveBeenCalled()
    expect(rows).toHaveLength(3)
  })

  it('on a platform without /proc forks ps and never touches the reader', async () => {
    const reader = fakeReader()
    const listPids = vi.spyOn(reader, 'listPids')
    const spawnPs = vi.fn(async () => [
      {
        pid: 1,
        ppid: 0,
        pgid: 1,
        cpuPercent: 0.1,
        memoryRssBytes: 4096,
        uptimeSec: 10,
        command: 'launchd',
      },
    ])
    const rows = await readProcessTable({ platform: 'darwin', reader, spawnPs })
    expect(spawnPs).toHaveBeenCalledTimes(1)
    expect(listPids).not.toHaveBeenCalled()
    expect(rows[0]?.command).toBe('launchd')
  })
})
