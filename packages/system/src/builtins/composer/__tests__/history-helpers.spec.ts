import { describe, expect, it } from 'vitest'
import {
  DAY_MS,
  DEFAULT_HISTORY_RETENTION,
  HOUR_MS,
  type IScopedLogger,
  type StatisticHelperSpec,
  type IntegralHelperSpec,
} from '@camstack/types'
import type { DeadlineTimer } from '../composition-runtime.js'
import {
  HistoryHelpers,
  type HistoryBlockView,
  type HistoryQuery,
  type SeriesWrite,
} from '../history-helpers.js'

const ZONE = 'Europe/Rome'

function logger(): { readonly sink: IScopedLogger; readonly lines: string[] } {
  const lines: string[] = []
  const sink: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message) => {
      lines.push(message)
    },
    error: () => undefined,
    child: () => sink,
    withTags: () => sink,
  }
  return { sink, lines }
}

class Arm implements DeadlineTimer {
  at = 0
  armed = false
  arm(at: number, _fire: () => void): void {
    this.at = at
    this.armed = true
  }
  disarm(): void {
    this.armed = false
  }
}

function point(t: number, watts: number) {
  return {
    t,
    samples: 1,
    mean: watts,
    twMean: null,
    min: watts,
    max: watts,
    last: watts,
    delta: null,
    state: null,
    states: null,
  }
}

function integral(reset: IntegralHelperSpec['reset']): IntegralHelperSpec {
  return {
    kind: 'integral',
    reset,
    output: 'energy',
    source: {
      source: { addonId: 'demo', stableId: 'meter' },
      cap: 'power-meter',
      fieldPath: 'watts',
    },
  }
}

function statistic(window: StatisticHelperSpec['window']): StatisticHelperSpec {
  return {
    kind: 'statistic',
    stat: 'mean',
    window,
    source: {
      source: { addonId: 'demo', stableId: 'meter' },
      cap: 'numeric-sensor',
      fieldPath: 'value',
    },
  }
}

describe('history helpers', () => {
  it('recomputes the same integral after a restart and does not count a gap as zero', async () => {
    const now = Date.parse('2026-10-26T12:00:00Z')
    const published: SeriesWrite[][] = []
    const ask = async (input: HistoryQuery) => ({
      resolution: input.resolution,
      truncated: false,
      series: [
        {
          scope: '',
          before: null,
          derivedFrom: null,
          points: [point(input.from + HOUR_MS, 1000)],
        },
      ],
    })
    const run = async () => {
      const notes = logger()
      const helpers = new HistoryHelpers({
        now: () => now,
        timeZone: ZONE,
        logger: notes.sink,
        query: ask,
        retention: async () => DEFAULT_HISTORY_RETENTION,
        sourceDeviceId: () => 7,
        blocks: () => [{ blockId: 'meter', deviceId: 40, helper: integral('daily') }],
        publish: (_id, writes) => {
          published.push([...writes])
        },
        timer: new Arm(),
      })
      helpers.start()
      await flush()
      return notes.lines
    }
    const first = await run()
    const second = await run()
    const value = published[0]?.find((write) => write.path === 'kwhTotal')?.value
    const again = published[1]?.find((write) => write.path === 'kwhTotal')?.value
    expect(value).toBeGreaterThan(0)
    expect(again).toBe(value)
    expect(published[0]?.find((write) => write.path === 'excluded')?.value).toBe(1)
    expect(first.some((line) => line.includes('not counted as zero'))).toBe(true)
    expect(second.some((line) => line.includes('not counted as zero'))).toBe(true)
  })

  it('holds the last total when the query is truncated', async () => {
    const notes = logger()
    const published: SeriesWrite[][] = []
    const helpers = new HistoryHelpers({
      now: () => Date.parse('2026-10-26T12:00:00Z'),
      timeZone: ZONE,
      logger: notes.sink,
      query: async (input) => ({ resolution: input.resolution, truncated: true, series: [] }),
      retention: async () => DEFAULT_HISTORY_RETENTION,
      sourceDeviceId: () => 7,
      blocks: (): readonly HistoryBlockView[] => [
        { blockId: 'meter', deviceId: 40, helper: integral('daily') },
      ],
      publish: (_id, writes) => {
        published.push([...writes])
      },
      timer: new Arm(),
    })
    helpers.start()
    await flush()
    expect(published).toEqual([])
    expect(notes.lines.some((line) => line.includes('truncated'))).toBe(true)
  })

  it('refuses a window no tier keeps strictly longer, and opens today on the fall-back midnight', async () => {
    const notes = logger()
    const seen: HistoryQuery[] = []
    const week = 7 * DAY_MS
    const helpers = new HistoryHelpers({
      now: () => Date.parse('2026-10-25T12:00:00Z'),
      timeZone: ZONE,
      logger: notes.sink,
      query: async (input) => {
        seen.push(input)
        return { resolution: input.resolution, truncated: false, series: [] }
      },
      retention: async () => ({ rawMs: week, fiveMinuteMs: week, hourMs: week, dayMs: week }),
      sourceDeviceId: () => 7,
      blocks: () => [
        { blockId: 'wide', deviceId: 40, helper: statistic({ kind: 'rolling', span: '7d' }) },
        {
          blockId: 'today',
          deviceId: 41,
          helper: statistic({ kind: 'calendar', period: 'today' }),
        },
      ],
      publish: () => undefined,
      timer: new Arm(),
    })
    helpers.start()
    await flush()
    expect(notes.lines.some((line) => line.includes('strictly longer'))).toBe(true)
    expect(seen.map((query) => query.from)).toEqual([Date.parse('2026-10-24T22:00:00Z')])
  })

  it('does not query a rolling window sooner than its cadence when a sample arrives', async () => {
    const now = Date.parse('2026-10-26T12:00:00Z')
    const arm = new Arm()
    const helpers = new HistoryHelpers({
      now: () => now,
      timeZone: ZONE,
      logger: logger().sink,
      query: async (input) => ({ resolution: input.resolution, truncated: false, series: [] }),
      retention: async () => DEFAULT_HISTORY_RETENTION,
      sourceDeviceId: () => 7,
      blocks: () => [
        { blockId: 'hour', deviceId: 40, helper: statistic({ kind: 'rolling', span: '1h' }) },
      ],
      publish: () => undefined,
      timer: arm,
    })
    helpers.start()
    await flush()
    const afterPass = arm.at
    helpers.noteSample(7)
    expect(arm.at).toBeGreaterThanOrEqual(afterPass)
    expect(arm.at - now).toBeGreaterThanOrEqual(60_000)
  })

  it('does not arm a timer when no block reads history', () => {
    const arm = new Arm()
    const helpers = new HistoryHelpers({
      now: () => Date.parse('2026-10-26T12:00:00Z'),
      timeZone: ZONE,
      logger: logger().sink,
      query: async (input) => ({ resolution: input.resolution, truncated: false, series: [] }),
      retention: async () => DEFAULT_HISTORY_RETENTION,
      sourceDeviceId: () => 7,
      blocks: () => [],
      publish: () => undefined,
      timer: arm,
    })
    helpers.start()
    expect(arm.armed).toBe(false)
  })

  it('copies the source quantity onto a statistic and a meter, and not onto energy', async () => {
    const now = Date.parse('2026-10-26T12:00:00Z')
    const stamped: { readonly blockId: string; readonly quantity: string }[] = []
    const ask = async (input: HistoryQuery) => ({
      resolution: input.resolution,
      truncated: false,
      series: [
        {
          scope: '',
          before: null,
          derivedFrom: null,
          points: [point(input.from + HOUR_MS, 1000)],
        },
      ],
    })
    const meter: IntegralHelperSpec = {
      ...integral('daily'),
      output: 'meter',
      source: {
        source: { addonId: 'demo', stableId: 'flow' },
        cap: 'numeric-sensor',
        fieldPath: 'value',
      },
    }
    const helpers = new HistoryHelpers({
      now: () => now,
      timeZone: ZONE,
      logger: logger().sink,
      query: ask,
      retention: async () => DEFAULT_HISTORY_RETENTION,
      sourceDeviceId: () => 7,
      sourceQuantity: async () => 'volume',
      adoptQuantity: async (blockId, quantity) => {
        stamped.push({ blockId, quantity })
      },
      blocks: () => [
        { blockId: 'stat', deviceId: 40, helper: statistic({ kind: 'rolling', span: '1h' }) },
        { blockId: 'kwh', deviceId: 41, helper: integral('daily') },
        { blockId: 'total', deviceId: 42, helper: meter },
      ],
      publish: () => undefined,
      timer: new Arm(),
    })
    helpers.start()
    await flush()
    expect(stamped).toEqual([
      { blockId: 'stat', quantity: 'volume' },
      { blockId: 'total', quantity: 'volume' },
    ])
  })
})

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
