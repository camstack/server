/**
 * The dispensa camera (device 1438) is the fixture: these ids and names are
 * what `listPtzPresets` really returned on 2026-09-17, and preset 34 is the one
 * that answered `savePreset` with HTTP 500.
 */
import { describe, expect, it } from 'vitest'
import {
  assertPresetWritable,
  isPresetWritable,
  presetFunctionFor,
} from '../ptz-preset-functions.js'

describe('hikvision reserved preset band', () => {
  it('names 34 as home — it is where goHome must go, and it is not writable', () => {
    expect(presetFunctionFor('34')).toBe('home')
    expect(isPresetWritable('34')).toBe(false)
  })

  it('leaves the operator their own slots', () => {
    for (const id of ['1', '2', '3']) {
      expect(presetFunctionFor(id)).toBeNull()
      expect(isPresetWritable(id)).toBe(true)
    }
  })

  it('covers the whole band the dispensa camera reported', () => {
    expect(presetFunctionFor('39')).toBe('day-mode')
    expect(presetFunctionFor('40')).toBe('night-mode')
    expect(presetFunctionFor('46')).toBe('day-night-auto')
    expect(presetFunctionFor('92')).toBe('set-limits')
    expect(presetFunctionFor('93')).toBe('save-limits')
    expect(presetFunctionFor('94')).toBe('reboot')
    expect(presetFunctionFor('95')).toBe('osd-menu')
  })

  /**
   * The band is matched by id, never by name. An operator who names their own
   * preset "Day mode" keeps a writable slot — a name match would silently take
   * it away from them.
   */
  it('does not reserve an operator slot that merely shares a firmware name', () => {
    expect(isPresetWritable('7')).toBe(true)
    expect(presetFunctionFor('7')).toBeNull()
  })

  /**
   * An id outside the known band is NOT claimed to be unwritable: an
   * undocumented firmware refuses for itself, named, rather than being guessed
   * at here.
   */
  it('keeps an unknown high id writable rather than guessing', () => {
    expect(isPresetWritable('120')).toBe(true)
    expect(presetFunctionFor('120')).toBeNull()
  })
})

describe('the write refusal', () => {
  /**
   * The exact call that produced `PUT /ISAPI/PTZCtrl/channels/1/presets/34 ->
   * HTTP 500`. It must now fail BEFORE the camera is reached, and the message
   * must name the function that owns the id — `transport-failed` told the
   * operator nothing.
   */
  it('refuses to overwrite 34 and names the function', () => {
    expect(() => assertPresetWritable('34', 'overwritten')).toThrowError(
      /Preset 34 is a firmware function on this camera \(home\)/,
    )
  })

  it('refuses to delete a reserved id', () => {
    expect(() => assertPresetWritable('94', 'deleted')).toThrowError(/reboot/)
  })

  it('lets the operator write their own slots', () => {
    expect(() => assertPresetWritable('2', 'overwritten')).not.toThrow()
    expect(() => assertPresetWritable('120', 'deleted')).not.toThrow()
  })
})
