/**
 * A login that needs a new one-time code raises ONE operator alert.
 * Further failures in the same episode do not raise another.
 */
import { EventCategory, type Alert } from '@camstack/types'
import { OTP_ALERT_ID } from './constants.js'

export type OtpAlertReason = 'otp' | 'captcha'

export function buildOtpAlert(now: number, reason: OtpAlertReason): Alert {
  const otp = reason === 'otp'
  return {
    id: OTP_ALERT_ID,
    category: EventCategory.AddonError,
    severity: 'error',
    title: otp ? 'Alexa needs a new sign-in code' : 'Alexa sign-in needs a captcha',
    message: otp
      ? 'Amazon asked for a one-time code before Echo devices can speak. Open Alexa → Speak on Echo and enter the code.'
      : 'Amazon asked for a captcha. Wait a few minutes, then sign in again on Alexa → Speak on Echo.',
    action: { label: 'Sign in', href: '/addon/import-alexa', navigation: 'app' },
    status: 'active',
    read: false,
    createdAt: now,
    updatedAt: now,
    source: { type: 'addon', id: 'import-alexa' },
    metadata: { episodeKey: reason },
  }
}

export interface OtpAttentionPorts {
  readonly now: () => number
  readonly emit: (alert: Alert) => Promise<void>
  readonly resolve: (alertId: string) => Promise<void>
}

export class OtpAttention {
  private open: OtpAlertReason | null = null

  constructor(private readonly ports: OtpAttentionPorts) {}

  /** First need in an episode emits the alert. A repeat does not. */
  async needed(reason: OtpAlertReason): Promise<'raised' | 'already-open'> {
    if (this.open !== null) return 'already-open'
    this.open = reason
    await this.ports.emit(buildOtpAlert(this.ports.now(), reason))
    return 'raised'
  }

  async cleared(): Promise<void> {
    if (this.open === null) return
    this.open = null
    await this.ports.resolve(OTP_ALERT_ID)
  }
}
