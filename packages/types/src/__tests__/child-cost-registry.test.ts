/**
 * Every assertion here is about a way the contribution could report a
 * plausible WRONG number: a claim that outlives its process, a late release
 * that deletes a live one, a zero standing in for "unknown".
 */
import { describe, expect, it } from 'vitest'
import {
  ChildCostRegistry,
  parseProcCpuSeconds,
  parseProcRssBytes,
  type ProcStatReader,
} from '../process/child-cost-registry.js'

/** A `/proc/<pid>/stat` line with utime/stime where the kernel puts them. */
function statLine(comm: string, utime: number, stime: number): string {
  const tail = [
    'S', // 3  state    → idx 0
    '1', // 4  ppid
    '1', // 5  pgrp
    '1', // 6  session
    '0', // 7  tty_nr
    '-1', // 8 tpgid
    '4194304', // 9 flags
    '0', // 10 minflt
    '0', // 11 cminflt
    '0', // 12 majflt
    '0', // 13 cmajflt
    String(utime), // 14 utime → idx 11
    String(stime), // 15 stime → idx 12
  ]
  return `4242 (${comm}) ${tail.join(' ')}\n`
}

/** A `/proc/<pid>/statm` line — field 2 is the resident set, in pages. */
function statmLine(residentPages: number): string {
  return `50000 ${residentPages} 900 10 0 4000 0\n`
}

function readerFor(
  pids: ReadonlyMap<number, { cpuTicks: number; rssPages: number }>,
): ProcStatReader {
  return {
    readStat: async (pid) => {
      const e = pids.get(pid)
      if (e === undefined) throw new Error('ENOENT')
      return statLine('ffmpeg', e.cpuTicks, 0)
    },
    readStatm: async (pid) => {
      const e = pids.get(pid)
      if (e === undefined) throw new Error('ENOENT')
      return statmLine(e.rssPages)
    },
  }
}

const DEAD_PROC: ProcStatReader = {
  readStat: async () => {
    throw new Error('ENOENT')
  },
  readStatm: async () => {
    throw new Error('ENOENT')
  },
}

describe('parseProcCpuSeconds', () => {
  it('reads past a comm containing spaces AND parentheses', () => {
    // The cut is at the LAST ')': splitting on whitespace would shift every
    // field and silently read two different numbers as the CPU.
    expect(parseProcCpuSeconds(statLine('weird (name) here', 150, 50))).toBe(2)
  })

  it('returns null — never 0 — for a truncated line', () => {
    expect(parseProcCpuSeconds('4242 (ffmpeg) S')).toBeNull()
    expect(parseProcCpuSeconds('')).toBeNull()
  })
})

describe('parseProcRssBytes', () => {
  it('converts resident PAGES to bytes', () => {
    expect(parseProcRssBytes(statmLine(1000))).toBe(1000 * 4096)
  })

  it('returns null for a line that does not parse', () => {
    expect(parseProcRssBytes('')).toBeNull()
  })
})

describe('ChildCostRegistry', () => {
  it('reports a claimed child with the camera the spawn site named', async () => {
    const registry = new ChildCostRegistry(
      readerFor(new Map([[900, { cpuTicks: 1234, rssPages: 2000 }]])),
      () => 1_700_000_000_000,
    )
    registry.claim({ role: 'recording', deviceId: 101, unit: '101/high', pid: 900 })

    expect(await registry.contributions()).toEqual([
      {
        role: 'recording',
        deviceId: 101,
        attribution: 'measured',
        unit: '101/high',
        pid: 900,
        startedAtMs: 1_700_000_000_000,
        cpuSeconds: 12.34,
        rssBytes: 2000 * 4096,
      },
    ])
  })

  it('OMITS the numbers it cannot read — never zero', async () => {
    // macOS, a userns without /proc, or a child that died between the claim
    // and the read. A zero here would say "this camera cost nothing", which is
    // a measurement nobody made.
    const registry = new ChildCostRegistry(DEAD_PROC, () => 1)
    registry.claim({ role: 'transcode', deviceId: 102, unit: '102/native', pid: 901 })

    const [entry] = await registry.contributions()
    expect(entry).toBeDefined()
    expect(entry).not.toHaveProperty('cpuSeconds')
    expect(entry).not.toHaveProperty('rssBytes')
    // The unit itself is still reported: the addon believes it is running, and
    // hiding it would make a dying writer look like one never started.
    expect(entry?.deviceId).toBe(102)
  })

  it('stops reporting a child the moment its claim is released', async () => {
    const registry = new ChildCostRegistry(
      readerFor(new Map([[902, { cpuTicks: 10, rssPages: 1 }]])),
    )
    const claim = registry.claim({ role: 'decode', deviceId: 4, unit: '4/decode', pid: 902 })
    expect(await registry.contributions()).toHaveLength(1)

    claim.release()
    expect(await registry.contributions()).toEqual([])
    // Releasing twice is safe — teardown paths overlap by design.
    claim.release()
    expect(await registry.contributions()).toEqual([])
  })

  it('a LATE release cannot delete the live claim on a recycled pid', async () => {
    // The failure this shape exists to make impossible. Camera 101's ffmpeg
    // dies; the pid is reused by camera 102's; 101's teardown then fires. With
    // a `release(pid)` API that late call would delete 102's claim and 102
    // would silently stop being reported. A handle can only remove its own.
    const registry = new ChildCostRegistry(
      readerFor(new Map([[903, { cpuTicks: 10, rssPages: 1 }]])),
    )
    const dying = registry.claim({ role: 'recording', deviceId: 101, unit: '101/high', pid: 903 })
    const reborn = registry.claim({ role: 'recording', deviceId: 102, unit: '102/high', pid: 903 })

    dying.release()

    const entries = await registry.contributions()
    expect(entries.map((e) => e.deviceId)).toEqual([102])
    expect(reborn).toBeDefined()
  })

  it('refuses to claim without a pid — an entry with no numbers is not a cost', async () => {
    // A failed spawn has no pid. Claiming it anyway would put a camera on the
    // chart with nothing behind it, which reads as "this camera is free".
    const registry = new ChildCostRegistry(DEAD_PROC)
    registry.claim({ role: 'streaming', deviceId: 9, unit: '9/native', pid: undefined })
    expect(registry.list()).toEqual([])
    expect(await registry.contributions()).toEqual([])
  })

  it('carries an explicit `unattributable` through untouched', async () => {
    // The shared-pool shape: a cost that is REPORTED and declares that it
    // belongs to no camera. `deviceId: null` is the declaration, not a gap.
    const registry = new ChildCostRegistry(
      readerFor(new Map([[904, { cpuTicks: 500, rssPages: 3 }]])),
    )
    registry.claim({
      role: 'detection',
      deviceId: null,
      unit: 'inference pool cuda:0',
      attribution: 'unattributable',
      pid: 904,
    })
    const [entry] = await registry.contributions()
    expect(entry?.attribution).toBe('unattributable')
    expect(entry?.deviceId).toBeNull()
  })
})
