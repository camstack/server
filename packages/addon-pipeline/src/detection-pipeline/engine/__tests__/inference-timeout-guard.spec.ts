import { describe, expect, it } from 'vitest'
import {
  evaluateTimeoutRegression,
  recordTimeoutBucket,
  TIMEOUT_GUARD_BUCKET_MS,
  type TimeoutLedger,
} from '../inference-timeout-guard.js'

/**
 * Server 1.2.218 reintroduced the GPU inference timeouts 1.2.216 had fixed —
 * ~3 760 an hour for 4 h 19 min (16 215 `inference request timed out`) — and
 * nothing said so; 1.2.219 fixed it again by accident of the next deploy. The
 * rate per hour is what the audit measured, so it is what the guard compares:
 * the last hour of the PREVIOUS fingerprint against the first quarter hour
 * of the new one.
 */
const H = 60 * 60_000
const T0 = 1_000 * H

function ledger(
  version: string,
  timeoutsPerBucket: readonly number[],
  startAt = T0,
): TimeoutLedger {
  let at = startAt
  let l: TimeoutLedger = { version, buckets: [] }
  for (const t of timeoutsPerBucket) {
    at += TIMEOUT_GUARD_BUCKET_MS
    l = recordTimeoutBucket(l, { at, timeouts: t })
  }
  return l
}

describe('recordTimeoutBucket', () => {
  it('keeps the last hour of buckets and drops the rest', () => {
    const l = ledger(
      'a',
      Array.from({ length: 20 }, () => 1),
    )
    expect(l.buckets).toHaveLength(12)
  })
})

describe('evaluateTimeoutRegression', () => {
  it('names a regression when the new fingerprint times out 5× more, above the floor', () => {
    // 1.2.216-ish: ~10/h across the last hour (12 buckets of 5 min).
    const previous = ledger(
      'server@1.2.217',
      Array.from({ length: 12 }, () => 1),
    )
    // 1.2.218-ish: ~100/min = 500 per 5-min bucket.
    const current = ledger('server@1.2.218', [500, 480, 510])
    const v = evaluateTimeoutRegression({ previous, current })
    expect(v.kind).toBe('regressed')
    expect(v.previousPerHour).toBeCloseTo(12, 0)
    expect(v.currentPerHour).toBeCloseTo(5960, -1)
  })

  it('is not comparable before a quarter hour of the new fingerprint', () => {
    const previous = ledger(
      'a',
      Array.from({ length: 12 }, () => 1),
    )
    const current = ledger('b', [500, 500])
    expect(evaluateTimeoutRegression({ previous, current }).kind).toBe('not-comparable')
  })

  it('is not comparable when the fingerprint did not change — a restart is not an update', () => {
    const previous = ledger(
      'a',
      Array.from({ length: 12 }, () => 1),
    )
    const current = ledger('a', [500, 500, 500])
    expect(evaluateTimeoutRegression({ previous, current }).kind).toBe('not-comparable')
  })

  it('stays quiet under the absolute floor — 0 → 3 an hour is noise, not a regression', () => {
    const previous = ledger(
      'a',
      Array.from({ length: 12 }, () => 0),
    )
    const current = ledger('b', [1, 0, 0])
    expect(evaluateTimeoutRegression({ previous, current }).kind).toBe('quiet')
  })

  it('stays quiet when the rate merely doubled with traffic', () => {
    const previous = ledger(
      'a',
      Array.from({ length: 12 }, () => 10),
    )
    const current = ledger('b', [20, 20, 20])
    expect(evaluateTimeoutRegression({ previous, current }).kind).toBe('quiet')
  })

  it('reports an improvement when the new fingerprint times out 5× less', () => {
    const previous = ledger(
      'a',
      Array.from({ length: 12 }, () => 500),
    )
    const current = ledger('b', [1, 2, 1])
    expect(evaluateTimeoutRegression({ previous, current }).kind).toBe('improved')
  })
})

// ── Runtime wrapper ───────────────────────────────────────────────────────

import { vi } from 'vitest'
import {
  createInferenceTimeoutGuard,
  INFERENCE_TIMEOUT_LEDGER_KEY,
} from '../inference-timeout-guard.js'

function fakeLog() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }
  log.child.mockReturnValue(log)
  return log as unknown as import('@camstack/types').IScopedLogger
}

async function drive(input: {
  readonly stored: Record<string, unknown>
  readonly fingerprint: string
  readonly timeoutsPerTick: readonly number[]
}) {
  let total = 0
  let queue = [...input.timeoutsPerTick]
  let store = { ...input.stored }
  const emitFailed = vi.fn()
  const emitRecovered = vi.fn()
  let clock = T0
  const guard = createInferenceTimeoutGuard({
    readTotalTimeouts: () => total,
    readStore: async () => store,
    writeStore: async (patch) => {
      store = { ...store, ...patch }
    },
    resolveFingerprint: async () => input.fingerprint,
    emitFailed,
    emitRecovered,
    nodeId: 'hub',
    log: fakeLog(),
    now: () => clock,
  })
  while (queue.length > 0) {
    total += queue.shift() ?? 0
    clock += TIMEOUT_GUARD_BUCKET_MS
    await guard.tick()
  }
  return { emitFailed, emitRecovered, store: () => store }
}

describe('createInferenceTimeoutGuard', () => {
  const previous = ledger(
    'server@1.2.217',
    Array.from({ length: 12 }, () => 1),
  )

  it('raises ONE liveness finding when the new closure regresses, and persists both ledgers', async () => {
    const { emitFailed, emitRecovered, store } = await drive({
      stored: { [INFERENCE_TIMEOUT_LEDGER_KEY]: { current: previous } },
      fingerprint: 'server@1.2.218',
      timeoutsPerTick: [500, 480, 510, 490, 505],
    })
    expect(emitFailed).toHaveBeenCalledTimes(1)
    expect(emitFailed.mock.calls[0]?.[0]).toMatchObject({
      findingId: 'inference-timeout-regression:hub',
      severity: 'error',
    })
    expect(emitRecovered).not.toHaveBeenCalled()
    const persisted = store()[INFERENCE_TIMEOUT_LEDGER_KEY] as {
      current: TimeoutLedger
      previous: TimeoutLedger
    }
    expect(persisted.current.version).toBe('server@1.2.218')
    expect(persisted.previous.version).toBe('server@1.2.217')
  })

  it('clears the finding once the rate falls back', async () => {
    const { emitFailed, emitRecovered } = await drive({
      stored: { [INFERENCE_TIMEOUT_LEDGER_KEY]: { current: previous } },
      fingerprint: 'server@1.2.218',
      // Three hot buckets raise it; nine quiet ones pull the hourly rate under the ratio.
      timeoutsPerTick: [500, 480, 510, ...Array.from({ length: 12 }, () => 0)],
    })
    expect(emitFailed).toHaveBeenCalledTimes(1)
    expect(emitRecovered).toHaveBeenCalledWith('inference-timeout-regression:hub')
  })

  it('a restart under the SAME closure keeps counting and compares nothing', async () => {
    const { emitFailed, store } = await drive({
      stored: { [INFERENCE_TIMEOUT_LEDGER_KEY]: { current: previous } },
      fingerprint: 'server@1.2.217',
      timeoutsPerTick: [500, 480, 510],
    })
    expect(emitFailed).not.toHaveBeenCalled()
    const persisted = store()[INFERENCE_TIMEOUT_LEDGER_KEY] as {
      current: TimeoutLedger
      previous?: TimeoutLedger
    }
    expect(persisted.current.version).toBe('server@1.2.217')
    expect(persisted.current.buckets).toHaveLength(12)
    expect(persisted.previous).toBeUndefined()
  })
})

// ── The fingerprint, read from the closure the runner was started from ────

import { closureVersionFromRunnerPath } from '../inference-timeout-guard.js'

describe('closureVersionFromRunnerPath', () => {
  // The forked runner is `<closure>/node_modules/@camstack/system/dist/addon-runner.js`
  // (hub: /data/server-root/current/…). `server-management` is a
  // server-provided cap the parent refuses to route for a forked addon
  // ("no provider registered", measured 2026-09-05 on all three nodes), so
  // the version is read from the closure on disk instead.
  const files: Record<string, string> = {
    '/data/server-root/current/node_modules/@camstack/server/package.json':
      '{"name":"@camstack/server","version":"1.2.225"}',
  }
  const fs = {
    readFile: (p: string): string | null => files[p] ?? null,
  }

  it('walks up from the runner script to the closure server package', () => {
    expect(
      closureVersionFromRunnerPath(
        '/data/server-root/current/node_modules/@camstack/system/dist/addon-runner.js',
        fs,
      ),
    ).toBe('server@1.2.225')
  })

  it('answers null when no closure package is above the script', () => {
    expect(closureVersionFromRunnerPath('/opt/elsewhere/dist/addon-runner.js', fs)).toBeNull()
    expect(closureVersionFromRunnerPath(undefined, fs)).toBeNull()
  })
})
