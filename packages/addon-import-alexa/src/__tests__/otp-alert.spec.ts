import { EventCategory, type Alert } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { OTP_ALERT_ID } from '../speak/constants.js'
import { OtpAttention } from '../speak/otp-alert.js'

describe('OtpAttention', () => {
  it('raises one alert for the episode and clears it after a successful sign-in', async () => {
    const emitted: Alert[] = []
    const resolved: string[] = []
    const attention = new OtpAttention({
      now: () => 10,
      emit: async (alert) => {
        emitted.push(alert)
      },
      resolve: async (id) => {
        resolved.push(id)
      },
    })
    expect(await attention.needed('otp')).toBe('raised')
    expect(await attention.needed('otp')).toBe('already-open')
    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.id).toBe(OTP_ALERT_ID)
    expect(emitted[0]?.category).toBe(EventCategory.AddonError)
    await attention.cleared()
    expect(resolved).toEqual([OTP_ALERT_ID])
    expect(await attention.needed('captcha')).toBe('raised')
    expect(emitted).toHaveLength(2)
  })
})
