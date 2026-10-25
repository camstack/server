import type { Alert } from '@camstack/types'

/**
 * D911 — a robot camera that cannot open its monitor because the privacy PIN
 * is missing (or wrong) needs the OPERATOR, not another retry.
 *
 * `nodedreame` reports the refusal as `startMonitor refused (code -1)`; it adds
 * `; device likely requires an accessCode` only when no code was configured.
 * Code -1 WITH a code set therefore means the PIN was rejected.
 */
export type PinRefusal = 'missing' | 'rejected'

const REFUSED_CODE_MINUS_ONE = /startMonitor refused \(code -1\)/

/** The refusal an error carries, or `null` when it is some other failure. */
export function classifyPinRefusal(err: unknown, accessCodeSet: boolean): PinRefusal | null {
  const message = err instanceof Error ? err.message : String(err)
  if (!REFUSED_CODE_MINUS_ONE.test(message)) return null
  return accessCodeSet ? 'rejected' : 'missing'
}

export function pinAlertId(deviceId: number): string {
  return `dreame.pin-required:${String(deviceId)}`
}

export function buildPinAlert(deviceId: number, deviceName: string, reason: PinRefusal): Alert {
  const now = Date.now()
  return {
    id: pinAlertId(deviceId),
    category: 'device.credentials-required',
    severity: 'critical',
    title: reason === 'missing' ? 'Camera PIN required' : 'Camera PIN rejected',
    message:
      reason === 'missing'
        ? `${deviceName} needs its camera PIN before its video can open. Enter it in the device settings.`
        : `${deviceName} refused the camera PIN that is set. Enter the correct PIN in the device settings.`,
    action: { label: 'Enter PIN', href: `/devices/${String(deviceId)}`, navigation: 'app' },
    status: 'active',
    read: false,
    createdAt: now,
    updatedAt: now,
    source: { type: 'device', id: String(deviceId) },
    metadata: { episodeKey: reason },
  }
}

export interface PinAttentionPorts {
  readonly deviceId: number
  readonly deviceName: () => string
  readonly emit: (alert: Alert) => Promise<void>
  readonly resolve: (alertId: string) => Promise<void>
}

/**
 * One device's PIN episode. It raises the alert ONCE per episode, and while the
 * episode is open it tells the wake path to stand down: a refusal that needs the
 * operator is terminal until the PIN setting changes, so the broker's 30 s
 * re-dial must not re-open the monitor and fail again.
 */
export class PinAttention {
  private open: PinRefusal | null = null

  constructor(private readonly ports: PinAttentionPorts) {}

  /** True while the PIN is known to be unusable — the wake must not try. */
  get blocked(): boolean {
    return this.open !== null
  }

  /** A wake failed. Raises the alert on the first refusal of an episode. */
  async refused(reason: PinRefusal): Promise<'raised' | 'already-open'> {
    if (this.open !== null) return 'already-open'
    this.open = reason
    await this.ports.emit(buildPinAlert(this.ports.deviceId, this.ports.deviceName(), reason))
    return 'raised'
  }

  /** A monitor opened: the PIN works, the episode is over. */
  async succeeded(): Promise<boolean> {
    return this.settingChanged()
  }

  /**
   * The PIN setting changed: the episode is no longer known to be terminal, so
   * the next wake tries again. The alert is resolved here — a still-wrong PIN
   * raises a fresh episode on that wake.
   */
  async settingChanged(): Promise<boolean> {
    if (this.open === null) return false
    this.open = null
    await this.ports.resolve(pinAlertId(this.ports.deviceId))
    return true
  }
}
