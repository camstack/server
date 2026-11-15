/**
 * A sensor, button or lock is titled "<device> <state>", and a camera going
 * offline or coming back is titled with its name. An operator title still
 * wins. A row with no device name keeps the rule name.
 */
import { describe, expect, it } from 'vitest'
import { buildTemplateVars, renderRowTitle } from '../dispatcher.js'
import type { NcOutboxEntry, NcOutboxPayload } from '../outbox.js'
import { NcTextCatalog } from '../text-catalog.js'

const AT = 1_753_000_000_000

function row(
  subject: NcOutboxPayload['subject'],
  over: {
    readonly recordKind?: NcOutboxEntry['recordKind']
    readonly title?: string
    readonly ruleName?: string
  } = {},
): NcOutboxEntry {
  return {
    id: 'rule-1:ev-1:tgt-1',
    ruleId: 'rule-1',
    targetId: 'tgt-1',
    deviceId: subject.deviceId,
    recordKind: over.recordKind ?? 'device-event',
    recordId: 'ev-1',
    status: 'pending',
    attempts: 0,
    createdAt: AT,
    updatedAt: AT,
    nextAttemptAt: AT,
    payload: {
      ruleName: over.ruleName ?? 'Apertura porte',
      delivery: 'device-event',
      priority: 3,
      media: 'none',
      ...(over.title !== undefined ? { template: { title: over.title } } : {}),
      subject,
    },
  }
}

function title(texts: NcTextCatalog, entry: NcOutboxEntry, deviceName = ''): string {
  return renderRowTitle(texts, entry, buildTemplateVars(texts, entry, deviceName, []))
}

function liveness(
  kind: 'device-offline' | 'device-online' | 'camera-offline' | 'camera-online',
  deviceName: string | undefined,
  titleTemplate?: string,
): NcOutboxEntry {
  return row(
    {
      deviceId: deviceName === undefined ? 0 : 4,
      className: 'event',
      zones: [],
      timestamp: AT,
      systemEvent: {
        kind,
        subject: 'device:4',
        titleKey: `system.${kind}.title`,
        bodyKey: `system.${kind}.body`,
        ...(deviceName !== undefined
          ? { textParams: { deviceName }, deviceId: 4 }
          : { textParams: {}, data: {} }),
        data: {},
      },
    },
    {
      recordKind: 'system-event',
      ruleName: 'Cameras',
      ...(titleTemplate !== undefined ? { title: titleTemplate } : {}),
    },
  )
}

describe('sensor, button and lock titles', () => {
  const en = new NcTextCatalog({ language: 'en' })
  const italian = new NcTextCatalog({ language: 'it' })

  it('names the device and the state it moved to', () => {
    const unlocked = row({
      deviceId: 4,
      className: 'lock',
      zones: [],
      timestamp: AT,
      sensor: { deviceId: 8, name: 'Front door' },
      sensorState: 'unlocked',
    })
    expect(title(en, unlocked)).toBe('Front door unlocked')
    expect(title(italian, unlocked)).toBe('Front door aperta')

    const open = row({
      deviceId: 4,
      className: 'cover',
      zones: [],
      timestamp: AT,
      sensor: { deviceId: 9, name: 'Garage door' },
      sensorState: 'open',
    })
    expect(title(en, open)).toBe('Garage door open')

    const pressed = row({
      deviceId: 4,
      className: 'button',
      zones: [],
      timestamp: AT,
      sensor: { deviceId: 10, name: 'Button 2' },
      eventType: 'press',
    })
    expect(title(en, pressed)).toBe('Button 2 pressed')
    expect(title(italian, pressed)).toBe('Button 2 premuto')
  })

  it('an authored title still wins', () => {
    const entry = row(
      {
        deviceId: 4,
        className: 'lock',
        zones: [],
        timestamp: AT,
        sensor: { deviceId: 8, name: 'Front door' },
        sensorState: 'unlocked',
      },
      { title: '{{rule}}' },
    )
    expect(title(en, entry)).toBe('Apertura porte')
  })

  it('a sensor row with no device name keeps the rule name', () => {
    const entry = row({
      deviceId: 4,
      className: 'lock',
      zones: [],
      timestamp: AT,
      sensor: { deviceId: 8, name: '' },
      sensorState: 'unlocked',
    })
    expect(title(en, entry)).toBe('Apertura porte')
    expect(title(en, entry)).not.toBe('')
  })
})

describe('camera and device online/offline titles', () => {
  const en = new NcTextCatalog({ language: 'en' })
  const italian = new NcTextCatalog({ language: 'it' })

  it('puts the device name before the state', () => {
    expect(title(en, liveness('device-offline', 'Garden camera'))).toBe('Garden camera offline')
    expect(title(en, liveness('device-online', 'Garden camera'))).toBe('Garden camera back online')
    expect(title(en, liveness('camera-offline', 'Garden camera'))).toBe('Garden camera offline')
    expect(title(en, liveness('camera-online', 'Garden camera'))).toBe('Garden camera back online')
    expect(title(italian, liveness('device-offline', 'Giardino'))).toBe(
      'Giardino non raggiungibile',
    )
    expect(title(italian, liveness('device-online', 'Giardino'))).toBe('Giardino di nuovo online')
  })

  it('an authored title still wins', () => {
    expect(title(en, liveness('device-offline', 'Garden camera', '{{rule}}'))).toBe('Cameras')
  })

  it('a row with no device name keeps the rule name', () => {
    const entry = liveness('device-offline', undefined)
    expect(title(en, entry)).toBe('Cameras')
    expect(title(en, entry)).not.toBe('')
  })
})
