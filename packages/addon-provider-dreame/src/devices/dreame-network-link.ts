/**
 * The robot's `network-link` slice from what nodedreame 1.12 can say.
 *
 * The Dreame cloud does not return RSSI or SSID for these vacuums (the
 * library says so), but the robot keeps a Wi-Fi SIGNAL MAP, and
 * `VacuumDevice.getCurrentSignal()` returns the bars (1–4) at the robot's own
 * position — 0 = unreached, null = unknown. A signal map is a wifi link, so a
 * reading makes the type `wifi`; an unknown reading changes nothing.
 */
import type { IScopedLogger } from '@camstack/types'
import {
  NETWORK_LINK_UNKNOWN,
  type NetworkLinkStatus,
  signalPercentFromBars,
} from '@camstack/types'

/** Dreame draws the signal map in four bars. */
export const DREAME_WIFI_SIGNAL_BARS = 4

/** `null` = nothing learned (keep the previous slice). */
export function networkLinkFromBars(bars: number | null, now: number): NetworkLinkStatus | null {
  if (bars === null || !Number.isFinite(bars)) return null
  return {
    type: 'wifi',
    // 0 = "unreached" on the map: the robot is on wifi but the strength here
    // is not known — never drawn as 0 %.
    signal: bars === 0 ? null : signalPercentFromBars(bars, DREAME_WIFI_SIGNAL_BARS),
    lastUpdated: now,
  }
}

export const NETWORK_LINK_CAP_NAME = 'network-link'
/** The only source is the Wi-Fi signal map (a cloud round trip), and the bars
 *  at the dock do not change by the minute. */
export const NETWORK_LINK_REFRESH_MS = 30 * 60_000

/** The slice store the monitor writes — `BaseDevice.runtimeState`, or a fake. */
export interface NetworkLinkSliceStore {
  getCapState<T>(capName: string): T | null
  setCapState(capName: string, value: NetworkLinkStatus): void
}

export interface NetworkLinkMonitorDeps {
  readonly deviceId: number
  readonly logger: IScopedLogger
  readonly runtimeState: NetworkLinkSliceStore
  /** The bars at the robot's position, or null when the robot is not reachable right now. */
  readonly readBars: () => Promise<number | null> | null
  readonly now?: () => number
  readonly refreshMs?: number
}

/**
 * ONE reader of the robot's link for every device that shows it — the vacuum
 * and its camera child are two devices of one robot, and the second must not
 * be a second implementation of the first (the camera showed no signal because
 * only the vacuum registered the cap, 2026-09-06). The read path serves the
 * slice; `refresh` writes it, bounded and best-effort: a failure keeps the
 * last slice, the first read per device is said at INFO with the raw bars,
 * the first failure at WARN.
 */
export class DreameNetworkLinkMonitor {
  private timer: ReturnType<typeof setInterval> | null = null
  private reported = false
  private failureWarned = false

  constructor(private readonly deps: NetworkLinkMonitorDeps) {}

  /** The `network-link` provider: answers from the slice, unknown until a read lands. */
  provider(): { getStatus: () => Promise<NetworkLinkStatus> } {
    return {
      getStatus: async () =>
        this.deps.runtimeState.getCapState<NetworkLinkStatus>(NETWORK_LINK_CAP_NAME) ??
        NETWORK_LINK_UNKNOWN,
    }
  }

  /** Seed the slice so a read before the first refresh answers "unknown", not nothing. */
  seed(): void {
    if (this.deps.runtimeState.getCapState<NetworkLinkStatus>(NETWORK_LINK_CAP_NAME) === null) {
      this.deps.runtimeState.setCapState(NETWORK_LINK_CAP_NAME, NETWORK_LINK_UNKNOWN)
    }
  }

  /** A first read now, then one every `refreshMs`. */
  start(): void {
    this.stop()
    void this.refresh('activate')
    this.timer = setInterval(
      () => void this.refresh('periodic'),
      this.deps.refreshMs ?? NETWORK_LINK_REFRESH_MS,
    )
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  async refresh(reason: 'activate' | 'periodic'): Promise<void> {
    const pending = this.deps.readBars()
    if (pending === null) return
    const now = this.deps.now ?? Date.now
    try {
      const bars = await pending
      const next = networkLinkFromBars(bars, now())
      this.deps.logger[this.reported ? 'debug' : 'info']('network link read', {
        tags: { deviceId: this.deps.deviceId },
        meta: { reason, rawBars: bars, ...next },
      })
      this.reported = true
      if (next !== null) this.deps.runtimeState.setCapState(NETWORK_LINK_CAP_NAME, next)
    } catch (err) {
      const level = this.failureWarned ? 'debug' : 'warn'
      this.failureWarned = true
      this.deps.logger[level]('network link read failed — keeping the last slice', {
        tags: { deviceId: this.deps.deviceId },
        meta: { reason, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }
}
