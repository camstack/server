import { describe, it, expect } from 'vitest'
import {
  DishwasherOperationStateSchema,
  DishwasherOptionsSchema,
  DishwasherStatusSchema,
  dishwasherCapability,
  type DishwasherStatus,
} from '../src/capabilities/dishwasher.cap.js'
import { DeviceType } from '../src/device/device-type.js'

/** A status nothing is known about: the link is down. */
const UNKNOWN: DishwasherStatus = {
  availability: 'offline',
  state: 'unavailable',
  operationState: null,
  program: null,
  selectedProgram: null,
  availablePrograms: [],
  remainingSeconds: null,
  delayedStartSeconds: null,
  progressPercent: null,
  doorOpen: null,
  doorLocked: null,
  remoteStartAllowed: null,
  remoteControlActive: null,
  localControlActive: null,
  powerOn: null,
  powerState: null,
  filterCleaningDue: null,
  machineCareDue: null,
  machineCareRemainingRuns: null,
  halfLoad: null,
  hygienePlus: null,
  extraDry: null,
  intensiveZone: null,
  varioSpeedPlus: null,
  childLock: null,
  activeEvents: [],
  errorCode: null,
  errorLabel: null,
  lastFetchedAt: 0,
}

describe('DishwasherStatusSchema', () => {
  it('carries no salt or rinse-aid field — those are consumables items (D915)', () => {
    const fields = Object.keys(DishwasherStatusSchema.shape)
    expect(fields).not.toContain('saltLevel')
    expect(fields).not.toContain('rinseAidLevel')
  })

  it('round-trips a running cycle with options', () => {
    const status: DishwasherStatus = {
      ...UNKNOWN,
      availability: 'available',
      state: 'running',
      operationState: 'Run',
      program: 'Dishcare.Dishwasher.Program.Eco50',
      selectedProgram: 'Dishcare.Dishwasher.Program.Eco50',
      availablePrograms: ['Dishcare.Dishwasher.Program.Eco50', 'Dishcare.Dishwasher.Program.Auto2'],
      remainingSeconds: 2520,
      progressPercent: 35,
      doorOpen: false,
      remoteStartAllowed: false,
      powerOn: true,
      powerState: 'On',
      halfLoad: true,
      hygienePlus: false,
      varioSpeedPlus: true,
      childLock: false,
      activeEvents: ['Dishcare.Dishwasher.Event.RinseAidNearlyEmpty'],
      lastFetchedAt: 999,
    }
    expect(DishwasherStatusSchema.parse(status)).toEqual(status)
  })

  it('carries the filter and machine-care reminders, and refuses a negative or fractional run count', () => {
    const care = {
      ...UNKNOWN,
      filterCleaningDue: true,
      machineCareDue: false,
      machineCareRemainingRuns: 3,
    }
    expect(DishwasherStatusSchema.parse(care)).toEqual(care)
    expect(
      DishwasherStatusSchema.safeParse({ ...care, machineCareRemainingRuns: -1 }).success,
    ).toBe(false)
    expect(
      DishwasherStatusSchema.safeParse({ ...care, machineCareRemainingRuns: 1.5 }).success,
    ).toBe(false)
  })

  it('accepts a status where nothing is known — unknown is null, not false or zero', () => {
    expect(DishwasherStatusSchema.parse(UNKNOWN)).toEqual(UNKNOWN)
  })

  it('carries every operation state the appliance has, uncollapsed', () => {
    expect(DishwasherOperationStateSchema.options).toEqual([
      'Inactive',
      'Ready',
      'DelayedStart',
      'Run',
      'Pause',
      'ActionRequired',
      'Finished',
      'Error',
      'Aborting',
    ])
  })

  it('rejects progress outside 0..100', () => {
    expect(() => DishwasherStatusSchema.parse({ ...UNKNOWN, progressPercent: 101 })).toThrow()
  })

  it('rejects a fractional or negative remaining time (seconds are whole)', () => {
    expect(() => DishwasherStatusSchema.parse({ ...UNKNOWN, remainingSeconds: 1.5 })).toThrow()
    expect(() => DishwasherStatusSchema.parse({ ...UNKNOWN, remainingSeconds: -1 })).toThrow()
  })
})

describe('DishwasherOptionsSchema', () => {
  it('describes programs with their options, availability and constraint ranges', () => {
    const parsed = DishwasherOptionsSchema.parse({
      availability: 'available',
      supportsStart: true,
      supportsPause: true,
      supportsResume: false,
      supportsStop: true,
      supportsPower: true,
      programs: [
        {
          key: 'Dishcare.Dishwasher.Program.Eco50',
          name: 'Eco50',
          available: true,
          options: [
            {
              key: 'BSH.Common.Option.StartInRelative',
              name: 'StartInRelative',
              type: 'number',
              access: 'readWrite',
              available: true,
              unit: 's',
              min: 0,
              max: 86340,
              step: 60,
              enumValues: null,
              defaultValue: null,
            },
          ],
        },
      ],
      options: [],
    })
    expect(parsed.programs[0]?.options[0]?.max).toBe(86340)
  })
})

describe('dishwasherCapability definition', () => {
  it('is a device-native poll cap bound to Dishwasher device type', () => {
    expect(dishwasherCapability.name).toBe('dishwasher')
    expect(dishwasherCapability.scope).toBe('device')
    expect(dishwasherCapability.deviceNative).toBe(true)
    expect(dishwasherCapability.status.kind).toBe('poll')
    expect(dishwasherCapability.deviceTypes).toContain(DeviceType.Dishwasher)
  })

  it('uses the same schema for status and runtimeState', () => {
    expect(dishwasherCapability.runtimeState).toBe(DishwasherStatusSchema)
  })

  it('exposes start/pause/resume/stop/program/power/option commands and an honest getOptions', () => {
    expect(Object.keys(dishwasherCapability.methods).sort()).toEqual(
      [
        'getOptions',
        'pause',
        'resume',
        'setChildLock',
        'setExtraDry',
        'setHalfLoad',
        'setHygienePlus',
        'setIntensiveZone',
        'setOption',
        'setPower',
        'setProgram',
        'setVarioSpeedPlus',
        'start',
        'stop',
      ].sort(),
    )
  })
})
