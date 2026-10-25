/**
 * Collapsing a device's per-cap runtime state to the one string a rule gates on.
 *
 * The fixtures below are REAL slices, copied from `loadRuntimeState` on the live
 * hub — a switch and a sensor — rather than invented. A table that reads a shape
 * production does not produce is a table that works only in its own tests.
 */
import { describe, expect, it } from 'vitest'
import { DEVICE_STATE_READERS, readDeviceStateFrom, stateVocabularyFor } from '@camstack/types'

/** Verbatim from `deviceManager.loadRuntimeState({deviceId:647})`. */
const liveSwitch = {
  'device-status': { online: true, lastChangedAt: 1785834187839 },
  'feature-probe': { flags: {}, deviceType: null, lastProbedAt: 1785834187937 },
  switch: { on: true, lastChangedAt: 1785834188795 },
}

/** Verbatim from `deviceManager.loadRuntimeState({deviceId:291})` — a sensor
 *  with no state-bearing cap in the table. */
const liveSensor = {
  'device-status': { online: true, lastChangedAt: 1785834159635 },
  'temperature-sensor': { celsius: 29, unit: 'C', lastFetchedAt: 1785840999527 },
  battery: { percentage: 100 },
}

describe('readDeviceStateFrom', () => {
  it('reads a live switch as on/off', () => {
    expect(readDeviceStateFrom(liveSwitch)).toBe('on')
    expect(readDeviceStateFrom({ ...liveSwitch, switch: { on: false } })).toBe('off')
  })

  it('reads an alarm panel as its own state word', () => {
    expect(readDeviceStateFrom({ 'alarm-panel': { state: 'armed_away' } })).toBe('armed_away')
  })

  it('reads a contact as open/closed', () => {
    expect(readDeviceStateFrom({ contact: { entryOpen: true } })).toBe('open')
    expect(readDeviceStateFrom({ contact: { entryOpen: false } })).toBe('closed')
  })

  it('returns undefined for a device with no state-bearing cap — a live sensor', () => {
    // The gate treats undefined as "does not match", so a temperature sensor
    // simply cannot arm a rule. That is the intended answer, not a gap.
    expect(readDeviceStateFrom(liveSensor)).toBeUndefined()
  })

  it('does NOT read `device-status.online` as the state', () => {
    // Deliberately absent from the table: every device has it, so having it
    // would mask the real state of every device that also has a real one.
    expect(readDeviceStateFrom({ 'device-status': { online: true } })).toBeUndefined()
  })

  it('prefers the more specific cap when a device carries several', () => {
    const both = { switch: { on: true }, 'alarm-panel': { state: 'disarmed' } }
    expect(readDeviceStateFrom(both)).toBe('disarmed')
  })

  it('survives a malformed slice instead of throwing', () => {
    // Runtime state is `Record<string, unknown>` off the wire. A gate that threw
    // here would take the evaluation tick with it.
    expect(readDeviceStateFrom({ switch: null })).toBeUndefined()
    expect(readDeviceStateFrom({ switch: 'nonsense' })).toBeUndefined()
    expect(readDeviceStateFrom({ switch: { on: 42 } })).toBeUndefined()
    expect(readDeviceStateFrom({})).toBeUndefined()
  })
})

describe('stateVocabularyFor — what an editor may offer', () => {
  it('offers exactly the two words the gate would produce for a boolean cap', () => {
    // The picker and the gate read the SAME table, so an offered value can never
    // be one the gate does not recognise.
    expect(stateVocabularyFor(liveSwitch)).toEqual(['on', 'off'])
    expect(stateVocabularyFor({ contact: { entryOpen: false } })).toEqual(['open', 'closed'])
  })

  it('offers the alarm vocabulary it is given, not a duplicated copy', () => {
    const states = ['disarmed', 'armed_home', 'armed_away']
    expect(stateVocabularyFor({ 'alarm-panel': { state: 'disarmed' } }, states)).toEqual(states)
  })

  it('offers nothing for a device that cannot be gated', () => {
    expect(stateVocabularyFor(liveSensor)).toEqual([])
  })
})

describe('the table itself', () => {
  it('has no duplicate cap entries — the first match wins, so a duplicate is dead', () => {
    const caps = DEVICE_STATE_READERS.map((r) => r.cap)
    expect(new Set(caps).size).toBe(caps.length)
  })

  it('never maps `device-status`', () => {
    expect(DEVICE_STATE_READERS.some((r) => r.cap === 'device-status')).toBe(false)
  })
})
