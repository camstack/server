import { describe, it, expect } from 'vitest'
import {
  DEFAULT_POOL_MEMORY_POLICY,
  PoolMemoryWatchdog,
  commitWatchdogRestart,
  evaluatePoolMemory,
  initialPoolMemoryState,
  parseProcStatus,
  pickRestartCandidate,
  resolvePoolMemoryPolicy,
  type PoolMemoryPolicy,
  type PoolMemoryTelemetry,
} from '../utils/pool-memory-watchdog.js'
import type { IScopedLogger } from '../interfaces/logging.js'

const MB = 1024 * 1024

/** Policy with small, exact numbers so every branch is arithmetic-checkable. */
const testPolicy: PoolMemoryPolicy = {
  sampleIntervalMs: 60_000,
  baselineSettleSamples: 2,
  baselineSampleCount: 3,
  restartMultiple: 4,
  floorBytes: 1000 * MB,
  ceilingBytes: 3000 * MB,
  cooldownMs: 30 * 60_000,
  maxRestartsPerWindow: 2,
  restartWindowMs: 24 * 60 * 60_000,
}

/** Feed `rss` samples in order; returns the final state. */
function feed(rssSamples: readonly number[], policy: PoolMemoryPolicy = testPolicy) {
  let state = initialPoolMemoryState()
  let lastVerdict = evaluatePoolMemory(state, rssSamples[0]!, 0, policy)
  state = lastVerdict.state
  for (let i = 1; i < rssSamples.length; i++) {
    lastVerdict = evaluatePoolMemory(state, rssSamples[i]!, i * 60_000, policy)
    state = lastVerdict.state
  }
  return lastVerdict
}

describe('parseProcStatus', () => {
  it('extracts VmRSS / VmSize / VmHWM / VmSwap / Threads in bytes', () => {
    const text = [
      'Name:\tMainThread',
      'VmSize:\t11283312 kB',
      'VmHWM:\t 8788572 kB',
      'VmRSS:\t 8700000 kB',
      'VmSwap:\t       0 kB',
      'Threads:\t42',
    ].join('\n')
    const parsed = parseProcStatus(text)
    expect(parsed).not.toBeNull()
    expect(parsed!.rssBytes).toBe(8700000 * 1024)
    expect(parsed!.vmBytes).toBe(11283312 * 1024)
    expect(parsed!.hwmBytes).toBe(8788572 * 1024)
    expect(parsed!.swapBytes).toBe(0)
    expect(parsed!.threads).toBe(42)
  })

  it('returns null when VmRSS is absent (kernel thread / bad read)', () => {
    expect(parseProcStatus('Name:\tkthreadd\nThreads:\t1')).toBeNull()
  })
})

describe('evaluatePoolMemory — baseline capture', () => {
  it('has no baseline until settle + window samples have been seen', () => {
    const v = feed([100 * MB, 100 * MB, 100 * MB, 100 * MB]) // 2 settle + 2 of 3 window
    expect(v.baselineBytes).toBeNull()
    expect(v.action).toBe('baseline-pending')
  })

  it('baseline is the median of the post-settle window', () => {
    // settle: 500, 400 (ignored) — window: 90, 200, 110 → median 110
    const v = feed([500 * MB, 400 * MB, 90 * MB, 200 * MB, 110 * MB])
    expect(v.baselineBytes).toBe(110 * MB)
  })

  it('the ceiling still bounds a pool that ramps before its baseline exists', () => {
    const v = feed([100 * MB, 3200 * MB]) // second sample over the 3000MB ceiling, mid-settle
    expect(v.action).toBe('restart')
    expect(v.thresholdBytes).toBe(testPolicy.ceilingBytes)
  })
})

describe('evaluatePoolMemory — threshold shape', () => {
  const settled = (baselineMb: number, rssMb: number) =>
    feed([
      baselineMb * MB, // settle
      baselineMb * MB, // settle
      baselineMb * MB,
      baselineMb * MB,
      baselineMb * MB, // window → baseline = baselineMb
      rssMb * MB,
    ])

  it('small baseline → floor wins (multiple would flap on legitimate growth)', () => {
    const v = settled(100, 900) // 4×100MB = 400MB < floor 1000MB
    expect(v.thresholdBytes).toBe(testPolicy.floorBytes)
    expect(v.action).toBe('ok')
  })

  it('mid baseline → multiple wins', () => {
    const v = settled(400, 1500) // 4×400 = 1600MB, floor 1000, ceiling 3000
    expect(v.thresholdBytes).toBe(1600 * MB)
    expect(v.action).toBe('ok')
  })

  it('large baseline → ceiling wins', () => {
    const v = settled(1000, 2900) // 4×1000 = 4000 > ceiling 3000
    expect(v.thresholdBytes).toBe(testPolicy.ceilingBytes)
    expect(v.action).toBe('ok')
  })

  it('crossing the threshold yields restart', () => {
    const v = settled(400, 1700) // over the 1600MB threshold
    expect(v.action).toBe('restart')
  })
})

describe('evaluatePoolMemory — cooldown and restart budget', () => {
  it('a crossing inside the cooldown window reports cooldown, not restart', () => {
    let state = initialPoolMemoryState()
    state = commitWatchdogRestart(state, 1_000_000)
    const v = evaluatePoolMemory(state, 3200 * MB, 1_000_000 + 60_000, testPolicy)
    expect(v.action).toBe('cooldown')
  })

  it('exhausts after maxRestartsPerWindow restarts inside the window', () => {
    let state = initialPoolMemoryState()
    state = commitWatchdogRestart(state, 0)
    state = commitWatchdogRestart(state, 60 * 60_000)
    const v = evaluatePoolMemory(state, 3200 * MB, 2 * 60 * 60_000, testPolicy)
    expect(v.action).toBe('exhausted')
  })

  it('restarts outside the window no longer count against the budget', () => {
    let state = initialPoolMemoryState()
    state = commitWatchdogRestart(state, 0)
    state = commitWatchdogRestart(state, 60_000)
    const later = testPolicy.restartWindowMs + 2 * 60_000
    const v = evaluatePoolMemory(state, 3200 * MB, later, testPolicy)
    expect(v.action).toBe('restart')
  })

  it('commitWatchdogRestart resets the baseline for the fresh process', () => {
    const settledState = feed([100 * MB, 100 * MB, 100 * MB, 100 * MB, 100 * MB]).state
    expect(settledState.baselineBytes).not.toBeNull()
    const after = commitWatchdogRestart(settledState, 5 * 60_000)
    expect(after.baselineBytes).toBeNull()
    expect(after.restartsAt).toHaveLength(1)
  })
})

describe('pickRestartCandidate — staggering', () => {
  it('picks the worst overage ratio', () => {
    const picked = pickRestartCandidate([
      { key: 'openvino:gpu', rssBytes: 1700 * MB, thresholdBytes: 1600 * MB },
      { key: 'default', rssBytes: 4000 * MB, thresholdBytes: 1600 * MB },
    ])
    expect(picked).toBe('default')
  })

  it('returns null for no candidates', () => {
    expect(pickRestartCandidate([])).toBeNull()
  })
})

describe('resolvePoolMemoryPolicy — env overrides', () => {
  it('returns defaults for an empty env', () => {
    expect(resolvePoolMemoryPolicy({})).toEqual(DEFAULT_POOL_MEMORY_POLICY)
  })

  it('applies numeric overrides and ignores garbage', () => {
    const p = resolvePoolMemoryPolicy({
      CAMSTACK_POOL_MEM_FLOOR_MB: '2048',
      CAMSTACK_POOL_MEM_CEILING_MB: '4096',
      CAMSTACK_POOL_MEM_MULTIPLE: '3',
      CAMSTACK_POOL_MEM_INTERVAL_MS: 'not-a-number',
    })
    expect(p.floorBytes).toBe(2048 * MB)
    expect(p.ceilingBytes).toBe(4096 * MB)
    expect(p.restartMultiple).toBe(3)
    expect(p.sampleIntervalMs).toBe(DEFAULT_POOL_MEMORY_POLICY.sampleIntervalMs)
  })
})

// ---------------------------------------------------------------------------
// PoolMemoryWatchdog — the sweep loop (fake sample/restart/log, manual sweeps)
// ---------------------------------------------------------------------------

interface LogLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly extras: Record<string, unknown> | undefined
}

function makeLogger(lines: LogLine[]): IScopedLogger {
  const push =
    (level: LogLine['level']) =>
    (message: string, extras?: Record<string, unknown>): void => {
      lines.push({ level, message, extras })
    }
  const logger: IScopedLogger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function telemetry(
  key: string,
  rssMb: number,
  pids: readonly number[] = [100],
): PoolMemoryTelemetry {
  return { key, pids, rssBytes: rssMb * MB, meta: { runtime: 'openvino' } }
}

async function settleWatchdog(dog: PoolMemoryWatchdog, sweeps: number): Promise<void> {
  for (let i = 0; i < sweeps; i++) await dog.sweep()
}

describe('PoolMemoryWatchdog', () => {
  function build(overrides?: {
    sample?: () => Promise<readonly PoolMemoryTelemetry[]>
    restart?: (key: string) => Promise<void>
    policy?: PoolMemoryPolicy
  }) {
    const lines: LogLine[] = []
    const restarts: string[] = []
    let now = 0
    const dog = new PoolMemoryWatchdog({
      policy: overrides?.policy ?? testPolicy,
      sample: overrides?.sample ?? (async () => [telemetry('default', 100)]),
      restart:
        overrides?.restart ??
        (async (key: string) => {
          restarts.push(key)
        }),
      log: makeLogger(lines),
      now: () => now,
    })
    return { dog, lines, restarts, advance: (ms: number) => (now += ms) }
  }

  it('logs one info line per pool per sweep', async () => {
    const pools = [telemetry('default', 100), telemetry('openvino:gpu', 150)]
    const { dog, lines } = build({ sample: async () => pools })
    await dog.sweep()
    const memLines = lines.filter((l) => l.message === 'pool memory')
    expect(memLines).toHaveLength(2)
    const meta = memLines[0]!.extras?.['meta'] as Record<string, unknown>
    expect(meta['poolKey']).toBe('default')
    expect(meta['rssMb']).toBe(100)
    expect(meta['runtime']).toBe('openvino')
  })

  it('restarts at most ONE pool per sweep even when several cross', async () => {
    // Both pools instantly over the ceiling (baseline pending → ceiling bounds).
    const pools = [telemetry('a', 3200, [1]), telemetry('b', 4000, [2])]
    const { dog, restarts, advance } = build({ sample: async () => pools })
    await dog.sweep()
    expect(restarts).toEqual(['b']) // worst ratio first
    advance(60_000)
    await dog.sweep()
    expect(restarts).toEqual(['b', 'a']) // the survivor goes on the NEXT sweep
  })

  it('a pid change outside the watchdog resets the baseline and logs it', async () => {
    let pids: readonly number[] = [100]
    const { dog, lines, advance } = build({
      sample: async () => [telemetry('default', 100, pids)],
    })
    await settleWatchdog(dog, 5) // settle 2 + window 3 → baseline exists
    pids = [200] // process replaced behind our back (kernel OOM kill + respawn)
    advance(60_000)
    await dog.sweep()
    const warn = lines.find((l) => l.message.includes('pool process changed'))
    expect(warn).toBeDefined()
    expect(warn!.level).toBe('warn')
  })

  it('a failed restart is logged as error and not committed', async () => {
    const { dog, lines } = build({
      sample: async () => [telemetry('a', 4000)],
      restart: async () => {
        throw new Error('dispose blew up')
      },
    })
    await dog.sweep()
    const err = lines.find((l) => l.message.includes('restart failed'))
    expect(err).toBeDefined()
    expect(err!.level).toBe('error')
  })

  it('an exhausted pool logs an error and is never restarted again in-window', async () => {
    const { dog, lines, restarts, advance } = build({
      sample: async () => [telemetry('a', 4000)],
      policy: { ...testPolicy, cooldownMs: 0, maxRestartsPerWindow: 1 },
    })
    await dog.sweep() // restart #1
    advance(60_000)
    await dog.sweep() // budget exhausted
    expect(restarts).toEqual(['a'])
    const err = lines.find((l) => l.message.includes('watchdog gave up'))
    expect(err).toBeDefined()
    expect(err!.level).toBe('error')
  })

  it('a failing sample() logs the dropped sweep instead of staying silent', async () => {
    const { dog, lines } = build({
      sample: async () => {
        throw new Error('proc read failed')
      },
    })
    await dog.sweep()
    const warn = lines.find((l) => l.message.includes('sweep failed'))
    expect(warn).toBeDefined()
  })

  it('restart is loud: warn line carries rss, threshold and restart count', async () => {
    const { dog, lines } = build({ sample: async () => [telemetry('a', 4000)] })
    await dog.sweep()
    const warn = lines.find((l) => l.message.includes('restarting pool'))
    expect(warn).toBeDefined()
    const meta = warn!.extras?.['meta'] as Record<string, unknown>
    expect(meta['poolKey']).toBe('a')
    expect(meta['rssMb']).toBe(4000)
    expect(meta['thresholdMb']).toBe(3000)
    expect(meta['restartsInWindow']).toBe(1)
  })
})
