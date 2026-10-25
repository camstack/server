/**
 * The device SWITCH, as a notification.
 *
 * The operator switches a device off and expects to be told — the same way
 * they are told it dropped off. What they must never be told is that it BROKE:
 * D62 is explicit that an off switch is reported off, and a camera that an
 * operator turned off looking identical to a camera that died is how a working
 * installation reads as a failing one.
 *
 * So these two kinds are their own vocabulary (`device-disabled` /
 * `device-enabled`), their own subject family (`device-switch:<id>`, so the
 * switch does not share a dedup slot with liveness), and their own sentences.
 */
import type { SystemEvent } from '@camstack/types'
import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { NcDeviceLookup } from '../device-directory.js'
import { incomingFromSystemEvent } from '../event-intake.js'
import { NC_LANGUAGES, NcTextCatalog } from '../text-catalog.js'

function switchEvent(
  category: 'device.disabled' | 'device.enabled',
  deviceId: number,
): SystemEvent {
  return {
    id: `sw-${category}-${deviceId}`,
    timestamp: new Date(2_000),
    source: { type: 'device', id: deviceId },
    category,
    data: { deviceId, integrationId: 'rtsp' },
  }
}

/** 102 is a camera, and the fixture says so: the mirror supplies the NAME the
 *  sentence uses and the TYPE a rule narrows on
 *  (`system-event-device-kind.spec.ts`). */
const CAMERAS: NcDeviceLookup = (deviceId: number) => ({
  deviceId,
  type: DeviceType.Camera,
  name: 'Front door',
  isCamera: true,
})

describe('the device switch intake', () => {
  it('turns device.disabled into device-disabled, on its own subject', () => {
    const incoming = incomingFromSystemEvent(switchEvent('device.disabled', 102), CAMERAS)
    expect(incoming?.subject.systemEvent).toMatchObject({
      kind: 'device-disabled',
      subject: 'device-switch:102',
      titleKey: 'system.device-disabled.title',
      bodyKey: 'system.device-disabled.body',
      textParams: { deviceId: '102', deviceName: 'Front door' },
      deviceId: 102,
    })
    expect(incoming?.log().tags).toEqual({ deviceId: 102 })
  })

  it('turns device.enabled into device-enabled', () => {
    const incoming = incomingFromSystemEvent(switchEvent('device.enabled', 102), CAMERAS)
    expect(incoming?.subject.systemEvent).toMatchObject({
      kind: 'device-enabled',
      subject: 'device-switch:102',
      deviceId: 102,
    })
  })

  it('does not share a dedup subject with liveness', () => {
    const disabled = incomingFromSystemEvent(switchEvent('device.disabled', 102), CAMERAS)
    const offline = incomingFromSystemEvent(
      {
        id: 'off-1',
        timestamp: new Date(2_000),
        source: { type: 'device', id: 102 },
        category: 'device.offline',
        data: { deviceId: 102 },
      },
      CAMERAS,
    )
    expect(disabled?.subject.systemEvent?.subject).not.toBe(offline?.subject.systemEvent?.subject)
  })

  it('rejects a switch event with no device identity', () => {
    expect(
      incomingFromSystemEvent(
        {
          id: 'sw-bad',
          timestamp: new Date(2_000),
          source: { type: 'device', id: 102 },
          category: 'device.disabled',
          data: { integrationId: 'rtsp' },
        },
        CAMERAS,
      ),
    ).toBeNull()
  })

  it('says SWITCHED OFF and never offline or broken, in every language', () => {
    for (const language of NC_LANGUAGES) {
      const catalog = new NcTextCatalog({ language })
      for (const kind of ['device-disabled', 'device-enabled'] as const) {
        const title = catalog.text({ key: `system.${kind}.title`, vars: {} })
        const body = catalog.text({
          key: `system.${kind}.body`,
          vars: { deviceId: '102', deviceName: 'Front door' },
        })
        expect(title.length, `${kind}.title (${language})`).toBeGreaterThan(0)
        expect(body).toContain('Front door')
        // D62: a switched-off camera is never reported as offline or broken.
        for (const forbidden of ['offline', 'error', 'errore', 'guasto']) {
          expect(`${title} ${body}`.toLowerCase()).not.toContain(forbidden)
        }
      }
    }
  })
})
