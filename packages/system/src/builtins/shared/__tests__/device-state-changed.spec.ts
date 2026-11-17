/**
 * History and every decision read what the device REPORTED (D1061): while a
 * command hold changes a slice, `DeviceStateChanged` carries the held view in
 * `slice` and the device's in `confirmed`.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseConfirmedStateChanged, parseDeviceStateChanged } from '../device-state-changed.js'

const HELD = { deviceId: 5, capName: 'switch', slice: { on: true }, confirmed: { on: false } }

/** The builtins that record or decide on a device's state, relative to `builtins/`. */
const CONFIRMED_READERS = [
  'device-history/device-history.addon.ts',
  'composer/composer.addon.ts',
  'core-blocks/core-blocks.addon.ts',
  'core-blocks/scheduler/scheduler-wiring.ts',
] as const

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')
}

describe('DeviceStateChanged views (D1061)', () => {
  it('the confirmed view is what the device reported while a hold changes the slice', () => {
    expect(parseConfirmedStateChanged(HELD)).toEqual({
      deviceId: 5,
      capName: 'switch',
      slice: { on: false },
    })
    expect(parseDeviceStateChanged(HELD)?.slice).toEqual({ on: true })
  })

  it('without a hold both views are the slice', () => {
    const plain = { deviceId: 5, capName: 'switch', slice: { on: true } }
    expect(parseConfirmedStateChanged(plain)).toEqual(plain)
    expect(parseConfirmedStateChanged({ ...plain, confirmed: 'nonsense' })).toEqual(plain)
    expect(parseConfirmedStateChanged({ capName: 'switch', slice: {} })).toBeNull()
  })

  it.each(CONFIRMED_READERS)('%s reads the confirmed view only', (path) => {
    const text = source(path)
    expect(text).toContain('parseConfirmedStateChanged(event.data)')
    expect(text).not.toMatch(/parseDeviceStateChanged\(|\['slice'\]/)
    // Every slice read asks for the device's view.
    expect(text).not.toMatch(/getCapSlice\.query\(\{(?![^}]*confirmed: true)[^}]*\}\)/)
    expect(text).not.toMatch(/getAllSnapshots\.query\(\{\s*\}\)/)
  })
})
