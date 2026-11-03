/**
 * `proposeRunningThreshold` — read a SOURCE device's power history and hand it
 * to the pure algorithm in `@camstack/types` (planning#405).
 *
 * The slices are read newest first, one day of RAW at a time so a day never
 * exceeds the point cap; a truncated slice is dropped, not trusted. When the
 * raw tier keeps less than the minimum span, the 5-minute rollup answers instead
 * (its `max` stands for the bucket), and the algorithm caps the confidence.
 */
import {
  DAY_MS,
  type DeviceHistoryQueryPoint,
  type DeviceHistoryQueryResult,
  type DeviceHistorySeriesInfo,
  type DeviceType,
  errMsg,
  type HistoryRetention,
  type HistoryTier,
  type IScopedLogger,
  type ProposalSeries,
  type ProposalStepPoint,
  PROPOSAL_MIN_SPAN_MS,
  proposeRunningThreshold,
  type RunningProposalTier,
  type RunningThresholdProposal,
} from '@camstack/types'
import { capSeriesKey } from '../device-history/capture/capture-engine.js'

/** The newest slices the proposal reads: a fortnight shows a weekly habit twice. */
const LOOKBACK_MS = 14 * DAY_MS
const QUERY_MAX_POINTS = 5000

export interface ProposalHistoryQuery {
  readonly deviceId: number
  readonly key: string
  readonly from: number
  readonly to: number
  readonly resolution: HistoryTier
  readonly maxPoints: number
}

export interface RunningProposalPorts {
  readonly listSeries: (deviceId: number) => Promise<readonly DeviceHistorySeriesInfo[]>
  readonly query: (input: ProposalHistoryQuery) => Promise<DeviceHistoryQueryResult>
  readonly retention: () => Promise<HistoryRetention>
  readonly now: () => number
  readonly logger: IScopedLogger
}

export interface RunningProposalRequest {
  readonly deviceId: number
  readonly cap: string
  readonly fieldPath: string
  readonly deviceType?: DeviceType
}

interface Slice {
  readonly from: number
  readonly to: number
}

export async function proposeForDevice(
  ports: RunningProposalPorts,
  request: RunningProposalRequest,
): Promise<RunningThresholdProposal> {
  const key = capSeriesKey(request.cap, request.fieldPath)
  const now = ports.now()
  const info = (await ports.listSeries(request.deviceId)).find((s) => s.key === key)
  if (info === undefined) {
    ports.logger.info('running proposal: the device has no history for this field', {
      tags: { deviceId: request.deviceId },
      meta: { key },
    })
    return proposeRunningThreshold(emptySeries(now))
  }
  if (info.kind !== 'gauge') {
    throw new Error(
      `core-blocks: ${key} is a ${info.kind} series — a running threshold needs a numeric gauge`,
    )
  }

  const retention = await ports.retention()
  const tier: RunningProposalTier = retention.rawMs >= PROPOSAL_MIN_SPAN_MS ? 'raw' : '5m'
  const keptMs = tier === 'raw' ? retention.rawMs : retention.fiveMinuteMs
  const from = Math.max(now - Math.min(LOOKBACK_MS, keptMs), info.firstTs)
  const read =
    tier === 'raw'
      ? await readRawSlices(ports, request.deviceId, key, from, now)
      : await readFiveMinute(ports, request.deviceId, key, from, now)

  const answer = proposeRunningThreshold(read)
  ports.logger.info(`running proposal: ${answer.state}`, {
    tags: { deviceId: request.deviceId },
    meta: {
      key,
      tier,
      points: read.points.length,
      truncated: read.truncated,
      ...(request.deviceType === undefined ? {} : { deviceType: request.deviceType }),
      ...(answer.state === 'proposal'
        ? {
            confidence: answer.confidence,
            threshold: answer.transform.threshold,
          }
        : { reason: answer.reason }),
    },
  })
  return answer
}

function emptySeries(now: number): ProposalSeries {
  return {
    tier: 'raw',
    from: now,
    to: now,
    truncated: false,
    before: null,
    points: [],
  }
}

/** Day slices ending at `to`, newest first, none reaching before `from`. */
function daySlices(from: number, to: number): Slice[] {
  const out: Slice[] = []
  for (let end = to; end > from; end -= DAY_MS)
    out.push({ from: Math.max(from, end - DAY_MS), to: end })
  return out
}

async function readRawSlices(
  ports: RunningProposalPorts,
  deviceId: number,
  key: string,
  from: number,
  to: number,
): Promise<ProposalSeries> {
  const points: ProposalStepPoint[] = []
  let before: ProposalStepPoint | null = null
  let reached = to
  let truncated = false
  for (const slice of daySlices(from, to)) {
    const result = await queryOrNull(ports, deviceId, {
      deviceId,
      key,
      from: slice.from,
      to: slice.to,
      resolution: 'raw',
      maxPoints: QUERY_MAX_POINTS,
    })
    if (result === null || result.truncated || result.resolution !== 'raw') {
      // The newest slice is the one that matters; an older one that cannot be
      // read just ends the window there.
      truncated = reached === to
      break
    }
    const series = result.series[0]
    if (series === undefined) break
    points.push(...series.points.map(rawStep))
    before = series.before === null ? null : { t: series.before.t, value: series.before.value }
    reached = slice.from
  }
  return {
    tier: 'raw',
    from: reached,
    to,
    truncated,
    before,
    points: points.sort((a, b) => a.t - b.t),
  }
}

async function readFiveMinute(
  ports: RunningProposalPorts,
  deviceId: number,
  key: string,
  from: number,
  to: number,
): Promise<ProposalSeries> {
  const result = await queryOrNull(ports, deviceId, {
    deviceId,
    key,
    from,
    to,
    resolution: '5m',
    maxPoints: QUERY_MAX_POINTS,
  })
  const series = result?.series[0]
  if (result === null || series === undefined) {
    return { tier: '5m', from, to, truncated: true, before: null, points: [] }
  }
  return {
    tier: '5m',
    from,
    to,
    truncated: result.truncated || result.resolution !== '5m',
    before: series.before === null ? null : { t: series.before.t, value: series.before.value },
    points: series.points.map(bucketStep),
  }
}

async function queryOrNull(
  ports: RunningProposalPorts,
  deviceId: number,
  input: ProposalHistoryQuery,
): Promise<DeviceHistoryQueryResult | null> {
  try {
    return await ports.query(input)
  } catch (err: unknown) {
    ports.logger.warn('running proposal: a history slice could not be read', {
      tags: { deviceId },
      meta: { from: input.from, to: input.to, error: errMsg(err) },
    })
    return null
  }
}

function rawStep(point: DeviceHistoryQueryPoint): ProposalStepPoint {
  return { t: point.t, value: point.last }
}

/** A rollup bucket stands for its peak: the highest reading is what says "running". */
function bucketStep(point: DeviceHistoryQueryPoint): ProposalStepPoint {
  return { t: point.t, value: point.samples > 0 ? point.max : null }
}
