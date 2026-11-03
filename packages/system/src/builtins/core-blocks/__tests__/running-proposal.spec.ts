import {
  DAY_MS,
  DEFAULT_HISTORY_RETENTION,
  type DeviceHistoryQueryPoint,
  type DeviceHistoryQueryResult,
  type DeviceHistorySeriesInfo,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { recordingLogger } from '../../composer/__tests__/fixtures.js'
import { capSeriesKey } from '../../device-history/capture/capture-engine.js'
import {
  proposeForDevice,
  type ProposalHistoryQuery,
  type RunningProposalPorts,
} from '../running-proposal.js'

const MIN = 60_000
const NOW = Date.UTC(2026, 0, 20, 12, 0, 0)
const REQUEST = { deviceId: 7, cap: 'power-meter', fieldPath: 'power' }
const KEY = capSeriesKey(REQUEST.cap, REQUEST.fieldPath)

function point(t: number, value: number): DeviceHistoryQueryPoint {
  return {
    t,
    samples: 1,
    mean: value,
    twMean: value,
    min: value,
    max: value,
    last: value,
    delta: null,
    state: null,
    states: null,
  }
}

/** One wash a day from 09:00: 2 kW for 30 min, an 8 min 2 W soak, 2 kW for 30 min; 1 W otherwise. One reading a minute. */
function washerAt(t: number): number {
  const sinceMidnight = (((t % DAY_MS) + DAY_MS) % DAY_MS) / MIN
  const m = sinceMidnight - 9 * 60
  if (m >= 0 && m < 30) return 2000
  if (m >= 30 && m < 38) return 2
  if (m >= 38 && m < 68) return 2000
  return 1
}

interface Fake {
  readonly ports: RunningProposalPorts
  readonly queries: ProposalHistoryQuery[]
}

function fake(over: {
  readonly info?: readonly DeviceHistorySeriesInfo[]
  readonly firstTs?: number
  readonly rawMs?: number
  /** A slice with more than this many readings is answered truncated (the newest ones). */
  readonly denseDays?: readonly number[]
  readonly capPoints?: number
}): Fake {
  const queries: ProposalHistoryQuery[] = []
  const info: DeviceHistorySeriesInfo = {
    key: KEY,
    scope: '',
    kind: 'gauge',
    unit: 'W',
    displayName: 'power',
    source: 'cap',
    values: null,
    firstTs: over.firstTs ?? NOW - 20 * DAY_MS,
    lastTs: NOW,
  }
  const ports: RunningProposalPorts = {
    listSeries: async () => over.info ?? [info],
    query: async (input) => {
      queries.push(input)
      const step = input.resolution === 'raw' ? MIN : 5 * MIN
      const all: DeviceHistoryQueryPoint[] = []
      for (let t = Math.ceil(input.from / step) * step; t < input.to; t += step) {
        const peak =
          input.resolution === 'raw' ? washerAt(t) : Math.max(washerAt(t), washerAt(t + 4 * MIN))
        all.push(point(t, peak))
      }
      const dense = (over.denseDays ?? []).some(
        (d) => input.to > NOW - d * DAY_MS && input.to <= NOW - (d - 1) * DAY_MS,
      )
      const cap = dense ? 10 : Math.min(input.maxPoints, over.capPoints ?? input.maxPoints)
      const truncated = all.length > cap
      const result: DeviceHistoryQueryResult = {
        resolution: input.resolution,
        truncated,
        series: [
          {
            scope: '',
            before: null,
            points: truncated ? all.slice(all.length - cap) : all,
            derivedFrom: null,
          },
        ],
      }
      return result
    },
    retention: async () => ({
      ...DEFAULT_HISTORY_RETENTION,
      rawMs: over.rawMs ?? DEFAULT_HISTORY_RETENTION.rawMs,
    }),
    now: () => NOW,
    logger: recordingLogger().logger,
  }
  return { ports, queries }
}

describe('proposeForDevice', () => {
  it('reads the raw tier in day slices under the point cap and proposes from them', async () => {
    const { ports, queries } = fake({})
    const answer = await proposeForDevice(ports, REQUEST)
    expect(answer.state).toBe('proposal')
    if (answer.state !== 'proposal') return
    expect(answer.evidence.tier).toBe('raw')
    expect(answer.evidence.runsFound).toBeGreaterThanOrEqual(5)
    expect(answer.transform.stopDwellMs).toBeGreaterThan(8 * MIN)
    expect(queries.length).toBe(7)
    expect(
      queries.every((q) => q.resolution === 'raw' && q.maxPoints <= 5000 && q.key === KEY),
    ).toBe(true)
    expect(queries.every((q) => q.to - q.from <= DAY_MS)).toBe(true)
  })

  it('says no-history when the device has no series for the field', async () => {
    const { ports, queries } = fake({ info: [] })
    const answer = await proposeForDevice(ports, REQUEST)
    expect(answer).toMatchObject({
      state: 'insufficient',
      reason: 'no-history',
    })
    expect(queries).toHaveLength(0)
  })

  it('says truncated when the newest slice does not fit the point cap', async () => {
    const { ports } = fake({ denseDays: [1] })
    expect(await proposeForDevice(ports, REQUEST)).toMatchObject({
      state: 'insufficient',
      reason: 'truncated',
    })
  })

  it('ends the window at an older slice that does not fit, and still answers from the newer days', async () => {
    const { ports, queries } = fake({ denseDays: [5] })
    const answer = await proposeForDevice(ports, REQUEST)
    expect(queries.length).toBe(5)
    expect(answer.state).toBe('proposal')
  })

  it('falls back to the 5 minute rollup (peak per bucket) when raw keeps under a day', async () => {
    const { ports, queries } = fake({ rawMs: 12 * 60 * MIN })
    const answer = await proposeForDevice(ports, REQUEST)
    expect(queries).toHaveLength(1)
    expect(queries[0]?.resolution).toBe('5m')
    expect(answer.state).toBe('proposal')
    if (answer.state !== 'proposal') return
    expect(answer.evidence.tier).toBe('5m')
    expect(answer.confidence).not.toBe('high')
  })

  it('does not look before the first stored reading', async () => {
    const { ports, queries } = fake({ firstTs: NOW - 2 * DAY_MS })
    await proposeForDevice(ports, REQUEST)
    expect(Math.min(...queries.map((q) => q.from))).toBe(NOW - 2 * DAY_MS)
  })

  it('refuses a series that is not a gauge, by name', async () => {
    const { ports } = fake({
      info: [
        {
          key: KEY,
          scope: '',
          kind: 'boolean',
          unit: null,
          displayName: 'on',
          source: 'cap',
          values: null,
          firstTs: 0,
          lastTs: NOW,
        },
      ],
    })
    await expect(proposeForDevice(ports, REQUEST)).rejects.toThrow(/numeric gauge/)
  })
})
