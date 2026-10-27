import { describe, expect, it } from 'vitest'
import { HomeConnectDescriptionStore } from '../home-connect-description-store.js'
import {
  dishwasherConsumablesFromFeatures,
  dishwasherOptionsFromDescription,
  dishwasherStatusFromFeatures,
  eventActive,
  type HomeConnectView,
} from '../home-connect-domain-mapping.js'
import { dishwasherDescription } from './dishwasher-iddf-fixture.js'

function view(
  features: Record<string, unknown>,
  overrides: Partial<HomeConnectView> = {},
): HomeConnectView {
  return {
    features: new Map(Object.entries(features)),
    description: dishwasherDescription(),
    link: 'connected',
    ...overrides,
  }
}

const NOW = 1_700_000_000_000

function status(features: Record<string, unknown>, overrides: Partial<HomeConnectView> = {}) {
  return dishwasherStatusFromFeatures({ ...view(features, overrides), lastValueAt: NOW })
}

describe('dishwasherStatusFromFeatures — unknown is not off', () => {
  it('a connected appliance that has reported nothing is unknown everywhere, not false / 0 / Ready', () => {
    const s = status({})
    expect(s.availability).toBe('available')
    expect(s.state).toBe('unavailable')
    expect(s.operationState).toBeNull()
    expect(s.doorOpen).toBeNull()
    expect(s.powerOn).toBeNull()
    expect(s.remoteStartAllowed).toBeNull()
    expect(s.halfLoad).toBeNull()
    expect(s.extraDry).toBeNull()
    expect(s.childLock).toBeNull()
    expect(s.hygienePlus).toBeNull()
    expect(s.remaining).toBeNull()
    expect(s.errorCode).toBeNull()
  })

  it('a dropped link publishes unavailable even when stale values are still around', () => {
    const s = status({ 'BSH.Common.Status.OperationState': 'Run' }, { link: 'disconnected' })
    expect(s.availability).toBe('offline')
    expect(s.state).toBe('unavailable')
    expect(s.operationState).toBeNull()
    expect(s.availablePrograms).toEqual([
      'Dishcare.Dishwasher.Program.Eco50',
      'Dishcare.Dishwasher.Program.Auto2',
    ])
  })

  it('an appliance without a loaded description is reported degraded with its own reason', () => {
    const s = status(
      { 'BSH.Common.Status.OperationState': 'Run' },
      { description: new HomeConnectDescriptionStore(undefined) },
    )
    expect(s.availability).toBe('description-missing')
    expect(s.state).toBe('unavailable')
    expect(s.operationState).toBeNull()
  })

  it('stamps lastFetchedAt with the time of the last value, never "now"', () => {
    expect(status({}).lastFetchedAt).toBe(NOW)
    expect(
      dishwasherStatusFromFeatures({ ...view({}, { link: 'disconnected' }), lastValueAt: 0 })
        .lastFetchedAt,
    ).toBe(0)
  })
})

describe('dishwasherStatusFromFeatures — operation state', () => {
  const COARSE = {
    Inactive: 'idle',
    Ready: 'idle',
    DelayedStart: 'idle',
    ActionRequired: 'idle',
    Run: 'running',
    Pause: 'paused',
    Finished: 'finished',
    Error: 'error',
    Aborting: 'running',
  } as const

  it.each(Object.entries(COARSE))('keeps %s as itself and folds it to %s', (op, coarse) => {
    const s = status({ 'BSH.Common.Status.OperationState': op })
    expect(s.operationState).toBe(op)
    expect(s.state).toBe(coarse)
  })

  it('an operation state the schema does not know is unknown, not Ready', () => {
    const s = status({ 'BSH.Common.Status.OperationState': 'Hibernating' })
    expect(s.operationState).toBeNull()
    expect(s.state).toBe('unavailable')
  })

  it('in Error it names the raised alert, not a hard-coded code', () => {
    const s = status({
      'BSH.Common.Status.OperationState': 'Error',
      'BSH.Common.Event.ProgramAborted': 'Present',
    })
    expect(s.state).toBe('error')
    expect(s.errorCode).toBeNull()
    expect(s.errorLabel).toBe('BSH.Common.Event.ProgramAborted')
  })
})

describe('dishwasherStatusFromFeatures — time is seconds, always', () => {
  it('reads RemainingProgramTime and StartInRelative as seconds with no minute heuristic', () => {
    // 300 used to be read as "300 minutes" (<= 600), 1800 as 30 minutes.
    expect(status({ 'BSH.Common.Option.RemainingProgramTime': 300 }).remaining).toBe(300)
    expect(status({ 'BSH.Common.Option.RemainingProgramTime': 5400 }).remaining).toBe(5400)
    expect(status({ 'BSH.Common.Option.StartInRelative': 1800 }).delayedStart).toBe(1800)
    expect(status({ 'BSH.Common.Option.StartInRelative': 7200 }).delayedStart).toBe(7200)
  })

  it('does not scale a fractional value by 60', () => {
    expect(status({ 'BSH.Common.Option.RemainingProgramTime': 12.4 }).remaining).toBe(12)
  })

  it('a negative or non-numeric duration is unknown', () => {
    expect(status({ 'BSH.Common.Option.RemainingProgramTime': -5 }).remaining).toBeNull()
    expect(status({ 'BSH.Common.Option.RemainingProgramTime': 'soon' }).remaining).toBeNull()
  })
})

describe('dishwasherStatusFromFeatures — flags that used to be conflated', () => {
  it('remote start allowed and remote control active are two facts', () => {
    const s = status({
      'BSH.Common.Status.RemoteControlStartAllowed': false,
      'BSH.Common.Status.RemoteControlActive': true,
    })
    expect(s.remoteStartAllowed).toBe(false)
    expect(s.remoteControlActive).toBe(true)
  })

  it('door state distinguishes open / closed / locked and unknown', () => {
    expect(status({ 'BSH.Common.Status.DoorState': 'Open' })).toMatchObject({
      doorOpen: true,
      doorLocked: false,
    })
    expect(status({ 'BSH.Common.Status.DoorState': 'Closed' })).toMatchObject({
      doorOpen: false,
      doorLocked: false,
    })
    expect(status({ 'BSH.Common.Status.DoorState': 'Locked' })).toMatchObject({
      doorOpen: false,
      doorLocked: true,
    })
    expect(status({})).toMatchObject({ doorOpen: null, doorLocked: null })
  })

  it('power: On / Off / Standby, and unknown is not off', () => {
    expect(status({ 'BSH.Common.Setting.PowerState': 'On' })).toMatchObject({
      powerOn: true,
      powerState: 'On',
    })
    expect(status({ 'BSH.Common.Setting.PowerState': 'Standby' })).toMatchObject({
      powerOn: false,
      powerState: 'Standby',
    })
    expect(status({})).toMatchObject({ powerOn: null, powerState: null })
  })

  it('selected and active program are separate fields', () => {
    const s = status({
      'BSH.Common.Root.ActiveProgram': null,
      'BSH.Common.Root.SelectedProgram': 'Dishcare.Dishwasher.Program.Auto2',
    })
    expect(s.program).toBeNull()
    expect(s.selectedProgram).toBe('Dishcare.Dishwasher.Program.Auto2')
  })

  it('options are read from the namespaced option the appliance declares', () => {
    const s = status({
      'Dishcare.Dishwasher.Option.ExtraDry': true,
      'Dishcare.Dishwasher.Option.HalfLoad': false,
      'BSH.Common.Setting.ChildLock': true,
    })
    expect(s.extraDry).toBe(true)
    expect(s.halfLoad).toBe(false)
    expect(s.childLock).toBe(true)
    expect(s.hygienePlus).toBeNull()
  })

  it('progress outside 0..100 is unknown rather than clamped', () => {
    expect(status({ 'BSH.Common.Option.ProgramProgress': 40 }).progress).toBe(40)
    expect(status({ 'BSH.Common.Option.ProgramProgress': 140 }).progress).toBeNull()
  })
})

describe('dishwasherStatusFromFeatures — events', () => {
  it('lists the raised events', () => {
    const s = status({
      'Dishcare.Dishwasher.Event.SaltNearlyEmpty': 'Present',
      'Dishcare.Dishwasher.Event.RinseAidNearlyEmpty': 'Off',
      'BSH.Common.Event.ProgramFinished': 'Confirmed',
    })
    expect(s.activeEvents.sort()).toEqual([
      'BSH.Common.Event.ProgramFinished',
      'Dishcare.Dishwasher.Event.SaltNearlyEmpty',
    ])
  })

  it('carries no salt or rinse-aid field — those are consumables items (D915)', () => {
    const s = status({ 'Dishcare.Dishwasher.Event.SaltNearlyEmpty': 'Present' })
    expect('saltLevel' in s).toBe(false)
    expect('rinseAidLevel' in s).toBe(false)
  })
})

describe('dishwasherConsumablesFromFeatures — salt and rinse aid as supply items (D915)', () => {
  function items(features: Record<string, unknown>, overrides: Partial<HomeConnectView> = {}) {
    return dishwasherConsumablesFromFeatures(view(features, overrides))
  }
  function statusOf(features: Record<string, unknown>, key: string) {
    return items(features)?.find((i) => i.key === key)?.status
  }

  it('lists salt and rinse aid as supply items, never resettable', () => {
    expect(items({})).toEqual([
      {
        key: 'salt',
        label: 'Salt',
        level: null,
        status: null,
        kind: 'supply',
        form: 'product',
        lastResetAt: null,
        resettable: false,
      },
      {
        key: 'rinseAid',
        label: 'Rinse aid',
        level: null,
        status: null,
        kind: 'supply',
        form: 'product',
        lastResetAt: null,
        resettable: false,
      },
    ])
  })

  it('derives each status from the events', () => {
    const features = {
      'Dishcare.Dishwasher.Event.SaltNearlyEmpty': 'Present',
      'Dishcare.Dishwasher.Event.RinseAidNearlyEmpty': 'Off',
    }
    expect(statusOf(features, 'salt')).toBe('low')
    expect(statusOf(features, 'rinseAid')).toBe('ok')
  })

  it('a raised *Lack event is empty, even while its *NearlyEmpty reads clear (live dishwasher)', () => {
    const features = {
      'Dishcare.Dishwasher.Event.RinseAidLack': 'Present',
      'Dishcare.Dishwasher.Event.RinseAidNearlyEmpty': 'Off',
      'Dishcare.Dishwasher.Event.SaltNearlyEmpty': 'Present',
      'Dishcare.Dishwasher.Event.SaltLack': 'Off',
    }
    expect(statusOf(features, 'rinseAid')).toBe('empty')
    expect(statusOf(features, 'salt')).toBe('low')
  })

  it('each listed event is read on its own: one that reads clear is ok, none reported is unknown', () => {
    expect(statusOf({ 'Dishcare.Dishwasher.Event.SaltLack': 'Off' }, 'salt')).toBe('ok')
    expect(statusOf({ 'Dishcare.Dishwasher.Event.SaltLack': 'Confirmed' }, 'salt')).toBe('empty')
    expect(statusOf({ 'Dishcare.Dishwasher.Event.RinseAidNearlyEmpty': 'Off' }, 'rinseAid')).toBe(
      'ok',
    )
    expect(statusOf({}, 'salt')).toBeNull()
  })

  it('answers null — keep what is known — while the appliance is offline or undescribed', () => {
    expect(
      items({ 'Dishcare.Dishwasher.Event.SaltLack': 'Present' }, { link: 'disconnected' }),
    ).toBeNull()
    expect(items({}, { description: null })).toBeNull()
  })

  it('eventActive treats Present / Confirmed as raised and Off as clear', () => {
    expect(eventActive('Present')).toBe(true)
    expect(eventActive('Confirmed')).toBe(true)
    expect(eventActive('Off')).toBe(false)
    expect(eventActive('Whatever')).toBeNull()
    expect(eventActive(undefined)).toBeNull()
  })
})

describe("dishwasherOptionsFromDescription — the descriptor is the appliance's own", () => {
  it('lists every program with availability and the options it offers, with constraints', () => {
    const options = dishwasherOptionsFromDescription(view({}))
    expect(options.availability).toBe('available')
    expect(options.programs.map((p) => [p.name, p.available])).toEqual([
      ['Eco50', true],
      ['Auto2', true],
      ['Quick45', false],
    ])
    const eco = options.programs[0]
    const start = eco?.options.find((o) => o.key === 'BSH.Common.Option.StartInRelative')
    expect(start).toMatchObject({
      type: 'number',
      access: 'readWrite',
      available: true,
      unit: 's',
      min: 0,
      max: 86340,
      step: 60,
    })
    const zone = eco?.options.find((o) => o.key === 'Dishcare.Dishwasher.Option.IntensivZone')
    expect(zone).toMatchObject({ access: 'read', available: false, defaultValue: true })
  })

  it('reports the commands the description declares, not commands it merely could have', () => {
    const options = dishwasherOptionsFromDescription(view({}))
    expect(options.supportsPause).toBe(true)
    expect(options.supportsResume).toBe(true)
    expect(options.supportsStop).toBe(false) // AbortProgram is declared unavailable
    expect(options.supportsStart).toBe(true)
    expect(options.supportsPower).toBe(true)
  })

  it('follows a live description change', () => {
    const description = dishwasherDescription()
    description.applyChanges([{ uid: 0x0322, available: true }])
    const options = dishwasherOptionsFromDescription({
      features: new Map(),
      description,
      link: 'connected',
    })
    expect(options.supportsStop).toBe(true)
  })

  it('without a description it offers nothing', () => {
    const options = dishwasherOptionsFromDescription(
      view({}, { description: new HomeConnectDescriptionStore(undefined) }),
    )
    expect(options.availability).toBe('description-missing')
    expect(options.programs).toEqual([])
    expect(options.supportsStart).toBe(false)
  })
})
