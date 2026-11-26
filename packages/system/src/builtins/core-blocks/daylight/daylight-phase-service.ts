/**
 * The daylight phase AUTHORITY (planning#736): one answer to "is it day or
 * night", for the whole cluster. Provider of the `daylight-phase` cap.
 *
 * The sun is the default. With a sensor source the reading decides, through the
 * pure state machine in `@camstack/types` (`advanceSensorPhase`): a dark
 * threshold, a hysteresis band and a minimum dwell. A sensor that cannot be read
 * is NOT a measurement: the sun answers instead, `fallbackReason` says why, and
 * the reason is logged once (with `tags: { deviceId }`) until it changes.
 *
 * Nothing here is trusted to be delivered. A transition is announced through
 * `onTransition` (the addon turns it into an event and re-judges its own
 * consumers), but every consumer that must be right reads `getPhase`, which
 * judges NOW (D8, D49). The bounded regular re-check is `recheck()`, driven by a
 * timer the addon owns.
 *
 * @durable class=config owner=core-blocks
 *   write="the operator sets the source (setSettings)"
 *   retention="one row, replaced by the operator; absent means the sun"
 */
import {
  type DaylightPhaseReading,
  type DaylightSettings,
  DaylightSettingsSchema,
  type DaylightStatus,
  DEFAULT_DAYLIGHT_SETTINGS,
  type IDaylightPhaseProvider,
  type IScopedLogger,
  type RecordKindHandle,
  type SiteReading,
  advanceSensorPhase,
  errMsg,
  sensorValueOf,
  siteFor,
  sunPhaseAt,
  zoneOnlySite,
} from '@camstack/types'
import type { DaylightSettingsRowBody } from '../record-kinds.js'

/**
 * How long a sensor that stops answering keeps its LAST verdict before the sun takes over (D49: a
 * failed read changes nothing). A hiccup must not flip the phase, fire a transition or restart the
 * hysteresis and dwell; a sensor gone for this long is no longer a measurement. A sensor that never
 * produced a verdict (nothing to hold) falls back to the sun at once.
 */
export const SENSOR_HOLD_MS: number = 30 * 60_000

/** The one settings row. */
export const DAYLIGHT_SETTINGS_ROW_ID = 'settings'

export interface DaylightPhaseHost {
  readSite(): Promise<SiteReading>
  fetchSlice(deviceId: number, cap: string): Promise<unknown>
}

export interface DaylightPhaseServiceDeps {
  readonly settings: RecordKindHandle<DaylightSettingsRowBody>
  readonly host: DaylightPhaseHost
  /** The phase VALUE changed (day to night or back). Telemetry: the caller must not depend on delivery. */
  readonly onTransition: (reading: DaylightPhaseReading) => void
  readonly logger: IScopedLogger
  readonly now?: () => number
}

export class DaylightPhaseService implements IDaylightPhaseProvider {
  private readonly deps: DaylightPhaseServiceDeps
  private readonly now: () => number
  private settings: DaylightSettings | null = null
  /** The last sensor verdict, kept only while the sensor keeps answering. */
  private lastSensor: DaylightPhaseReading | null = null
  /** When the sensor last answered with a number; the hold window of a failed read counts from it. */
  private lastSensorOkAt = 0
  private lastReported: DaylightPhaseReading | null = null
  private lastFallbackReason: string | null = null
  private chain: Promise<unknown> = Promise.resolve()

  constructor(deps: DaylightPhaseServiceDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  // ── the cap ──────────────────────────────────────────────────────────────

  getPhase: IDaylightPhaseProvider['getPhase'] = async () => this.judge()

  getSettings: IDaylightPhaseProvider['getSettings'] = async () => this.loadSettings()

  setSettings: IDaylightPhaseProvider['setSettings'] = async (input) => {
    const settings = DaylightSettingsSchema.parse(input)
    await this.deps.settings.put({ id: DAYLIGHT_SETTINGS_ROW_ID, data: settings })
    return this.serial(async () => {
      this.settings = settings
      // A new source starts from nothing: a stale sensor verdict is never carried over.
      this.lastSensor = null
      this.lastFallbackReason = null
      this.deps.logger.info('daylight source set', {
        meta: { source: settings.source },
        ...(settings.source === 'sensor' ? { tags: { deviceId: settings.deviceId } } : {}),
      })
      return this.evaluate()
    })
  }

  // ── driven by the addon ──────────────────────────────────────────────────

  /** The bounded regular re-check: judge again (a transition is announced by `onTransition`). */
  async recheck(): Promise<void> {
    try {
      await this.judge()
    } catch (err: unknown) {
      this.deps.logger.warn('daylight phase re-check failed', { meta: { error: errMsg(err) } })
    }
  }

  /** A device slice changed: re-judge when it is the sensor, ignore every other device. */
  async onDeviceState(deviceId: number, cap: string): Promise<void> {
    const settings = this.settings
    if (settings === null || settings.source !== 'sensor') return
    if (settings.deviceId !== deviceId || settings.cap !== cap) return
    await this.recheck()
  }

  /** The stored row, for a spec that proves persistence. */
  async readStoredSettings(): Promise<DaylightSettings | null> {
    const row = await this.deps.settings.get(DAYLIGHT_SETTINGS_ROW_ID)
    return row === null ? null : row.data
  }

  // ── judging ──────────────────────────────────────────────────────────────

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work)
    this.chain = next.catch(() => undefined)
    return next
  }

  private async loadSettings(): Promise<DaylightSettings> {
    if (this.settings !== null) return this.settings
    const stored = await this.readStoredSettings()
    this.settings = stored ?? DEFAULT_DAYLIGHT_SETTINGS
    return this.settings
  }

  private judge(): Promise<DaylightStatus> {
    return this.serial(async () => {
      this.settings = await this.loadSettings()
      return this.evaluate()
    })
  }

  private async evaluate(): Promise<DaylightStatus> {
    const settings = this.settings ?? DEFAULT_DAYLIGHT_SETTINGS
    const now = this.now()
    let phase: DaylightPhaseReading | null = null
    let fallbackReason: string | null = null
    if (settings.source === 'sensor') {
      const sensed = await this.readSensor(settings)
      if (sensed.ok) {
        phase = advanceSensorPhase(this.lastSensor, settings, sensed.value, now)
        this.lastSensor = phase
        this.lastSensorOkAt = now
      } else {
        const held = this.lastSensor !== null && now - this.lastSensorOkAt < SENSOR_HOLD_MS
        fallbackReason = held ? `${sensed.reason} — holding the last sensor verdict` : sensed.reason
        if (held) {
          phase = this.lastSensor
        } else {
          this.lastSensor = null
        }
        if (fallbackReason !== this.lastFallbackReason) {
          this.deps.logger.warn(
            held
              ? 'daylight sensor unreadable — holding the last verdict'
              : 'daylight sensor unreadable — the sun answers instead',
            { tags: { deviceId: settings.deviceId }, meta: { reason: sensed.reason } },
          )
        }
      }
    }
    if (settings.source === 'sensor' && fallbackReason === null) {
      if (this.lastFallbackReason !== null) {
        this.deps.logger.info('daylight sensor readable again', {
          tags: { deviceId: settings.deviceId },
        })
      }
    }
    this.lastFallbackReason = fallbackReason
    if (phase === null) phase = await this.sunPhase(now)
    this.report(phase)
    return { phase, configured: settings, fallbackReason, checkedAt: now }
  }

  private async sunPhase(now: number): Promise<DaylightPhaseReading | null> {
    const reading = await this.deps.host.readSite()
    const site = siteFor(reading) ?? zoneOnlySite(reading.timeZone)
    return sunPhaseAt(site, now)
  }

  private async readSensor(
    settings: Extract<DaylightSettings, { source: 'sensor' }>,
  ): Promise<
    { readonly ok: true; readonly value: number } | { readonly ok: false; readonly reason: string }
  > {
    let slice: unknown
    try {
      slice = await this.deps.host.fetchSlice(settings.deviceId, settings.cap)
    } catch (err: unknown) {
      return { ok: false, reason: `the sensor could not be read: ${errMsg(err)}` }
    }
    const value = sensorValueOf(slice, settings.fieldPath)
    return value === null
      ? {
          ok: false,
          reason: `${settings.cap}.${settings.fieldPath} on device ${String(settings.deviceId)} is not a number`,
        }
      : { ok: true, value }
  }

  /** Announce a change of the phase VALUE; the very first judgement is only a baseline. */
  private report(phase: DaylightPhaseReading | null): void {
    const previous = this.lastReported
    this.lastReported = phase
    if (phase === null || previous === null || previous.phase === phase.phase) return
    this.deps.logger.info('daylight phase changed', {
      meta: { phase: phase.phase, source: phase.source, since: phase.since },
    })
    this.deps.onTransition(phase)
  }
}
