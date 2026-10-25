/**
 * The switch for the TRANSPORT census - a SYSTEM SETTING, not an env var.
 *
 * The census it arms counts three planes (`http`, `ws`, `mesh`); this module
 * still owns the row named `http-request-census` because renaming a persisted
 * key to improve a noun is how a diagnostic silently stops restoring across
 * the release that renamed it. The key is an identifier, not a description.
 *
 * ## Why the arm deadline is persisted
 *
 * `FleetReadCensus` arms from `CAMSTACK_FLEET_READ_CENSUS_MS` at construction
 * because "the storm is at BOOT - by the time a process is up enough to
 * receive an action, the window being investigated has closed". That reasoning
 * is right and its conclusion is not: an env var needs a container recreation
 * to change, cannot be switched off, and the operator has asked for no more of
 * them.
 *
 * A persisted DEADLINE satisfies both halves. The operator arms a window
 * through `system.setLoggingSettings`, restarts the hub, and the window is still
 * running when the clients reconnect - `restore()` re-arms the REMAINDER at
 * boot, before `app.listen`, so not one HTTP request is missed. Switching it
 * off is another call and takes effect immediately. And because what is stored
 * is a deadline rather than a flag, a census somebody forgot expires on its
 * own instead of taxing every request until the next release.
 *
 * ## Never longer than was asked for
 *
 * What is written is `census.armedUntilMs` - the deadline AFTER the census
 * clamped the requested window. A restore therefore cannot extend a window
 * past the clamp, and the two numbers cannot drift, because there is only one.
 *
 * ## `persisted` is read, never remembered
 *
 * The provider is rebuilt per request, so there is nowhere to keep "the last
 * write worked". `status()` re-reads the row and compares it with the live
 * census instead. That is one KV read on an operator gesture, and unlike a
 * cached flag it cannot claim a window survives a restart when the write that
 * would have made it survive failed.
 */

import type { IScopedLogger, RequestCensusStatus } from '@camstack/types'
import { errMsg } from '@camstack/types'
import { DEFAULT_REPORT_EVERY_MS, type HttpRequestCensus } from '../trpc/http-request-census.js'
import type { SettingsStoreGateway } from './site-location.js'

/** The `system-settings` row this module owns. */
export const REQUEST_CENSUS_KEY = 'http-request-census'

const SYSTEM_SETTINGS_COLLECTION = 'system-settings'

/** The persisted row. Every field optional - an older row must still read. */
export interface RequestCensusRecord {
  /** Epoch ms the armed window closes at. 0 or absent means disarmed. */
  readonly armedUntilMs?: number
  readonly reportEveryMs?: number
  readonly updatedAt?: number
}

/**
 * The arm request, as it reaches this service.
 *
 * NOT a wire type any more. `system.setRequestCensus` was retired on
 * 2026-08-27 (D245) so the window has exactly ONE write authority - the
 * logging settings document - and `LoggingSettingsService` is this service's
 * only caller. What arrives here is already a field of that document's patch.
 */
export interface RequestCensusArmInput {
  /** `0` disarms. Anything positive arms for that long, clamped by the census. */
  readonly armMs: number
  readonly reportEveryMs?: number
}

export interface RequestCensusServiceDeps {
  readonly census: HttpRequestCensus
  readonly store: SettingsStoreGateway
  readonly logger?: IScopedLogger
  readonly now?: () => number
}

/**
 * Arm / disarm / read the census, keeping the persisted deadline in step.
 */
export class RequestCensusService {
  private readonly census: HttpRequestCensus
  private readonly store: SettingsStoreGateway
  private readonly logger: IScopedLogger | undefined
  private readonly now: () => number

  constructor(deps: RequestCensusServiceDeps) {
    this.census = deps.census
    this.store = deps.store
    this.logger = deps.logger
    this.now = deps.now ?? Date.now
  }

  /** The window as it stands, plus whether it would survive a restart. */
  async status(): Promise<RequestCensusStatus> {
    const record = await this.read()
    return { ...this.census.snapshot(), persisted: this.matchesStored(record) }
  }

  /**
   * `armMs: 0` disarms; anything positive arms for that long (clamped).
   *
   * The census is armed BEFORE the write, so a settings-store that is down
   * still gives the operator a live measurement - it just says so, both in the
   * response (`persisted: false`) and in the log. Silently reporting a durable
   * arm that is not durable is how a whole boot window gets measured, lost to
   * a restart, and blamed on the instrument.
   */
  async set(input: RequestCensusArmInput): Promise<RequestCensusStatus> {
    const reportEveryMs = input.reportEveryMs ?? DEFAULT_REPORT_EVERY_MS
    if (input.armMs <= 0) this.census.disarm('operator-disarmed')
    else this.census.arm(input.armMs, reportEveryMs)

    const record: RequestCensusRecord = {
      armedUntilMs: this.census.armedUntilMs,
      reportEveryMs,
      updatedAt: this.now(),
    }
    const persisted = await this.write(record)
    this.logger?.info('transport census switched', {
      meta: {
        armed: this.census.armed,
        armedUntilMs: this.census.armedUntilMs,
        reportEveryMs,
        persisted,
      },
    })
    return { ...this.census.snapshot(), persisted }
  }

  /**
   * Re-arm the remainder of a window that was armed before this boot.
   *
   * Called once, before `app.listen`, so the census is already counting when
   * the first client reconnects. Never re-writes the row: a restore that
   * refreshed the deadline would make a forgotten census immortal across
   * restarts, which is the one failure mode a deadline exists to prevent.
   */
  async restore(): Promise<boolean> {
    const record = await this.read()
    const until = record?.armedUntilMs
    if (typeof until !== 'number' || !Number.isFinite(until) || until <= 0) return false
    const remainingMs = until - this.now()
    if (remainingMs <= 0) {
      this.logger?.info('transport census not restored - window already expired', {
        meta: { armedUntilMs: until },
      })
      return false
    }
    this.census.arm(remainingMs, record?.reportEveryMs ?? DEFAULT_REPORT_EVERY_MS)
    this.logger?.info('transport census restored from system-settings', {
      meta: { remainingMs, armedUntilMs: this.census.armedUntilMs },
    })
    return true
  }

  /** True when the stored deadline is the one the live census is running. */
  private matchesStored(record: RequestCensusRecord | null): boolean {
    const stored = record?.armedUntilMs ?? 0
    return stored === this.census.armedUntilMs
  }

  private async read(): Promise<RequestCensusRecord | null> {
    try {
      const raw = await this.store.get({
        collection: SYSTEM_SETTINGS_COLLECTION,
        key: REQUEST_CENSUS_KEY,
      })
      return toRecord(raw)
    } catch (err: unknown) {
      // A read that fails is not a disarm: it changes nothing about the live
      // census. It is logged because a branch that drops work silently reads
      // as "never happened".
      this.logger?.warn('transport census settings read failed', {
        meta: { error: errMsg(err) },
      })
      return null
    }
  }

  private async write(record: RequestCensusRecord): Promise<boolean> {
    try {
      await this.store.set({
        collection: SYSTEM_SETTINGS_COLLECTION,
        key: REQUEST_CENSUS_KEY,
        value: record,
      })
      return true
    } catch (err: unknown) {
      this.logger?.warn(
        'transport census armed in memory but NOT persisted - it will not survive a restart',
        { meta: { error: errMsg(err) } },
      )
      return false
    }
  }
}

/** Structural read of the stored row. Anything unrecognised reads as absent. */
export function toRecord(value: unknown): RequestCensusRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const armedUntilMs: unknown = Reflect.get(value, 'armedUntilMs')
  const reportEveryMs: unknown = Reflect.get(value, 'reportEveryMs')
  const updatedAt: unknown = Reflect.get(value, 'updatedAt')
  return {
    ...(typeof armedUntilMs === 'number' && Number.isFinite(armedUntilMs) ? { armedUntilMs } : {}),
    ...(typeof reportEveryMs === 'number' && Number.isFinite(reportEveryMs)
      ? { reportEveryMs }
      : {}),
    ...(typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? { updatedAt } : {}),
  }
}
