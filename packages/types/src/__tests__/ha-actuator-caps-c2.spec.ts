import { describe, it, expect } from 'vitest'
import {
  coverCapability,
  CoverStatusSchema,
  CoverStateSchema,
  lockControlCapability,
  LockControlStatusSchema,
  LockStateSchema,
  fanControlCapability,
  FanControlStatusSchema,
  FanDirectionSchema,
} from '../index.js'
import { DeviceType } from '../device/device-type.js'

describe('HA actuator caps — Phase C2', () => {
  describe('cover cap', () => {
    it('registers as singleton device-scoped push cap on Cover', () => {
      expect(coverCapability.name).toBe('cover')
      expect(coverCapability.scope).toBe('device')
      expect(coverCapability.mode).toBe('singleton')
      expect(coverCapability.deviceTypes).toEqual([DeviceType.Cover])
      expect(coverCapability.status.kind).toBe('push')
    })

    it('runtimeState mirrors the status schema', () => {
      expect(coverCapability.runtimeState).toBe(CoverStatusSchema)
    })

    it('exposes open / close / stop / setPosition / setTiltPosition as protected mutations', () => {
      const methodNames = ['open', 'close', 'stop', 'setPosition', 'setTiltPosition'] as const
      for (const name of methodNames) {
        const m = coverCapability.methods[name]
        expect(m.kind).toBe('mutation')
        expect(m.auth).toBe('protected')
      }
    })

    it('CoverState enum covers the canonical HA lifecycle', () => {
      const states = CoverStateSchema.options
      expect(states).toContain('open')
      expect(states).toContain('opening')
      expect(states).toContain('closing')
      expect(states).toContain('closed')
      expect(states).toContain('stopped')
    })

    it('status schema accepts fully-populated sample (position + tilt)', () => {
      const sample = {
        state: 'open' as const,
        position: 75,
        tiltPosition: 50,
        lastChangedAt: 1,
      }
      expect(CoverStatusSchema.parse(sample)).toEqual(sample)
    })

    it('status schema accepts positionless garage-door sample', () => {
      const sample = {
        state: 'closed' as const,
        position: null,
        tiltPosition: null,
        lastChangedAt: 1,
      }
      expect(CoverStatusSchema.parse(sample)).toEqual(sample)
    })

    it('setPosition rejects out-of-range position', () => {
      expect(() =>
        coverCapability.methods.setPosition.input.parse({ deviceId: 1, position: 150 }),
      ).toThrow()
    })

    it('setTiltPosition rejects negative tilt', () => {
      expect(() =>
        coverCapability.methods.setTiltPosition.input.parse({ deviceId: 1, tiltPosition: -5 }),
      ).toThrow()
    })

    it('open takes only deviceId, no extra args', () => {
      expect(coverCapability.methods.open.input.parse({ deviceId: 7 })).toEqual({ deviceId: 7 })
    })
  })

  describe('lock-control cap', () => {
    it('registers as singleton device-scoped push cap on Lock', () => {
      expect(lockControlCapability.name).toBe('lock-control')
      expect(lockControlCapability.scope).toBe('device')
      expect(lockControlCapability.mode).toBe('singleton')
      expect(lockControlCapability.deviceTypes).toEqual([DeviceType.Lock])
      expect(lockControlCapability.status.kind).toBe('push')
    })

    it('runtimeState mirrors the status schema', () => {
      expect(lockControlCapability.runtimeState).toBe(LockControlStatusSchema)
    })

    it('exposes lock / unlock as protected mutations', () => {
      for (const name of ['lock', 'unlock'] as const) {
        const m = lockControlCapability.methods[name]
        expect(m.kind).toBe('mutation')
        expect(m.auth).toBe('protected')
      }
    })

    it('LockState enum covers locked / unlocked / locking / unlocking / jammed', () => {
      const states = LockStateSchema.options
      expect(states).toContain('locked')
      expect(states).toContain('unlocked')
      expect(states).toContain('locking')
      expect(states).toContain('unlocking')
      expect(states).toContain('jammed')
    })

    it('status schema accepts a locked-state sample', () => {
      const sample = { state: 'locked' as const, lastChangedAt: 1 }
      expect(LockControlStatusSchema.parse(sample)).toEqual(sample)
    })

    it('status schema rejects unknown state', () => {
      expect(() => LockControlStatusSchema.parse({ state: 'broken', lastChangedAt: 1 })).toThrow()
    })

    it('lock input accepts optional PIN code', () => {
      const input = { deviceId: 7, code: '1234' }
      expect(lockControlCapability.methods.lock.input.parse(input)).toEqual(input)
    })

    it('lock input rejects empty PIN string', () => {
      expect(() =>
        lockControlCapability.methods.lock.input.parse({ deviceId: 7, code: '' }),
      ).toThrow()
    })

    it('unlock input accepts request without code', () => {
      expect(lockControlCapability.methods.unlock.input.parse({ deviceId: 7 })).toEqual({
        deviceId: 7,
      })
    })
  })

  describe('fan-control cap', () => {
    it('registers as singleton device-scoped push cap on Fan', () => {
      expect(fanControlCapability.name).toBe('fan-control')
      expect(fanControlCapability.scope).toBe('device')
      expect(fanControlCapability.mode).toBe('singleton')
      expect(fanControlCapability.deviceTypes).toEqual([DeviceType.Fan])
      expect(fanControlCapability.status.kind).toBe('push')
    })

    it('runtimeState mirrors the status schema', () => {
      expect(fanControlCapability.runtimeState).toBe(FanControlStatusSchema)
    })

    it('exposes setPercentage / setPreset / setDirection / setOscillating as protected mutations', () => {
      const methodNames = ['setPercentage', 'setPreset', 'setDirection', 'setOscillating'] as const
      for (const name of methodNames) {
        const m = fanControlCapability.methods[name]
        expect(m.kind).toBe('mutation')
        expect(m.auth).toBe('protected')
      }
    })

    it('FanDirection enum is exactly forward / reverse', () => {
      expect(FanDirectionSchema.options).toEqual(['forward', 'reverse'])
    })

    it('status schema accepts fully-populated ceiling-fan sample', () => {
      const sample = {
        speed: 60,
        preset: 'quiet',
        availablePresets: ['quiet', 'normal', 'turbo'],
        direction: 'forward' as const,
        oscillating: true,
        lastChangedAt: 1,
      }
      expect(FanControlStatusSchema.parse(sample)).toEqual(sample)
    })

    it('status schema accepts a minimal single-speed exhaust-fan sample', () => {
      const sample = {
        speed: null,
        preset: '',
        availablePresets: [],
        direction: null,
        oscillating: null,
        lastChangedAt: 0,
      }
      expect(FanControlStatusSchema.parse(sample)).toEqual(sample)
    })

    it('setPercentage rejects > 100', () => {
      expect(() =>
        fanControlCapability.methods.setPercentage.input.parse({ deviceId: 1, speed: 120 }),
      ).toThrow()
    })

    it('setDirection rejects unknown direction', () => {
      expect(() =>
        fanControlCapability.methods.setDirection.input.parse({
          deviceId: 1,
          direction: 'sideways',
        }),
      ).toThrow()
    })

    it('setPreset rejects empty preset', () => {
      expect(() =>
        fanControlCapability.methods.setPreset.input.parse({ deviceId: 1, preset: '' }),
      ).toThrow()
    })

    it('setOscillating accepts boolean false', () => {
      const input = { deviceId: 1, oscillating: false }
      expect(fanControlCapability.methods.setOscillating.input.parse(input)).toEqual(input)
    })
  })

  describe('cross-cap invariants', () => {
    it('all three Phase C2 caps run kind="push"', () => {
      expect(coverCapability.status.kind).toBe('push')
      expect(lockControlCapability.status.kind).toBe('push')
      expect(fanControlCapability.status.kind).toBe('push')
    })

    it('all three Phase C2 caps target a distinct DeviceType', () => {
      const types = new Set<string>([
        ...coverCapability.deviceTypes,
        ...lockControlCapability.deviceTypes,
        ...fanControlCapability.deviceTypes,
      ])
      expect(types.size).toBe(3)
    })

    it('cap names are unique', () => {
      const names = new Set([
        coverCapability.name,
        lockControlCapability.name,
        fanControlCapability.name,
      ])
      expect(names.size).toBe(3)
    })
  })
})
