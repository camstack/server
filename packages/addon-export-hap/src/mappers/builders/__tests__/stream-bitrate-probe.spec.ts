import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

import type { BuilderContext } from '../../types.js'
import {
  BITRATE_EVIDENCE_BUDGET_MS,
  gatherRateEvidence,
  type RateEvidence,
} from '../stream-bitrate-probe.js'

function fakeLog(): IScopedLogger {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withTags: () => log,
  }
  return log as unknown as IScopedLogger
}

/** Build a proxy whose three reads resolve after the given delays. */
function proxyWithDelays(delays: {
  camStreams: number
  streamParams: number
  choices: number
}): BuilderContext['proxy'] {
  const after = <T>(ms: number, value: T): Promise<T> =>
    new Promise((resolve) => setTimeout(() => resolve(value), ms))
  const proxy = {
    cameraStreams: { getCameraStreams: () => after(delays.camStreams, []) },
    streamParams: { getStatus: () => after(delays.streamParams, { lastFetchedAt: 1 }) },
    webrtcSession: { listStreams: () => after(delays.choices, []) },
  }
  return proxy as unknown as BuilderContext['proxy']
}

describe('gatherRateEvidence', () => {
  it('issues the three reads CONCURRENTLY, not one after another', async () => {
    // The defect this replaces: three sequential cap calls into a stream-broker
    // that freezes for seconds. Sequentially these three take 300 ms; together
    // they take about 100. Anything at or above 250 means they are back in a
    // queue, which is the shape that reached 21 s on the live hub.
    const started = Date.now()
    await gatherRateEvidence(
      proxyWithDelays({ camStreams: 100, streamParams: 100, choices: 100 }),
      fakeLog(),
    )
    expect(Date.now() - started).toBeLessThan(250)
  })

  it('gives up on the budget and REPORTS abandoning it, rather than waiting', async () => {
    const log = fakeLog()
    const started = Date.now()
    const evidence = await gatherRateEvidence(
      proxyWithDelays({
        camStreams: BITRATE_EVIDENCE_BUDGET_MS * 4,
        streamParams: 1,
        choices: 1,
      }),
      log,
    )

    expect(Date.now() - started).toBeLessThan(BITRATE_EVIDENCE_BUDGET_MS * 2)
    // Evidence is optional: no reading at all is a supported outcome that
    // costs a rate preference, never the session.
    expect(evidence).toEqual({ camStreams: null, streamParams: null, choices: null })
    const warned = vi.mocked(log.warn).mock.calls.map(([msg]) => String(msg))
    expect(warned.some((m) => m.includes('rate evidence ABANDONED'))).toBe(true)
  })

  it('falls back to the LAST GOOD reading, so a slow read cannot change the slot', async () => {
    // This is the property that matters, and its absence was measured on 101:
    // four sessions in forty seconds, same camera, same negotiated 1280x720,
    // alternating mid(10 fps) / low(24 fps) / mid / low. With evidence `low`
    // classifies as a fit and wins; without it every slot reads unknown and
    // the fallback takes `mid`. The stream a controller got depended on
    // whether a cap read beat a timer.
    const log = fakeLog()
    // Identity is what is asserted below, so the shape only has to be a valid
    // RateEvidence — an EMPTY reading is still a reading that arrived.
    const lastGood: RateEvidence = { camStreams: [], streamParams: null, choices: [] }
    const evidence = await gatherRateEvidence(
      proxyWithDelays({ camStreams: BITRATE_EVIDENCE_BUDGET_MS * 4, streamParams: 1, choices: 1 }),
      log,
      lastGood,
    )

    expect(evidence).toBe(lastGood)
    const warned = vi.mocked(log.warn).mock.calls.map((c) => JSON.stringify(c))
    expect(warned.some((m) => m.includes('last-good'))).toBe(true)
  })

  it('still returns real readings when every read is prompt', async () => {
    const log = fakeLog()
    const evidence = await gatherRateEvidence(
      proxyWithDelays({ camStreams: 1, streamParams: 1, choices: 1 }),
      log,
    )
    expect(evidence.camStreams).toEqual([])
    expect(evidence.streamParams).toEqual({ lastFetchedAt: 1 })
    const warned = vi.mocked(log.warn).mock.calls.map(([msg]) => String(msg))
    expect(warned.some((m) => m.includes('ABANDONED'))).toBe(false)
  })

  it('treats an unbound cap as missing evidence, not as a failure', async () => {
    const log = fakeLog()
    const evidence = await gatherRateEvidence({} as unknown as BuilderContext['proxy'], log)
    expect(evidence).toEqual({ camStreams: null, streamParams: null, choices: null })
  })
})
