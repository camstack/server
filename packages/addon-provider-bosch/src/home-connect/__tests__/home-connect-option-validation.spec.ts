import { describe, expect, it } from 'vitest'
import {
  assertProgramAvailable,
  assertProgramOptions,
  assertWritable,
} from '../home-connect-option-validation.js'
import { dishwasherDescription } from './dishwasher-iddf-fixture.js'

describe('assertWritable — the description is the authority', () => {
  const d = dishwasherDescription()

  it('accepts a value inside the declared range and on its step', () => {
    expect(assertWritable(d, 'BSH.Common.Option.StartInRelative', 3600)).toBe(
      'BSH.Common.Option.StartInRelative',
    )
  })

  it('rejects out-of-range and off-step numbers, with the reason', () => {
    expect(() => assertWritable(d, 'BSH.Common.Option.StartInRelative', 90_000)).toThrow(
      /at most 86340/,
    )
    expect(() => assertWritable(d, 'BSH.Common.Option.StartInRelative', -60)).toThrow(/at least 0/)
    expect(() => assertWritable(d, 'BSH.Common.Option.StartInRelative', 61)).toThrow(
      /multiple of 60/,
    )
    expect(() => assertWritable(d, 'BSH.Common.Setting.Brightness', 6)).toThrow(/at most 5/)
  })

  it('rejects an enum value that is not a member', () => {
    expect(assertWritable(d, 'BSH.Common.Setting.PowerState', 'Standby')).toBe(
      'BSH.Common.Setting.PowerState',
    )
    expect(() => assertWritable(d, 'BSH.Common.Setting.PowerState', 'Hibernate')).toThrow(
      /Off \| On \| Standby/,
    )
  })

  it('rejects what is not writable, not available, not an option or not listed', () => {
    expect(() => assertWritable(d, 'BSH.Common.Option.RemainingProgramTime', 10)).toThrow(
      /not writable/,
    )
    expect(() => assertWritable(d, 'BSH.Common.Status.DoorState', 'Open')).toThrow(
      /not a setting or option/,
    )
    expect(() => assertWritable(d, 'Not.A.Feature', 1)).toThrow(
      /not in this appliance's description/,
    )
  })

  it('rejects an entity the appliance currently marks unavailable', () => {
    const live = dishwasherDescription()
    live.applyChanges([{ uid: 0x4101, available: false }])
    expect(() => assertWritable(live, 'Dishcare.Dishwasher.Option.ExtraDry', true)).toThrow(
      /not available right now/,
    )
  })

  it('takes a live constraint change into account', () => {
    const live = dishwasherDescription()
    live.applyChanges([{ uid: 0x022e, max: 600 }])
    expect(() => assertWritable(live, 'BSH.Common.Option.StartInRelative', 3600)).toThrow(
      /at most 600/,
    )
  })

  it('refuses everything while the description is not loaded', () => {
    expect(() => assertWritable(null, 'BSH.Common.Setting.ChildLock', true)).toThrow(/not loaded/)
  })
})

describe('programs', () => {
  const d = dishwasherDescription()

  it('accepts an offered program and refuses an unlisted or unavailable one', () => {
    expect(() => assertProgramAvailable(d, 'Dishcare.Dishwasher.Program.Eco50')).not.toThrow()
    expect(() => assertProgramAvailable(d, 'Dishcare.Dishwasher.Program.Quick45')).toThrow(
      /not available/,
    )
    expect(() => assertProgramAvailable(d, 'Dishcare.Dishwasher.Program.Nope')).toThrow(
      /not a program/,
    )
  })

  it('accepts only options the program lists and offers', () => {
    const eco = 'Dishcare.Dishwasher.Program.Eco50'
    expect(() =>
      assertProgramOptions(d, eco, { 'Dishcare.Dishwasher.Option.ExtraDry': true }),
    ).not.toThrow()
    // HygienePlus belongs to Auto2, not Eco50
    expect(() =>
      assertProgramOptions(d, eco, { 'Dishcare.Dishwasher.Option.HygienePlus': true }),
    ).toThrow(/not an option of/)
    // IntensivZone is listed by Eco50 but read-only and unavailable there
    expect(() =>
      assertProgramOptions(d, eco, { 'Dishcare.Dishwasher.Option.IntensivZone': true }),
    ).toThrow(/cannot be set/)
  })
})
