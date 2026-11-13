/**
 * Shipped sentences name the event. An operator template and a hub Texts
 * override still win; these cases cover only the defaults.
 */
import { DeviceType, EventCategory, type AlarmArmMode, type SystemEvent } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { alarmTransition } from '../alarm/alarm-transitions.js'
import type { NcDeviceLookup } from '../device-directory.js'
import { buildTemplateVars, renderRowTitle } from '../dispatcher.js'
import {
  incomingFromAlarmTransition,
  incomingFromProviderConsumableBand,
  incomingFromSystemEvent,
} from '../event-intake.js'
import type { NcOutboxEntry, NcOutboxPayload } from '../outbox.js'
import { NcTextCatalog } from '../text-catalog.js'

const AT = 1_753_000_000_000
const MODES: readonly AlarmArmMode[] = ['home', 'away', 'night']

const FOUNTAIN: NcDeviceLookup = () => ({
  deviceId: 12,
  type: DeviceType.PetFountain,
  name: 'Fontanella',
  isCamera: false,
})

function row(subject: NcOutboxPayload['subject']): NcOutboxEntry {
  return {
    id: 'rule-1:ev-1:tgt-1',
    ruleId: 'rule-1',
    targetId: 'tgt-1',
    deviceId: subject.deviceId,
    recordKind: 'system-event',
    recordId: 'ev-1',
    status: 'pending',
    attempts: 0,
    createdAt: AT,
    updatedAt: AT,
    nextAttemptAt: AT,
    payload: {
      ruleName: 'Consumabili',
      delivery: 'system-event',
      priority: 3,
      media: 'none',
      subject,
    },
  }
}

function words(
  texts: NcTextCatalog,
  subject: NcOutboxPayload['subject'],
): { readonly title: string; readonly body: string } {
  const entry = row(subject)
  const vars = buildTemplateVars(texts, entry, 'fontanella', [])
  return {
    title: renderRowTitle(texts, entry, vars),
    body: texts.text({ key: subject.systemEvent?.bodyKey ?? '', vars }),
  }
}

describe('shipped copy names the event', () => {
  it('a timelapse window names the hours, not the rule', () => {
    const vars = { rule: 'Notte retro', from: '07:00', to: '09:00' }
    expect(new NcTextCatalog().text({ key: 'timelapse.body.window', vars })).toBe(
      'Sequence 07:00→09:00',
    )
    expect(new NcTextCatalog({ language: 'it' }).text({ key: 'timelapse.body.window', vars })).toBe(
      'Sequenza 07:00→09:00',
    )
  })

  it('a low tank is titled with the device and the item in the notification language', () => {
    const incoming = incomingFromProviderConsumableBand({
      facts: { eventId: 'e1', timestamp: AT, category: 'consumable', data: {} },
      deviceId: 12,
      band: 'low',
      item: { key: 'water', label: 'Water', form: 'tank' },
      attention: 'low',
      identity: FOUNTAIN(12),
    })
    const systemEvent = incoming.subject.systemEvent
    expect(systemEvent?.titleKey).toBe('system.device-consumable-low.title.tank')
    expect(systemEvent?.textParams?.['itemKey']).toBe('water')
    const subject: NcOutboxPayload['subject'] = {
      deviceId: 12,
      className: 'event',
      timestamp: AT,
      zones: [],
      systemEvent: {
        kind: 'device-consumable-low',
        subject: systemEvent?.subject ?? 'consumable:12:water',
        titleKey: systemEvent?.titleKey,
        bodyKey: systemEvent?.bodyKey,
        textParams: systemEvent?.textParams,
        data: {},
      },
    }
    expect(words(new NcTextCatalog(), subject)).toEqual({
      title: 'Fontanella: water almost empty',
      body: 'water is nearly empty',
    })
    expect(words(new NcTextCatalog({ language: 'it' }), subject)).toEqual({
      title: 'Fontanella: acqua quasi finita',
      body: 'acqua è quasi vuota',
    })
    expect(words(new NcTextCatalog({ language: 'it' }), subject).body).not.toContain('Fontanella')
    expect(words(new NcTextCatalog({ language: 'it' }), subject).body).not.toContain('Water')
  })

  it('a disarm names the alarm, and who did it only when that person is known', () => {
    expect(new NcTextCatalog().text({ key: 'system.alarm-disarmed.title' })).toBe('Alarm disarmed')
    expect(new NcTextCatalog({ language: 'it' }).text({ key: 'system.alarm-disarmed.title' })).toBe(
      'Allarme disinserito',
    )
    const by = alarmTransition({
      previous: 'armed_away',
      next: 'disarmed',
      modes: MODES,
      at: 11,
      actorLabel: 'Gianluca',
    })
    expect(by?.actorLabel).toBe('Gianluca')
    const named = incomingFromAlarmTransition({
      transition: by ?? {
        kind: 'alarm-disarmed',
        state: 'disarmed',
        previous: 'armed_away',
        at: 11,
      },
      panelDeviceId: 7,
      lookup: () => ({ deviceId: 7, type: 'alarm-panel', name: 'Casa', isCamera: false }),
    })
    expect(named.subject.systemEvent?.titleKey).toBe('system.alarm-disarmed.title.by')
    expect(named.subject.systemEvent?.textParams?.['actorLabel']).toBe('Gianluca')
    expect(
      new NcTextCatalog().text({
        key: 'system.alarm-disarmed.title.by',
        vars: { actorLabel: 'Gianluca' },
      }),
    ).toBe('Alarm disarmed by Gianluca')
    expect(
      new NcTextCatalog({ language: 'it' }).text({
        key: 'system.alarm-disarmed.title.by',
        vars: { actorLabel: 'Gianluca' },
      }),
    ).toBe('Allarme disinserito da Gianluca')
    const alone = alarmTransition({
      previous: 'armed_away',
      next: 'disarmed',
      modes: MODES,
      at: 12,
      autoCleared: true,
      actorLabel: 'Gianluca',
    })
    expect(alone?.actorLabel).toBeUndefined()
  })

  it('a device command names the addon, not its provider id', () => {
    const event: SystemEvent = {
      id: 'ev-1',
      timestamp: new Date(AT),
      source: { type: 'device', id: 5383 },
      category: EventCategory.DeviceCommandSettled,
      data: {
        deviceId: 5383,
        action: 'powerSource.forceRestart',
        outcome: 'confirmed',
        actor: { kind: 'addon', addonId: 'provider-velux' },
        at: AT,
      },
    }
    const incoming = incomingFromSystemEvent(event, (deviceId) => ({
      deviceId,
      type: DeviceType.Sensor,
      name: 'Velux gateway',
      isCamera: false,
    }))
    expect(incoming?.subject.systemEvent?.textParams?.['actorLabel']).toBe('Velux')
    const systemEvent = incoming?.subject.systemEvent
    const subject: NcOutboxPayload['subject'] = {
      deviceId: 5383,
      className: 'event',
      timestamp: AT,
      zones: [],
      systemEvent: {
        kind: 'device-command',
        subject: systemEvent?.subject ?? 'device-command',
        titleKey: systemEvent?.titleKey,
        bodyKey: systemEvent?.bodyKey,
        textParams: systemEvent?.textParams,
        data: {},
      },
    }
    const body = words(new NcTextCatalog(), subject).body
    expect(body).toContain('Velux')
    expect(body).not.toContain('provider-velux')
  })

  it('an appliance cycle body does not repeat the device already in the title', () => {
    const vars = {
      device: 'lavatrice',
      afterDuration: ' after 52 minutes',
      usedEnergy: ' and used 0.84 kWh',
    }
    const en = new NcTextCatalog().text({ key: 'appliance.finished.body', vars })
    expect(en).toBe('Finished after 52 minutes and used 0.84 kWh')
    expect(en).not.toContain('lavatrice')
    const itVars = {
      device: 'lavatrice',
      afterDuration: ' dopo 52 minuti',
      usedEnergy: ' e ha consumato 0,84 kWh',
    }
    const it = new NcTextCatalog({ language: 'it' }).text({
      key: 'appliance.finished.body',
      vars: itVars,
    })
    expect(it).toBe('Ha terminato dopo 52 minuti e ha consumato 0,84 kWh')
    expect(it).not.toContain('lavatrice')
  })
})
