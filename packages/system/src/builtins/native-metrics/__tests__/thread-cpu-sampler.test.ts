/**
 * The CPU split is the number that rewrote the 2026-08-27 diagnosis, so every
 * assertion here is about a way it could report a plausible WRONG value:
 * a mis-parsed `comm`, a recycled pid, a zero standing in for "unknown".
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ThreadCpuTracker,
  cpuSplitBetween,
  parseThreadStat,
  readThreadTicks,
  type ProcFsReader,
  type ThreadTickSample,
} from '../thread-cpu-sampler.js'

/**
 * Build a `/proc/<pid>/task/<tid>/stat` line with the fields we read.
 *
 * `startTicks` is field 22, so the tail has to run out to index 19 after the
 * `)` cut — the four trailing fields (`cutime`, `cstime`, `priority`, `nice`,
 * `num_threads`, `itrealvalue`) exist here only to put `starttime` in its real
 * position. Getting that offset wrong is exactly the class of bug the
 * cut-at-last-`)` parse exists to prevent, so the fixture spells it out.
 */
function statLine(comm: string, utime: number, stime: number, startTicks = 777): string {
  // pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt
  // cmajflt utime stime …  — 'state' is index 0 after the ')' cut.
  const before = `1234 (${comm}) `
  const after = [
    'S', // 3  state              → idx 0
    '1', // 4  ppid               → idx 1
    '1', // 5  pgrp               → idx 2
    '1', // 6  session            → idx 3
    '0', // 7  tty_nr             → idx 4
    '-1', // 8  tpgid             → idx 5
    '4194304', // 9  flags        → idx 6
    '0', // 10 minflt             → idx 7
    '0', // 11 cminflt            → idx 8
    '0', // 12 majflt             → idx 9
    '0', // 13 cmajflt            → idx 10
    String(utime), // 14 utime    → idx 11
    String(stime), // 15 stime    → idx 12
    '0', // 16 cutime             → idx 13
    '0', // 17 cstime             → idx 14
    '20', // 18 priority          → idx 15
    '0', // 19 nice               → idx 16
    '4', // 20 num_threads        → idx 17
    '0', // 21 itrealvalue        → idx 18
    String(startTicks), // 22 starttime → idx 19
  ]
  return `${before}${after.join(' ')}\n`
}

describe('parseThreadStat', () => {
  it('reads utime+stime past a comm containing spaces AND parentheses', () => {
    // The whole reason the parse cuts at the LAST ')': splitting on
    // whitespace would shift every field and silently read the wrong two.
    const parsed = parseThreadStat(statLine('weird (name) here', 40, 2))
    expect(parsed).toEqual({ comm: 'weird (name) here', ticks: 42, startTicks: 777 })
  })

  it('reads a plain V8 helper thread', () => {
    expect(parseThreadStat(statLine('V8Worker', 100, 5))).toEqual({
      comm: 'V8Worker',
      ticks: 105,
      startTicks: 777,
    })
  })

  it('returns null for a truncated line — a thread that exited mid-read', () => {
    expect(parseThreadStat('1234 (node) S')).toBeNull()
    expect(parseThreadStat('')).toBeNull()
  })
})

describe('readThreadTicks', () => {
  function reader(threads: ReadonlyMap<string, string>): ProcFsReader {
    return {
      listTaskIds: async () => [...threads.keys()],
      readTaskStat: async (_pid, tid) => {
        const line = threads.get(tid)
        if (line === undefined) throw new Error('ESRCH')
        return line
      },
    }
  }

  it('separates the V8 helper pool from the process own threads', async () => {
    const sample = await readThreadTicks(
      7,
      reader(
        new Map([
          ['7', statLine('node', 300, 0)],
          ['8', statLine('V8Worker', 100, 0)],
          ['9', statLine('V8Worker', 150, 0)],
          ['10', statLine('node', 20, 30)],
        ]),
      ),
    )
    expect(sample?.mainTicks).toBe(350)
    expect(sample?.gcTicks).toBe(250)
    expect(sample?.threadCount).toBe(4)
  })

  it('returns null — not a zeroed sample — when /proc/<pid>/task is unreadable', async () => {
    const sample = await readThreadTicks(7, {
      listTaskIds: async () => {
        throw new Error('ENOENT') // macOS, or the process exited
      },
      readTaskStat: async () => '',
    })
    expect(sample).toBeNull()
  })

  it('takes the process identity from the MAIN thread, whose tid is the pid', async () => {
    const sample = await readThreadTicks(
      7,
      reader(
        new Map([
          ['7', statLine('node', 10, 0, 4242)],
          // A worker thread started later. Its own `starttime` is larger and
          // must NOT be what identifies the process, or a process that merely
          // spawned a thread would look recycled on the next tick.
          ['8', statLine('V8Worker', 5, 0, 9999)],
        ]),
      ),
    )
    expect(sample?.startTicks).toBe(4242)
  })

  it('reports UNKNOWN identity when the main thread cannot be read', async () => {
    const sample = await readThreadTicks(7, {
      listTaskIds: async () => ['7', '8'],
      readTaskStat: async (_pid, tid) => {
        if (tid === '7') throw new Error('ESRCH')
        return statLine('V8Worker', 5, 0, 9999)
      },
    })
    // The ticks are still counted — dropping the whole sample would be a
    // bigger error — but the sample cannot vouch for WHICH process they are.
    expect(sample?.gcTicks).toBe(5)
    expect(sample?.startTicks).toBeNull()
  })

  it('skips a thread that exits between the readdir and the read', async () => {
    const sample = await readThreadTicks(7, {
      listTaskIds: async () => ['7', '8'],
      readTaskStat: async (_pid, tid) => {
        if (tid === '8') throw new Error('ESRCH')
        return statLine('node', 10, 0)
      },
    })
    expect(sample?.mainTicks).toBe(10)
    expect(sample?.threadCount).toBe(1)
  })
})

describe('cpuSplitBetween', () => {
  const at = (ms: number, main: number, gc: number, startTicks = 777): ThreadTickSample => ({
    mainTicks: main,
    gcTicks: gc,
    threadCount: 4,
    atMs: ms,
    startTicks,
  })

  it('turns a tick delta into an instantaneous percentage of one core', () => {
    // 20 s window = 2000 jiffies at 100 Hz. 2000 main ticks = one core busy.
    const split = cpuSplitBetween(at(0, 0, 0), at(20_000, 2000, 1000))
    expect(split).toEqual({ mainPercent: 100, gcPercent: 50, threadCount: 4 })
  })

  it('reports the GC share the load ledger measured, not a merged total', () => {
    // hub-main on 2026-08-27: main 50.2%, V8 pool 138.4% — the whole point is
    // that a single total (188.7%) reads as "busy" instead of "allocating".
    const split = cpuSplitBetween(at(0, 0, 0), at(60_000, 3012, 8304))
    expect(split?.mainPercent).toBeCloseTo(50.2, 1)
    expect(split?.gcPercent).toBeCloseTo(138.4, 1)
  })

  it('returns null when a tick count went BACKWARDS — the pid was recycled', () => {
    expect(cpuSplitBetween(at(0, 5000, 3000), at(20_000, 10, 5))).toBeNull()
    expect(cpuSplitBetween(at(0, 0, 3000), at(20_000, 100, 5))).toBeNull()
  })

  it('returns null when there is no window to divide by', () => {
    expect(cpuSplitBetween(at(1000, 0, 0), at(1000, 10, 10))).toBeNull()
    expect(cpuSplitBetween(at(2000, 0, 0), at(1000, 10, 10))).toBeNull()
  })

  it('refuses a RECYCLED pid whose replacement is BUSIER — the case ticks miss', () => {
    // The backwards-tick check only fires when the new process has burned
    // FEWER ticks. An ffmpeg that has been transcoding for a minute inheriting
    // the pid of one that idled produces a large POSITIVE delta that divides
    // cleanly and renders as a spike — one camera charged for another
    // camera's whole life. Only `starttime` catches this direction.
    const before = at(0, 100, 10, 777)
    const afterRecycle = at(20_000, 6000, 400, 999)
    expect(cpuSplitBetween(before, afterRecycle)).toBeNull()
    // Same numbers, same incarnation ⇒ a real rate. Without this the test
    // above would pass on a function that always returns null.
    expect(cpuSplitBetween(before, at(20_000, 6000, 400, 777))).not.toBeNull()
  })

  it('refuses a window whose identity is UNKNOWN on either side', () => {
    // `null` startTicks = the main thread's stat could not be read. Unknown
    // identity is not "probably the same process": the honest answer is a gap.
    expect(
      cpuSplitBetween(at(0, 0, 0, 777), { ...at(20_000, 200, 0), startTicks: null }),
    ).toBeNull()
    expect(
      cpuSplitBetween({ ...at(0, 0, 0), startTicks: null }, at(20_000, 200, 0, 777)),
    ).toBeNull()
  })
})

describe('ThreadCpuTracker', () => {
  function fixedReader(ticksByPid: ReadonlyMap<number, readonly [number, number]>): ProcFsReader {
    return {
      // The MAIN thread's tid IS the pid — that is where `readThreadTicks`
      // takes the process's `starttime` from, so a fake that never emits it
      // would leave every sample identity-less and every split null.
      listTaskIds: async (pid) =>
        ticksByPid.has(pid) ? [String(pid), 'x'] : Promise.reject(new Error()),
      readTaskStat: async (pid, tid) => {
        const entry = ticksByPid.get(pid)
        if (entry === undefined) throw new Error('ESRCH')
        return tid === String(pid)
          ? statLine('node', entry[0], 0)
          : statLine('V8Worker', entry[1], 0)
      },
    }
  }

  it('has NO answer on the first tick, and a rate on the second', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const tracker = new ThreadCpuTracker(fixedReader(new Map([[7, [0, 0]]])))
      expect((await tracker.sample([7])).size).toBe(0)

      vi.setSystemTime(20_000)
      const out = await tracker.sample([7])
      // Same reader ⇒ same tick counts ⇒ a genuine 0% over the window. The
      // point is that the ENTRY now exists; the first tick had none at all.
      expect(out.has(7)).toBe(true)
      expect(out.get(7)?.mainPercent).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a pid that stops appearing, so the map cannot grow without bound', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const tracker = new ThreadCpuTracker(fixedReader(new Map([[7, [0, 0]]])))
      await tracker.sample([7])
      vi.setSystemTime(20_000)
      // Ask about a different pid only — 7 must be forgotten…
      await tracker.sample([8])
      vi.setSystemTime(40_000)
      // …so asking for 7 again yields no answer, exactly as on a first sight.
      expect((await tracker.sample([7])).size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
