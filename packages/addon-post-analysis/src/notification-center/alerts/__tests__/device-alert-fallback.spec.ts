/**
 * The centre's fallback settings must BE the shipped defaults.
 *
 * `NC_DEVICE_ALERT_FALLBACK` in `notification-center/index.ts` restates the
 * three numbers rather than importing them: the settings schema lives in
 * `pipeline-analytics`, and the centre importing its host addon's settings
 * module would be the wrong direction of dependency. A restated constant is
 * free to drift, so this is the thing that fails when it does.
 *
 * The drift that matters is the silent one. If the fallback ever said
 * `notifyRecovery: false` while the form said `true`, an install that had never
 * opened the settings page would quietly stop sending the all-clear — and it
 * would look exactly like a hub where nothing had recovered.
 */
import { describe, expect, it } from 'vitest'
import { DEVICE_ALERT_DEFAULTS } from '../../../pipeline-analytics/device-alert-settings.js'
import { NC_DEVICE_ALERT_FALLBACK_FOR_TEST } from '../../index.js'

describe('the centre’s fallback agrees with the settings schema', () => {
  it('matches every shipped default', () => {
    expect(NC_DEVICE_ALERT_FALLBACK_FOR_TEST).toEqual({
      batteryLowPercent: DEVICE_ALERT_DEFAULTS.batteryLowPercent,
      renotifyMinutes: DEVICE_ALERT_DEFAULTS.alertRenotifyMinutes,
      notifyRecovery: DEVICE_ALERT_DEFAULTS.alertNotifyRecovery,
    })
  })

  it('never falls back to a switched-off feature', () => {
    // The direction that would be invisible: a hub with low batteries and
    // nothing to say about them reads as a hub with healthy batteries.
    expect(NC_DEVICE_ALERT_FALLBACK_FOR_TEST.batteryLowPercent).toBeGreaterThan(0)
    expect(NC_DEVICE_ALERT_FALLBACK_FOR_TEST.notifyRecovery).toBe(true)
  })
})
