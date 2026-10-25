/**
 * Nothing bounded the number of decode workers alive at once. The spawn gate
 * (`maxConcurrentDecodeSpawns`) releases its permit on the worker's FIRST FRAME,
 * so it rate-limits cold starts and lets the live count grow without limit:
 * measured 1 → 8 workers and ~4 GiB in 8 seconds on a host with no swap.
 */

import type { IScopedLogger, LogExtras } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  DECODE_WORKER_BASELINE_MB,
  decodeWorkerFootprintMb,
  LiveDecodeWorkerAdmission,
  MAX_HELD_FRAME_MB,
} from '../live-worker-admission.js'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface CapturedLine {
  readonly level: LogLevel
  readonly message: string
  readonly extras: LogExtras | undefined
}

function fakeLogger(sink: CapturedLine[]): IScopedLogger {
  const record =
    (level: LogLevel) =>
    (message: string, extras?: LogExtras): void => {
      sink.push({ level, message, extras })
    }
  const logger: IScopedLogger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    withTags: () => logger,
    child: () => logger,
  }
  return logger
}

/** The refusal WARNs on the record — the line D391 requires. */
function refusalWarns(lines: readonly CapturedLine[]): readonly CapturedLine[] {
  return lines.filter((l) => l.level === 'warn' && l.message.includes('REFUSED'))
}

describe('LiveDecodeWorkerAdmission', () => {
  it('admits up to the ceiling and refuses past it — the count STOPS growing', () => {
    const admission = new LiveDecodeWorkerAdmission({ limit: 3, logger: fakeLogger([]) })
    for (let i = 0; i < 3; i += 1) expect(admission.admit(600 + i, 'detect')).not.toBeNull()
    expect(admission.inFlight).toBe(3)
    // The whole point: the 4th camera does not get a worker, and does not queue.
    expect(admission.admit(700, 'detect')).toBeNull()
    expect(admission.inFlight).toBe(3)
  })

  it('a released slot is reusable — a refusal is temporary, not terminal', () => {
    const admission = new LiveDecodeWorkerAdmission({ limit: 1, logger: fakeLogger([]) })
    const held = admission.admit(600, 'detect')
    expect(admission.admit(601, 'motion')).toBeNull()
    held?.release()
    expect(admission.admit(601, 'motion')).not.toBeNull()
  })

  it('release is idempotent — a double teardown must not inflate the budget', () => {
    const admission = new LiveDecodeWorkerAdmission({ limit: 2, logger: fakeLogger([]) })
    const lease = admission.admit(600, 'detect')
    lease?.release()
    lease?.release()
    expect(admission.inFlight).toBe(0)
    admission.admit(601, 'detect')
    admission.admit(602, 'detect')
    expect(admission.admit(603, 'detect')).toBeNull()
  })

  it('REPORTS every refusal, per camera — a silently dropped session reads as “never happened”', () => {
    const lines: CapturedLine[] = []
    const admission = new LiveDecodeWorkerAdmission({ limit: 1, logger: fakeLogger(lines) })
    admission.admit(600, 'detect')
    lines.length = 0
    admission.admit(102, 'detect')

    expect(lines).toHaveLength(1)
    expect(lines[0]!.message).toContain('REFUSED')
    // The numeric deviceId tag is the only way "why is 102 worse than 101?"
    // can be answered from the log.
    expect(lines[0]!.extras).toMatchObject({ tags: { deviceId: 102 } })
  })

  /**
   * D391: a refusal nobody reported reads as "never happened". The
   * once-per-refused-state memory used to be cleared ONLY on admit, so a camera
   * refused and then torn down before it ever got a slot kept its entry — and
   * its next refusal, hours later (a new motion episode), logged at debug.
   */
  it('re-arms the WARN when a parked start is torn down before it was ever admitted (H1)', () => {
    const lines: CapturedLine[] = []
    const admission = new LiveDecodeWorkerAdmission({ limit: 1, logger: fakeLogger(lines) })
    const holder = admission.admit(600, 'detect')

    expect(admission.admit(102, 'detect')).toBeNull()
    expect(refusalWarns(lines)).toHaveLength(1)
    const waiter = admission.slotWaiter(102)
    waiter.wait(() => undefined)
    waiter.leave(false) // torn down while parked, never admitted

    // Hours later: a new start for the same camera, the node still full.
    expect(admission.admit(102, 'detect')).toBeNull()
    expect(refusalWarns(lines)).toHaveLength(2)
    expect(admission.slotWaiters).toBe(0)
    holder?.release()
  })

  it('re-arms the WARN after refuse → admit → a later refusal (D3)', () => {
    const lines: CapturedLine[] = []
    const admission = new LiveDecodeWorkerAdmission({ limit: 1, logger: fakeLogger(lines) })
    const holder = admission.admit(600, 'detect')
    expect(admission.admit(102, 'detect')).toBeNull()
    expect(refusalWarns(lines)).toHaveLength(1)

    holder?.release()
    const own = admission.admit(102, 'detect')
    expect(own).not.toBeNull()
    own?.release()
    const other = admission.admit(600, 'detect')
    // The camera left the refused state and re-entered it: that is news again.
    expect(admission.admit(102, 'detect')).toBeNull()
    expect(refusalWarns(lines)).toHaveLength(2)
    other?.release()
  })

  it('a refusal while STILL refused is debug — the WARN is per state change, not per retry', () => {
    const lines: CapturedLine[] = []
    const admission = new LiveDecodeWorkerAdmission({ limit: 1, logger: fakeLogger(lines) })
    const holder = admission.admit(600, 'detect')
    expect(admission.admit(102, 'detect')).toBeNull()
    expect(admission.admit(102, 'detect')).toBeNull()
    expect(refusalWarns(lines)).toHaveLength(1)
    expect(lines.filter((l) => l.level === 'debug' && l.message.includes('REFUSED'))).toHaveLength(
      1,
    )
    holder?.release()
  })

  it('lowering the ceiling never kills a running session, only stops the next one', () => {
    const admission = new LiveDecodeWorkerAdmission({ limit: 4, logger: fakeLogger([]) })
    const leases = [0, 1, 2, 3].map((i) => admission.admit(600 + i, 'detect'))
    admission.resize(2)
    expect(admission.inFlight).toBe(4) // in-flight sessions keep their frames
    expect(admission.admit(700, 'detect')).toBeNull()
    leases[0]?.release()
    leases[1]?.release()
    expect(admission.inFlight).toBe(2)
    expect(admission.admit(700, 'detect')).toBeNull() // still at the new ceiling
    leases[2]?.release()
    expect(admission.admit(700, 'detect')).not.toBeNull()
  })

  it('never accepts a ceiling of zero — that would refuse every camera forever', () => {
    const admission = new LiveDecodeWorkerAdmission({ limit: 0, logger: fakeLogger([]) })
    expect(admission.admit(600, 'detect')).not.toBeNull()
    const other = new LiveDecodeWorkerAdmission({ limit: 5, logger: fakeLogger([]) })
    other.resize(0)
    expect(other.ceiling).toBe(1)
  })
})

/**
 * The two bounds on decode RAM did not know about each other.
 *
 * `DEFAULT_MAX_LIVE_DECODE_WORKERS = 8` was justified in its own docblock with
 * "a decode worker measures ~320 MB … i.e. ~2.5 GiB", while
 * `DEFAULT_NATIVE_LEASE_SETTINGS` gives every worker a `budgetMb` of 1024 plus
 * `tileBudgetMb` 64, and `native-lease-store.ts` records that on a 4K camera the
 * budget is what binds (`leaseMb:1020, leaseFrames:43`). Three different figures
 * for the same quantity live in this directory: 320 MB here, ~500 MB in this
 * file's own header ("1 → 8 workers and ~4 GiB"), and 650-860 MB measured on the
 * live hub on 2026-08-25 (sampled every 5 s: a worker reaches its plateau in
 * under 10 s — 314 MB @4 s → 649 MB @9 s → 651 MB steady).
 *
 * A count cannot express a RAM bound while the per-worker cost is itself a
 * knob: raise `budgetMb` and the ceiling silently authorises proportionally more
 * memory. So the ceiling is DERIVED from the node's decode budget and the
 * worker footprint, and the hand-set count is only an upper clamp.
 */
describe('admission bounds megabytes, not processes', () => {
  it('derives the ceiling from the node budget when the count would allow more', () => {
    const sink: CapturedLine[] = []
    const admission = new LiveDecodeWorkerAdmission({
      limit: 8,
      logger: fakeLogger(sink),
      nodeBudgetMb: 4096,
      workerFootprintMb: 1438, // 1024 lease + 64 tile + 350 baseline
    })

    expect(admission.ceiling).toBe(2)
    expect(admission.admit(101, 'a')).not.toBeNull()
    expect(admission.admit(616, 'b')).not.toBeNull()
    expect(admission.admit(102, 'c')).toBeNull()
  })

  it('raising the per-worker lease budget lowers the ceiling — the knobs now see each other', () => {
    const admission = new LiveDecodeWorkerAdmission({
      limit: 8,
      logger: fakeLogger([]),
      nodeBudgetMb: 6144,
      workerFootprintMb: 1438,
    })
    expect(admission.ceiling).toBe(4)

    admission.resizeFootprint(2462) // operator moves budgetMb 1024 → 2048
    expect(admission.ceiling).toBe(2)
  })

  it('keeps the hand-set count as an upper clamp when the budget would allow more', () => {
    const admission = new LiveDecodeWorkerAdmission({
      limit: 3,
      logger: fakeLogger([]),
      nodeBudgetMb: 32_768,
      workerFootprintMb: 1438,
    })
    expect(admission.ceiling).toBe(3)
  })

  it('never derives a ceiling of zero — a node too small still decodes one camera', () => {
    const admission = new LiveDecodeWorkerAdmission({
      limit: 8,
      logger: fakeLogger([]),
      nodeBudgetMb: 512,
      workerFootprintMb: 1438,
    })
    expect(admission.ceiling).toBe(1)
    expect(admission.admit(101, 'a')).not.toBeNull()
    expect(admission.admit(616, 'b')).toBeNull()
  })

  it('names the RAM in the refusal, not just the count', () => {
    const sink: CapturedLine[] = []
    const admission = new LiveDecodeWorkerAdmission({
      limit: 8,
      logger: fakeLogger(sink),
      nodeBudgetMb: 1438,
      workerFootprintMb: 1438,
    })
    admission.admit(101, 'a')
    sink.length = 0
    admission.admit(102, 'b')

    const refusal = sink.find((l) => l.message.includes('REFUSED'))
    expect(refusal?.extras?.tags).toEqual({ deviceId: 102 })
    expect(refusal?.extras?.meta).toMatchObject({ committedMb: 1438, budgetMb: 1438 })
  })

  it('defaults to today’s behaviour when no budget is supplied', () => {
    const admission = new LiveDecodeWorkerAdmission({ limit: 8, logger: fakeLogger([]) })
    expect(admission.ceiling).toBe(8)
  })
})

/**
 * The footprint is the ONE place the lease knobs become a RAM number. Computing
 * it anywhere else is how the ceiling drifted from the budget in the first
 * place: two files each held a figure for "what a worker costs" and neither
 * read the settings that actually decide it.
 */
describe('decodeWorkerFootprintMb', () => {
  // The lease store is built with `maxFrames: holdFrames`, so the pixels a
  // worker can hold are bounded by the COUNT as much as by `budgetMb` — and
  // at the shipped defaults the count binds first: 8 × 4K RGB24 (24.9 MB) is
  // ~200 MB, not 1024. Charging the budget knob alone put every node's ceiling
  // at 5 (`floor(8192 / 1438)`) on 2026-08-28, and the Mac agent refused
  // 7,595 decodes in a day while its workers measured `leaseMb` p50 24, max 190.
  const HELD_PIXELS_MB = Math.min(1024, 8 * MAX_HELD_FRAME_MB)

  it('charges what the store can HOLD at the shipped defaults, not the budget knob', () => {
    expect(HELD_PIXELS_MB).toBeLessThan(1024)
    expect(decodeWorkerFootprintMb({})).toBe(HELD_PIXELS_MB + 64 + 48 + DECODE_WORKER_BASELINE_MB)
  })

  it('a bigger budget changes nothing while the frame count still binds', () => {
    expect(decodeWorkerFootprintMb({ budgetMb: 2048 })).toBe(decodeWorkerFootprintMb({}))
  })

  it('follows the knobs that actually move the worst case', () => {
    // More frames than the budget can hold: the budget binds again.
    expect(decodeWorkerFootprintMb({ holdFrames: 64 })).toBe(
      1024 + 64 + 48 + DECODE_WORKER_BASELINE_MB,
    )
    expect(decodeWorkerFootprintMb({ holdFrames: 4 })).toBe(
      4 * MAX_HELD_FRAME_MB + 64 + 48 + DECODE_WORKER_BASELINE_MB,
    )
    expect(decodeWorkerFootprintMb({ tileBudgetMb: 256 })).toBe(
      HELD_PIXELS_MB + 256 + 48 + DECODE_WORKER_BASELINE_MB,
    )
    expect(decodeWorkerFootprintMb({ sceneBudgetMb: 96 })).toBe(
      HELD_PIXELS_MB + 64 + 96 + DECODE_WORKER_BASELINE_MB,
    )
  })

  it('restores eight workers on an 8192 MB node at the shipped defaults', () => {
    const admission = new LiveDecodeWorkerAdmission({
      limit: 8,
      logger: fakeLogger([]),
      nodeBudgetMb: 8192,
      workerFootprintMb: decodeWorkerFootprintMb({}),
    })
    expect(admission.ceiling).toBe(8)
  })
})

/**
 * The queue of starts the ceiling refused. A start's place is fixed when it
 * first parks and kept for the start's whole life: a wake that goes nowhere
 * (the woken start was torn down first) is passed on, and a woken start that
 * is refused again does not go to the back (D652, round 4).
 */
describe('the ceiling queue — FIFO by first park, and no wake is lost', () => {
  it('a woken start refused again keeps its place: the next slot is still its', () => {
    const admission = new LiveDecodeWorkerAdmission({ limit: 1, logger: fakeLogger([]) })
    const holder = admission.admit(1, 'detect')
    const woken: string[] = []
    const a = admission.slotWaiter(11)
    const b = admission.slotWaiter(12)
    a.wait(() => woken.push('a'))
    b.wait(() => woken.push('b'))

    holder?.release()
    expect(woken).toEqual(['a'])
    // Someone else took the slot before A could ask; A is refused and re-parks.
    const thief = admission.admit(99, 'detect')
    expect(admission.admit(11, 'detect')).toBeNull()
    a.wait(() => woken.push('a'))

    thief?.release()
    expect(woken).toEqual(['a', 'a']) // not B — A was parked first
    expect(admission.slotWaiters).toBe(1)
    b.leave(false)
    a.leave(false)
  })

  it('a wake the woken start cannot use is passed to the next parked start', () => {
    const admission = new LiveDecodeWorkerAdmission({ limit: 1, logger: fakeLogger([]) })
    const holder = admission.admit(1, 'detect')
    const woken: string[] = []
    const a = admission.slotWaiter(11)
    const b = admission.slotWaiter(12)
    a.wait(() => woken.push('a'))
    b.wait(() => woken.push('b'))

    holder?.release()
    expect(woken).toEqual(['a'])
    // A is torn down before it could ask — the slot it was handed is free.
    a.leave(true)
    expect(woken).toEqual(['a', 'b'])
    expect(admission.slotWaiters).toBe(0)
    b.leave(false)
  })

  it('cancel (the fallback timer fired) leaves the queue without consuming a wake', () => {
    const admission = new LiveDecodeWorkerAdmission({ limit: 1, logger: fakeLogger([]) })
    const holder = admission.admit(1, 'detect')
    const woken: string[] = []
    const a = admission.slotWaiter(11)
    const b = admission.slotWaiter(12)
    a.wait(() => woken.push('a'))
    b.wait(() => woken.push('b'))
    a.cancel()
    expect(admission.slotWaiters).toBe(1)
    holder?.release()
    expect(woken).toEqual(['b'])
    a.leave(false)
    b.leave(false)
  })
})
