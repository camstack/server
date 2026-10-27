import { describe, expect, it } from 'vitest'
import { DeviceType } from '../device-type.js'
import {
  actionsForBoundCaps,
  actionsForDevice,
  actionsForDeviceType,
  allDoActions,
  DEVICE_DO_ACTIONS,
  DEVICE_TYPE_DO_CAPS,
  deviceDoFamily,
  doActionSelectValue,
  isDoActionActuatable,
  isDoPickerDeviceType,
  matchDoAction,
  sameDoFamily,
} from '../device-do-actions.js'

describe('DEVICE_DO_ACTIONS', () => {
  it('every catalogue entry is still actuatable in METHOD_ACCESS_MAP', () => {
    for (const action of DEVICE_DO_ACTIONS) {
      expect(isDoActionActuatable(action), action.id).toBe(true)
    }
  })

  it('ids are unique', () => {
    const ids = DEVICE_DO_ACTIONS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('DEVICE_TYPE_DO_CAPS', () => {
  it('maps every DeviceType (exhaustive) — empty means deliberately non-actuatable', () => {
    for (const t of Object.values(DeviceType)) {
      expect(DEVICE_TYPE_DO_CAPS[t], `missing DO_CAPS for ${t}`).toBeDefined()
      expect(Array.isArray(DEVICE_TYPE_DO_CAPS[t])).toBe(true)
    }
  })

  it('every listed cap appears in the catalogue', () => {
    const catalogueCaps = new Set(DEVICE_DO_ACTIONS.map((a) => a.cap))
    for (const t of Object.values(DeviceType)) {
      for (const cap of DEVICE_TYPE_DO_CAPS[t]) {
        expect(catalogueCaps.has(cap), `${t} lists unknown catalogue cap ${cap}`).toBe(true)
      }
    }
  })

  it('Container is empty and excluded from Do pickers', () => {
    expect(DEVICE_TYPE_DO_CAPS[DeviceType.Container]).toEqual([])
    expect(isDoPickerDeviceType(DeviceType.Container)).toBe(false)
    expect(isDoPickerDeviceType(DeviceType.Lock)).toBe(true)
  })

  it('Lock / Valve / Climate offer type-fallback actions when bindings are empty', () => {
    expect(actionsForDeviceType(DeviceType.Lock).map((a) => a.id)).toEqual([
      'lock.lock',
      'lock.unlock',
      'lock.open',
    ])
    expect(
      actionsForDevice({ boundCaps: [], deviceType: DeviceType.Lock }).map((a) => a.id),
    ).toEqual(['lock.lock', 'lock.unlock', 'lock.open'])
    expect(actionsForDeviceType(DeviceType.Valve).map((a) => a.id)).toContain('valve.open')
    expect(actionsForDeviceType(DeviceType.Climate).map((a) => a.id)).toContain('climate.heat')
  })

  it('climate family and cover family group for multi-select', () => {
    expect(sameDoFamily(DeviceType.Climate, DeviceType.Humidifier)).toBe(true)
    expect(sameDoFamily(DeviceType.Cover, DeviceType.Valve)).toBe(true)
    expect(sameDoFamily(DeviceType.Lock, DeviceType.Lock)).toBe(true)
    expect(sameDoFamily(DeviceType.Lock, DeviceType.Climate)).toBe(false)
    expect(deviceDoFamily(DeviceType.WaterHeater)).toBe('climate-family')
  })
})

describe('actionsForBoundCaps', () => {
  it('returns Turn on/off for a switch binding', () => {
    const actions = actionsForBoundCaps(['switch'])
    expect(actions.map((a) => a.id)).toEqual(['switch.on', 'switch.off'])
  })

  it('returns Lock/Unlock/Open latch for lock-control', () => {
    expect(actionsForBoundCaps(['lock-control']).map((a) => a.id)).toEqual([
      'lock.lock',
      'lock.unlock',
      'lock.open',
    ])
  })

  it('returns nothing when the device binds no actuatable catalogue cap', () => {
    expect(actionsForBoundCaps([])).toEqual([])
    expect(actionsForBoundCaps(['battery', 'contact'])).toEqual([])
    expect(actionsForBoundCaps(['camera-streams'])).toEqual([])
  })

  it('returns Open/Close/Stop for cover', () => {
    expect(actionsForBoundCaps(['cover']).map((a) => a.id)).toEqual([
      'cover.open',
      'cover.close',
      'cover.stop',
      'cover.position',
      'cover.tilt',
    ])
  })

  it('returns climate modes for climate-control', () => {
    expect(actionsForBoundCaps(['climate-control']).map((a) => a.id)).toEqual([
      'climate.off',
      'climate.heat',
      'climate.cool',
      'climate.auto',
      'climate.mode',
      'climate.target',
      'climate.targetRange',
      'climate.targetHumidity',
      'climate.fanMode',
      'climate.preset',
      'climate.swingVerticalOn',
      'climate.swingVerticalOff',
      'climate.swingHorizontalOn',
      'climate.swingHorizontalOff',
    ])
  })

  it('returns vacuum lifecycle actions', () => {
    expect(actionsForBoundCaps(['vacuum-control']).map((a) => a.id)).toEqual([
      'vacuum.start',
      'vacuum.pause',
      'vacuum.stop',
      'vacuum.dock',
      'vacuum.locate',
      'vacuum.fanSpeed',
    ])
  })

  it('returns PTZ go home and go to preset', () => {
    expect(actionsForBoundCaps(['ptz']).map((a) => a.id)).toEqual([
      'ptz.goHome',
      'ptz.goToPreset',
      'ptz.stop',
      'ptz.autofocusOn',
      'ptz.autofocusOff',
    ])
  })

  it('returns camera privacy / mic / day-night / reboot actions', () => {
    expect(actionsForBoundCaps(['privacy-mask']).map((a) => a.id)).toEqual([
      'privacy.maskOn',
      'privacy.maskOff',
      'privacy.micOn',
      'privacy.micOff',
    ])
    expect(actionsForBoundCaps(['day-night']).map((a) => a.id)).toEqual([
      'dayNight.auto',
      'dayNight.day',
      'dayNight.night',
    ])
    expect(actionsForBoundCaps(['reboot']).map((a) => a.id)).toEqual(['reboot.reboot'])
    expect(actionsForBoundCaps(['ptz-autotrack']).map((a) => a.id)).toEqual([
      'ptz.autotrackOn',
      'ptz.autotrackOff',
    ])
  })

  it('returns accessory brightness and motion-trigger actions', () => {
    expect(actionsForBoundCaps(['brightness']).map((a) => a.id)).toEqual([
      'brightness.full',
      'brightness.half',
      'brightness.off',
      'brightness.set',
    ])
    expect(actionsForBoundCaps(['motion-trigger']).map((a) => a.id)).toEqual([
      'motionTrigger.on',
      'motionTrigger.off',
    ])
  })

  it('unions actions when a device binds several catalogue caps', () => {
    const ids = actionsForBoundCaps(['switch', 'button']).map((a) => a.id)
    expect(ids).toContain('switch.on')
    expect(ids).toContain('button.press')
  })
})

describe('allDoActions', () => {
  it('returns the full actuatable catalogue', () => {
    expect(allDoActions().length).toBe(DEVICE_DO_ACTIONS.length)
  })
})

describe('matchDoAction / doActionSelectValue', () => {
  it('matches baked args for switch on/off', () => {
    expect(matchDoAction('switch', 'setState', { on: true })?.id).toBe('switch.on')
    expect(matchDoAction('switch', 'setState', { on: false })?.id).toBe('switch.off')
    expect(matchDoAction('switch', 'setState', { on: true, extra: 1 })).toBeNull()
  })

  it('matches arm modes by args', () => {
    expect(matchDoAction('alarm-panel', 'arm', { mode: 'night' })?.id).toBe('alarm.arm.night')
  })

  it('select value falls back to custom:cap.method', () => {
    expect(doActionSelectValue('switch', 'setState', { on: true })).toBe('switch.on')
    expect(doActionSelectValue('ptz', 'goto', { preset: 1 })).toBe('custom:ptz.goto')
  })

  it('matches goToPreset even when presetId is filled', () => {
    expect(matchDoAction('ptz', 'goToPreset', { presetId: '3' })?.id).toBe('ptz.goToPreset')
    expect(doActionSelectValue('ptz', 'goToPreset', { presetId: '3' })).toBe('ptz.goToPreset')
  })

  it('matches nested day-night and privacy args', () => {
    expect(matchDoAction('day-night', 'setSettings', { settings: { mode: 'night' } })?.id).toBe(
      'dayNight.night',
    )
    expect(matchDoAction('privacy-mask', 'setMask', { patch: { enabled: true } })?.id).toBe(
      'privacy.maskOn',
    )
  })
})

/**
 * The hand-written catalogue this module held before D920, as saved steps
 * store it: `[id, cap, method, baked args]`. The vocabulary projection must
 * keep every one of these ids AND select it again for the same wire step, or
 * a saved NC sequence / automation step reopens as "custom".
 */
type LegacyRow = readonly [string, string, string, Readonly<Record<string, unknown>> | null]
const LEGACY_CATALOGUE: readonly LegacyRow[] = [
  ['switch.on', 'switch', 'setState', { on: true }],
  ['switch.off', 'switch', 'setState', { on: false }],
  ['lock.lock', 'lock-control', 'lock', {}],
  ['lock.unlock', 'lock-control', 'unlock', {}],
  ['lock.open', 'lock-control', 'open', {}],
  ['cover.open', 'cover', 'open', {}],
  ['cover.close', 'cover', 'close', {}],
  ['cover.stop', 'cover', 'stop', {}],
  ['valve.open', 'valve', 'open', {}],
  ['valve.close', 'valve', 'close', {}],
  ['valve.stop', 'valve', 'stop', {}],
  ['humidifier.on', 'humidifier', 'setOn', { on: true }],
  ['humidifier.off', 'humidifier', 'setOn', { on: false }],
  ['waterHeater.off', 'water-heater', 'setOperationMode', { mode: 'off' }],
  ['waterHeater.awayOn', 'water-heater', 'setAway', { on: true }],
  ['waterHeater.awayOff', 'water-heater', 'setAway', { on: false }],
  ['climate.off', 'climate-control', 'setMode', { mode: 'off' }],
  ['climate.heat', 'climate-control', 'setMode', { mode: 'heat' }],
  ['climate.cool', 'climate-control', 'setMode', { mode: 'cool' }],
  ['climate.auto', 'climate-control', 'setMode', { mode: 'auto' }],
  ['fan.off', 'fan-control', 'setPercentage', { speed: 0 }],
  ['fan.full', 'fan-control', 'setPercentage', { speed: 100 }],
  ['vacuum.start', 'vacuum-control', 'start', {}],
  ['vacuum.pause', 'vacuum-control', 'pause', {}],
  ['vacuum.stop', 'vacuum-control', 'stop', {}],
  ['vacuum.dock', 'vacuum-control', 'returnToBase', {}],
  ['lawnMower.start', 'lawn-mower-control', 'startMowing', {}],
  ['lawnMower.pause', 'lawn-mower-control', 'pause', {}],
  ['lawnMower.dock', 'lawn-mower-control', 'dock', {}],
  ['media.play', 'media-player', 'play', {}],
  ['media.pause', 'media-player', 'pause', {}],
  ['media.stop', 'media-player', 'stop', {}],
  ['media.next', 'media-player', 'next', {}],
  ['media.previous', 'media-player', 'previous', {}],
  ['script.run', 'script-runner', 'run', {}],
  ['script.stop', 'script-runner', 'stop', {}],
  ['haAutomation.enable', 'automation-control', 'enable', {}],
  ['haAutomation.disable', 'automation-control', 'disable', {}],
  ['haAutomation.trigger', 'automation-control', 'trigger', {}],
  ['petFeeder.feed', 'pet-feeder', 'feed', null],
  ['petFeeder.callPet', 'pet-feeder', 'callPet', {}],
  ['dishwasher.start', 'dishwasher', 'start', {}],
  ['dishwasher.pause', 'dishwasher', 'pause', {}],
  ['dishwasher.stop', 'dishwasher', 'stop', {}],
  ['dishwasher.powerOn', 'dishwasher', 'setPower', { on: true }],
  ['dishwasher.powerOff', 'dishwasher', 'setPower', { on: false }],
  ['ptz.goHome', 'ptz', 'goHome', {}],
  ['ptz.goToPreset', 'ptz', 'goToPreset', null],
  ['ptz.autotrackOn', 'ptz-autotrack', 'setEnabled', { enabled: true }],
  ['ptz.autotrackOff', 'ptz-autotrack', 'setEnabled', { enabled: false }],
  ['privacy.maskOn', 'privacy-mask', 'setMask', { patch: { enabled: true } }],
  ['privacy.maskOff', 'privacy-mask', 'setMask', { patch: { enabled: false } }],
  ['privacy.micOn', 'privacy-mask', 'setAudioEnabled', { enabled: true }],
  ['privacy.micOff', 'privacy-mask', 'setAudioEnabled', { enabled: false }],
  ['dayNight.auto', 'day-night', 'setSettings', { settings: { mode: 'auto' } }],
  ['dayNight.day', 'day-night', 'setSettings', { settings: { mode: 'day' } }],
  ['dayNight.night', 'day-night', 'setSettings', { settings: { mode: 'night' } }],
  ['reboot.reboot', 'reboot', 'reboot', {}],
  ['brightness.full', 'brightness', 'setBrightness', { level: 100 }],
  ['brightness.half', 'brightness', 'setBrightness', { level: 50 }],
  ['brightness.off', 'brightness', 'setBrightness', { level: 0 }],
  ['motionTrigger.on', 'motion-trigger', 'setMotionTrigger', { enabled: true }],
  ['motionTrigger.off', 'motion-trigger', 'setMotionTrigger', { enabled: false }],
  ['alarm.trigger', 'alarm-panel', 'trigger', {}],
  ['alarm.disarm', 'alarm-panel', 'disarm', {}],
  ['alarm.arm.home', 'alarm-panel', 'arm', { mode: 'home' }],
  ['alarm.arm.away', 'alarm-panel', 'arm', { mode: 'away' }],
  ['alarm.arm.night', 'alarm-panel', 'arm', { mode: 'night' }],
  ['alarm.arm.vacation', 'alarm-panel', 'arm', { mode: 'vacation' }],
  ['alarm.arm.custom_bypass', 'alarm-panel', 'arm', { mode: 'custom_bypass' }],
  ['button.press', 'button', 'press', {}],
]

describe('the projection keeps the pre-D920 catalogue', () => {
  it.each(
    LEGACY_CATALOGUE,
  )('%s still exists and still matches its saved step', (id, cap, method, args) => {
    const entry = DEVICE_DO_ACTIONS.find((a) => a.id === id)
    expect(entry, id).toMatchObject({ cap, method })
    expect(matchDoAction(cap, method, args ?? undefined)?.id).toBe(id)
  })

  it('still matches a saved step whose open arg was filled', () => {
    expect(matchDoAction('ptz', 'goToPreset', { presetId: '3' })?.id).toBe('ptz.goToPreset')
    expect(matchDoAction('pet-feeder', 'feed', { grams: 12 })?.id).toBe('petFeeder.feed')
  })
})
