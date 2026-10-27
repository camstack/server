import { describe, it, expect } from 'vitest'
import { DeviceType } from '../device-type.js'
import {
  DEVICE_TYPE_CONTROL_KIND,
  resolveDeviceControlKind,
  pickAccessoryControl,
  hasMotionTrigger,
  MOTION_TRIGGER_FEATURE,
  SENSOR_FEATURES,
  SENSOR_MAP,
  isNode,
  resolveMutate,
} from '../device-control-resolution.js'

describe('resolveDeviceControlKind (base type → control-kind)', () => {
  it('maps every DeviceType (exhaustive) to a defined kind', () => {
    for (const t of Object.values(DeviceType)) {
      expect(DEVICE_TYPE_CONTROL_KIND[t], `missing kind for ${t}`).toBeDefined()
      expect(resolveDeviceControlKind(t)).toBe(DEVICE_TYPE_CONTROL_KIND[t])
    }
  })

  it('resolves representative types to their kinds', () => {
    expect(resolveDeviceControlKind('cover')).toBe('cover')
    expect(resolveDeviceControlKind('light')).toBe('light')
    expect(resolveDeviceControlKind('siren')).toBe('switch')
    expect(resolveDeviceControlKind('presence')).toBe('sensor')
    expect(resolveDeviceControlKind('alarm-panel')).toBe('alarm')
  })

  it('maps placeholder / non-controllable types to dummy', () => {
    for (const t of [
      DeviceType.Camera,
      DeviceType.Hub,
      DeviceType.Generic,
      DeviceType.Notifier,
      DeviceType.Container,
      DeviceType.EventEmitter,
    ]) {
      expect(resolveDeviceControlKind(t)).toBe('dummy')
    }
  })

  it('gives Script and Automation their own kinds', () => {
    // They were `dummy` while carrying `script-runner` / `automation-control`
    // with real runtime state, so the one thing an operator wants from each —
    // run it, is it on — rendered as "Controls coming soon".
    expect(resolveDeviceControlKind(DeviceType.Script)).toBe('script')
    expect(resolveDeviceControlKind(DeviceType.Automation)).toBe('automation')
  })

  it('returns null for unknown / empty type strings', () => {
    expect(resolveDeviceControlKind('unknown-type')).toBeNull()
    expect(resolveDeviceControlKind('')).toBeNull()
  })
})

describe('pickAccessoryControl (finer accessory-row decision)', () => {
  const pick = (type: string, features: readonly string[] = []) =>
    pickAccessoryControl({ type, features })

  it('agrees with the base decision on the shared overlapping types', () => {
    expect(pick('cover').kind).toBe('cover')
    expect(pick('valve').kind).toBe('valve')
    expect(pick('lock').kind).toBe('lock')
    expect(pick('alarm-panel').kind).toBe('alarm')
    expect(pick('switch').kind).toBe('switch')
    expect(pick('siren').kind).toBe('switch')
  })

  it('refines a light into brightness vs switch by feature', () => {
    expect(pick('light', ['brightness']).kind).toBe('brightness')
    expect(pick('light', []).kind).toBe('switch')
  })

  it('refines a sensor / presence into the first matching sensor cap', () => {
    const p = pick('sensor', ['battery-operated', 'humidity-sensor'])
    expect(p.kind).toBe('sensor')
    expect(p.sensorFeature).toBe('humidity-sensor')
    expect(pick('presence', ['ambient-light-sensor']).sensorFeature).toBe('ambient-light-sensor')
  })

  it('returns none for a sensor with no known sensor cap and for uncontrolled types', () => {
    expect(pick('sensor', ['battery-operated']).kind).toBe('none')
    expect(pick('camera').kind).toBe('none')
    expect(pick('thermostat').kind).toBe('none')
  })

  it('is pure: same input → same output', () => {
    const input = { type: 'light', features: ['brightness'] } as const
    expect(pickAccessoryControl(input)).toEqual(pickAccessoryControl(input))
  })
})

describe('motion-trigger + sensor maps', () => {
  it('hasMotionTrigger detects the motion-trigger feature', () => {
    expect(hasMotionTrigger([MOTION_TRIGGER_FEATURE])).toBe(true)
    expect(hasMotionTrigger(['switch'])).toBe(false)
  })

  it('SENSOR_FEATURES covers every numeric SENSOR_MAP key plus enum-sensor', () => {
    for (const key of Object.keys(SENSOR_MAP)) {
      expect(SENSOR_FEATURES).toContain(key)
    }
    expect(SENSOR_FEATURES).toContain('enum-sensor')
  })

  it('SENSOR_MAP maps kebab caps to their camelCase router key + field', () => {
    expect(SENSOR_MAP['temperature-sensor']).toEqual({
      capKey: 'temperatureSensor',
      field: 'temperature',
      fallbackUnit: '°C',
    })
    expect(SENSOR_MAP['numeric-sensor']).toEqual({ capKey: 'numericSensor', field: 'value' })
    // enum-sensor is handled separately (raw string value), so no numeric entry.
    expect(SENSOR_MAP['enum-sensor']).toBeUndefined()
  })
})

describe('tRPC proxy guard (isNode / resolveMutate) — #24', () => {
  it('isNode accepts objects AND callable proxy nodes, rejects primitives/null', () => {
    expect(isNode({})).toBe(true)
    expect(isNode(() => undefined)).toBe(true) // tRPC v11 client proxy node
    expect(isNode(null)).toBe(false)
    expect(isNode(undefined)).toBe(false)
    expect(isNode('x')).toBe(false)
    expect(isNode(3)).toBe(false)
  })

  it('resolveMutate returns the mutate fn when the proxy path is callable', async () => {
    const calls: Array<Record<string, unknown>> = []
    const router = {
      setOn: {
        mutate: async (input: Record<string, unknown>) => {
          calls.push(input)
          return 'ok'
        },
      },
    }
    const fn = resolveMutate(router, 'setOn')
    expect(fn).not.toBeNull()
    await fn?.({ deviceId: 7, on: true })
    expect(calls).toEqual([{ deviceId: 7, on: true }])
  })

  it('resolveMutate returns null when the router, method, or mutate is missing', () => {
    expect(resolveMutate(null, 'setOn')).toBeNull()
    expect(resolveMutate({}, 'setOn')).toBeNull()
    expect(resolveMutate({ setOn: {} }, 'setOn')).toBeNull()
    expect(resolveMutate({ setOn: { mutate: 42 } }, 'setOn')).toBeNull()
  })
})
