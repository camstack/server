/**
 * `switch.toggle` inverts the switch slice and refuses when that state is
 * unknown (no slice, or `on` not a boolean — D393). The default is the one
 * installed at native-cap registration for a provider that did not write it.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger, LogExtras } from '@camstack/types'
import {
  classifySwitchOn,
  SwitchToggleRefusedError,
  withDefaultSwitchToggle,
  type SwitchToggleInput,
  type SwitchToggleRead,
} from '../switch-toggle.js'

function isToggle(fn: unknown): fn is (input: SwitchToggleInput | undefined) => Promise<void> {
  return typeof fn === 'function'
}

function toggleOf(provider: object): (input: SwitchToggleInput | undefined) => Promise<void> {
  const fn: unknown = Reflect.get(provider, 'toggle')
  if (!isToggle(fn)) throw new Error('switch provider has no toggle')
  return fn
}

const DEVICE_ID = 5767

function silentWarn(_message: string, _extras?: LogExtras): void {}

function read(slice: unknown, warn: IScopedLogger['warn'] = silentWarn): SwitchToggleRead {
  return { deviceId: DEVICE_ID, readSlice: () => slice, logger: { warn } }
}

describe('classifySwitchOn', () => {
  it('reads a boolean on, and treats a missing slice and a non-boolean on as unknown', () => {
    expect(classifySwitchOn({ on: true })).toEqual({ known: true, on: true })
    expect(classifySwitchOn({ on: false })).toEqual({ known: true, on: false })
    expect(classifySwitchOn(undefined)).toEqual({ known: false, reason: 'no-slice' })
    expect(classifySwitchOn(null)).toEqual({ known: false, reason: 'no-slice' })
    expect(classifySwitchOn({ on: null, lastChangedAt: 0 })).toEqual({
      known: false,
      reason: 'stale',
    })
    expect(classifySwitchOn({})).toEqual({ known: false, reason: 'stale' })
  })
})

describe('withDefaultSwitchToggle', () => {
  it('flips on to off and off to on through the provider setState', async () => {
    const setOn = vi.fn(async () => {})
    const on = withDefaultSwitchToggle('switch', { setState: setOn }, read({ on: true }))
    await toggleOf(on)({ deviceId: DEVICE_ID })
    expect(setOn).toHaveBeenCalledWith({ deviceId: DEVICE_ID, on: false })

    const setOff = vi.fn(async () => {})
    const off = withDefaultSwitchToggle('switch', { setState: setOff }, read({ on: false }))
    await toggleOf(off)({ deviceId: DEVICE_ID })
    expect(setOff).toHaveBeenCalledWith({ deviceId: DEVICE_ID, on: true })
  })

  it('refuses a missing slice and a stale on, logging the device, and does not call setState', async () => {
    for (const slice of [undefined, { on: null, lastChangedAt: 0 }]) {
      const setState = vi.fn(async () => {})
      const warn = vi.fn<IScopedLogger['warn']>()
      const wrapped = withDefaultSwitchToggle('switch', { setState }, read(slice, warn))
      const toggle = toggleOf(wrapped)
      await expect(toggle({ deviceId: DEVICE_ID })).rejects.toBeInstanceOf(SwitchToggleRefusedError)
      try {
        await toggle({ deviceId: DEVICE_ID })
      } catch (err: unknown) {
        expect(err).toMatchObject({
          reason: slice === undefined ? 'no-slice' : 'stale',
          deviceId: DEVICE_ID,
        })
      }
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('switch.toggle refused'),
        expect.objectContaining({ tags: { deviceId: DEVICE_ID } }),
      )
      expect(setState).not.toHaveBeenCalled()
    }
  })

  it('keeps a toggle the provider already wrote, and leaves every other cap alone', async () => {
    const own = vi.fn(async (_input: SwitchToggleInput | undefined) => {})
    const provider = { setState: vi.fn(async () => {}), toggle: own }
    const wrapped = withDefaultSwitchToggle('switch', provider, read({ on: true }))
    expect(wrapped.toggle).toBe(own)
    await wrapped.toggle({ deviceId: DEVICE_ID })
    expect(own).toHaveBeenCalledOnce()
    expect(provider.setState).not.toHaveBeenCalled()

    const cover = { setState: vi.fn(async () => {}) }
    expect(withDefaultSwitchToggle('cover', cover, read({ on: true }))).toBe(cover)
  })
})
