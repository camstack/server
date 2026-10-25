import type { IScopedLogger } from '@camstack/types'

/**
 * Sampled ingress log for the motion-bearing alarms a Hikvision camera pushes
 * (`VMD`, smart events such as `linedetection`).
 *
 * The provider acts on every one of them — each tick re-emits `ProviderMotion`
 * — but logged nothing at info level, so "did 102 send anything in that minute?"
 * could only be answered from the bus. A line per tick is the opposite failure:
 * Hikvision fires VMD about once a second for as long as something moves.
 *
 * So the log follows the STATE of a burst on one camStream, not its ticks:
 *   - `start`   the first tick of a burst, and the first tick of each further
 *               event type joining it (a smart event inside a VMD burst is news);
 *   - `ongoing` at most once per `intervalMs` while the burst lasts, with the
 *               tick count per type since the previous line;
 *   - `end`     when the provider's inactivity timer clears the burst, with the
 *               remaining counts and the burst's duration.
 * No timer of its own: the summary rides the next tick, the end rides the
 * provider's existing clear.
 */

/** Gap between two `ongoing` lines of one burst. */
export const ALARM_INGRESS_SUMMARY_INTERVAL_MS = 60_000

export const ALARM_INGRESS_MESSAGE = 'hikvision: alarm event received'

export interface AlarmIngressEvent {
  readonly type: string
  readonly state: string | null
  readonly aiClass: string | null
  readonly camStreamId: string
  /** When the provider observed the push (ms epoch). */
  readonly at: number
}

export interface AlarmIngressLog {
  received(event: AlarmIngressEvent): void
  /** The provider's inactivity timer cleared motion on `camStreamId` at `at`. */
  ended(camStreamId: string, at: number): void
}

export interface AlarmIngressLogDeps {
  readonly logger: IScopedLogger
  /** Numeric device id — every line carries it as `tags.deviceId`. */
  readonly deviceId: number
  readonly intervalMs?: number
}

interface Burst {
  readonly startedAt: number
  lastLineAt: number
  /** Ticks per event type since the previous line of this burst. */
  readonly counts: Map<string, number>
  /** Every type seen in this burst — a type is `start`ed once per burst. */
  readonly types: Set<string>
  ticks: number
}

const countsRecord = (counts: ReadonlyMap<string, number>): Record<string, number> =>
  Object.fromEntries(counts)

export function createAlarmIngressLog(deps: AlarmIngressLogDeps): AlarmIngressLog {
  const intervalMs = deps.intervalMs ?? ALARM_INGRESS_SUMMARY_INTERVAL_MS
  const bursts = new Map<string, Burst>()
  const tags = { deviceId: deps.deviceId }

  const received = (ev: AlarmIngressEvent): void => {
    const existing = bursts.get(ev.camStreamId)
    const burst: Burst = existing ?? {
      startedAt: ev.at,
      lastLineAt: ev.at,
      counts: new Map(),
      types: new Set(),
      ticks: 0,
    }
    if (!existing) bursts.set(ev.camStreamId, burst)
    burst.ticks += 1

    if (!burst.types.has(ev.type)) {
      burst.types.add(ev.type)
      deps.logger.info(ALARM_INGRESS_MESSAGE, {
        tags,
        meta: {
          edge: 'start',
          type: ev.type,
          state: ev.state,
          camStreamId: ev.camStreamId,
          ...(ev.aiClass === null ? {} : { aiClass: ev.aiClass }),
          ...(existing ? { burstAgeMs: ev.at - burst.startedAt } : {}),
        },
      })
      burst.lastLineAt = Math.max(burst.lastLineAt, ev.at)
      return
    }

    burst.counts.set(ev.type, (burst.counts.get(ev.type) ?? 0) + 1)
    if (ev.at - burst.lastLineAt < intervalMs) return
    deps.logger.info(ALARM_INGRESS_MESSAGE, {
      tags,
      meta: {
        edge: 'ongoing',
        camStreamId: ev.camStreamId,
        counts: countsRecord(burst.counts),
        windowMs: ev.at - burst.lastLineAt,
        burstAgeMs: ev.at - burst.startedAt,
      },
    })
    burst.counts.clear()
    burst.lastLineAt = ev.at
  }

  const ended = (camStreamId: string, at: number): void => {
    const burst = bursts.get(camStreamId)
    if (!burst) return
    bursts.delete(camStreamId)
    deps.logger.info(ALARM_INGRESS_MESSAGE, {
      tags,
      meta: {
        edge: 'end',
        camStreamId,
        counts: countsRecord(burst.counts),
        ticks: burst.ticks,
        types: [...burst.types],
        durationMs: at - burst.startedAt,
      },
    })
  }

  return { received, ended }
}
