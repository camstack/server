/**
 * Proactive state reports (R3, D776): the hub's `DeviceStateChanged` events
 * in, Alexa ChangeReports out — the alarm panel, privacy and autotrack
 * switches, accessories (siren, floodlight, spotlight), generic devices and
 * every device's connectivity. Before this only camera motion and doorbell
 * presses were pushed, so an alarm triggered or a light switched at the wall
 * stayed stale in the Alexa app until it happened to poll.
 *
 * A slice re-announced with the same values (a poll, a `lastFetchedAt` tick)
 * is not a change for Alexa: each endpoint/interface/instance remembers what
 * it last reported and reports only a difference.
 *
 * Two additions (D869):
 *
 *   - rate shaping — a report whose adapter declares a `PropertyShaping`
 *     (deadband, minimum interval, debounce) goes through the `ReportShaper`;
 *   - reconcile — events are telemetry and may be dropped (D8, D11), so
 *     `reconcile` compares a freshly read slice with the last REPORTED value
 *     and pushes only a difference. The first look at a property records a
 *     baseline instead of pushing it (Alexa's copy is unknown, and a restart
 *     must not re-announce every device), and a pending shaped value is left
 *     alone: its event is alive.
 */
import type { AddonContext, IScopedLogger } from '@camstack/types'
import { EventCategory, errMsg } from '@camstack/types'
import { z } from 'zod'
import type { PropertyShaping } from '../endpoints/adapters/types.js'
import { ReportShaper, type ShaperClock } from './report-shaper.js'
import { type StateReport, stateReportsFor } from './state-change-map.js'

const DeviceStateChangedSchema = z.object({
  deviceId: z.number(),
  capName: z.string(),
  slice: z.record(z.string(), z.unknown()),
})

export type StateChange = z.infer<typeof DeviceStateChangedSchema>

export interface StateChangeReporterDeps {
  readonly eventBus: AddonContext['eventBus']
  readonly getExportedEndpoints: () => Readonly<Record<number, readonly string[]>>
  readonly reportConnectivity: (
    deviceId: number,
    connectivity: 'OK' | 'UNREACHABLE',
  ) => Promise<void>
  readonly postStateChange: (report: StateReport) => Promise<void>
  /**
   * A MotionSensor report on a generic device: sent through the held-motion
   * path (instant DETECTED, NOT_DETECTED >= 30 s later — Amazon's rule), not
   * as a plain ChangeReport.
   */
  readonly postHeldMotion: (report: StateReport, detected: boolean) => Promise<void>
  readonly logger: IScopedLogger
  /** Test seam for the shaping clock. */
  readonly clock?: ShaperClock
}

/** What the last reported value of one endpoint/interface/instance was. */
function reportKey(report: StateReport): string {
  return `${report.endpointId}|${report.interfaceName}|${report.instance ?? ''}`
}

/** The number a shaped report is compared by, or null. */
function numericOf(report: StateReport, shaping: PropertyShaping): number | null {
  const value = report.properties[0]?.value
  return shaping.numericOf === undefined ? null : shaping.numericOf(value)
}

export class StateChangeReporter {
  private off: (() => void) | null = null
  private readonly lastReported = new Map<string, string>()
  private readonly shaper: ReportShaper<StateReport>

  constructor(private readonly deps: StateChangeReporterDeps) {
    this.shaper = new ReportShaper<StateReport>(
      (err) =>
        this.deps.logger.warn('alexa state reports: a shaped report failed', {
          meta: { error: errMsg(err) },
        }),
      this.deps.clock,
    )
  }

  start(): void {
    this.off = this.deps.eventBus.subscribe(
      { category: EventCategory.DeviceStateChanged },
      (event) => {
        const parsed = DeviceStateChangedSchema.safeParse(event.data)
        if (parsed.success) void this.onChange(parsed.data)
      },
    )
  }

  stop(): void {
    this.off?.()
    this.off = null
    this.shaper.stop()
    this.lastReported.clear()
  }

  async onChange(change: StateChange): Promise<void> {
    const outcome = stateReportsFor(change, this.deps.getExportedEndpoints())
    if (outcome === null) return
    try {
      if (outcome.kind === 'connectivity') {
        await this.deps.reportConnectivity(outcome.deviceId, outcome.online ? 'OK' : 'UNREACHABLE')
        return
      }
      for (const report of outcome.reports) {
        const shaping = report.shaping
        if (shaping === undefined) {
          await this.send(report)
          continue
        }
        await this.shaper.submit(
          reportKey(report),
          report,
          shaping,
          numericOf(report, shaping),
          async (r) => {
            await this.send(r)
          },
        )
      }
    } catch (err) {
      this.deps.logger.warn('alexa state reports: posting a state change failed', {
        tags: { deviceId: change.deviceId },
        meta: { capName: change.capName, error: errMsg(err) },
      })
    }
  }

  /**
   * Heal a dropped event: compare a slice READ now with what was last
   * reported and push a difference. Returns how many reports were pushed.
   * A caller whose read failed does not call this — failure changes nothing.
   */
  async reconcile(change: StateChange): Promise<number> {
    const outcome = stateReportsFor(change, this.deps.getExportedEndpoints())
    if (outcome === null || outcome.kind !== 'reports') return 0
    let pushed = 0
    for (const report of outcome.reports) {
      const key = reportKey(report)
      const value = JSON.stringify(report.properties)
      // A value still waiting in the shaper is on its way: its event is alive.
      if (this.shaper.hasPending(key)) continue
      const previous = this.lastReported.get(key)
      if (previous === undefined) {
        // Baseline: nothing was reported since boot, so there is no drift to measure.
        this.lastReported.set(key, value)
        this.markSentInShaper(key, report)
        continue
      }
      if (previous === value) continue
      if (this.insideDeadband(key, report)) continue
      try {
        if (await this.send(report)) pushed += 1
        this.markSentInShaper(key, report)
      } catch (err) {
        this.deps.logger.warn('alexa state reconcile: pushing a corrected state failed', {
          tags: { deviceId: change.deviceId },
          meta: { capName: change.capName, error: errMsg(err) },
        })
      }
    }
    return pushed
  }

  private insideDeadband(key: string, report: StateReport): boolean {
    const shaping = report.shaping
    if (shaping?.deadband === undefined) return false
    const value = numericOf(report, shaping)
    const last = this.shaper.lastValue(key)
    return value !== null && last !== null && Math.abs(value - last) < shaping.deadband
  }

  private markSentInShaper(key: string, report: StateReport): void {
    const shaping = report.shaping
    if (shaping === undefined) return
    this.shaper.markSent(key, numericOf(report, shaping))
  }

  /** Deliver one report, unless it repeats what was last reported. Returns
   *  whether anything was handed to the gateway. */
  private async send(report: StateReport): Promise<boolean> {
    const key = reportKey(report)
    const value = JSON.stringify(report.properties)
    if (this.lastReported.get(key) === value) return false
    this.lastReported.set(key, value)
    if (report.interfaceName === 'Alexa.MotionSensor') {
      await this.deps.postHeldMotion(report, report.properties[0]?.value === 'DETECTED')
      return true
    }
    await this.deps.postStateChange(report)
    return true
  }
}
