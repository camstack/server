import { describe, it, expect, vi } from 'vitest'
import { resolveSelectStep, selectNavigationMethods } from '../control-select-navigation.js'
import type { ControlStatus } from '../control.cap.js'

const OPTIONS = ['low', 'medium', 'high']

describe('resolveSelectStep', () => {
  it('next walks forward and wraps when cycle is true', () => {
    expect(resolveSelectStep(OPTIONS, 'low', 'next', true)).toBe('medium')
    expect(resolveSelectStep(OPTIONS, 'high', 'next', true)).toBe('low')
  })

  it('next stops at the end when cycle is false', () => {
    expect(resolveSelectStep(OPTIONS, 'high', 'next', false)).toBeNull()
    expect(resolveSelectStep(OPTIONS, 'medium', 'next', false)).toBe('high')
  })

  it('previous mirrors next, walking backward', () => {
    expect(resolveSelectStep(OPTIONS, 'high', 'previous', true)).toBe('medium')
    expect(resolveSelectStep(OPTIONS, 'low', 'previous', true)).toBe('high')
  })

  it('previous stops at the start when cycle is false', () => {
    expect(resolveSelectStep(OPTIONS, 'low', 'previous', false)).toBeNull()
    expect(resolveSelectStep(OPTIONS, 'medium', 'previous', false)).toBe('low')
  })

  it('first and last ignore current and cycle', () => {
    expect(resolveSelectStep(OPTIONS, 'medium', 'first', false)).toBe('low')
    expect(resolveSelectStep(OPTIONS, 'medium', 'last', false)).toBe('high')
  })

  it('throws on an unknown current option for next/previous', () => {
    expect(() => resolveSelectStep(OPTIONS, 'turbo', 'next', true)).toThrow(/turbo/)
    expect(() => resolveSelectStep(OPTIONS, 'turbo', 'previous', true)).toThrow(/turbo/)
  })

  it('throws on an empty option list', () => {
    expect(() => resolveSelectStep([], 'low', 'first', true)).toThrow(/no options/)
  })
})

describe('selectNavigationMethods', () => {
  function status(value: string): ControlStatus {
    return { kind: 'select', value, options: OPTIONS, lastChangedAt: 0 }
  }

  it('next calls setValue with the resolved option', async () => {
    const setValue = vi.fn(async () => {})
    const methods = selectNavigationMethods(async () => status('low'), setValue)
    await methods.next({ deviceId: 1, cycle: true })
    expect(setValue).toHaveBeenCalledWith('medium')
  })

  it('next is a no-op (does not call setValue) when stopped at the end', async () => {
    const setValue = vi.fn(async () => {})
    const methods = selectNavigationMethods(async () => status('high'), setValue)
    await methods.next({ deviceId: 1, cycle: false })
    expect(setValue).not.toHaveBeenCalled()
  })

  it('first/last do not require deviceId-only input', async () => {
    const setValue = vi.fn(async () => {})
    const methods = selectNavigationMethods(async () => status('medium'), setValue)
    await methods.first({ deviceId: 1 })
    await methods.last({ deviceId: 1 })
    expect(setValue).toHaveBeenNthCalledWith(1, 'low')
    expect(setValue).toHaveBeenNthCalledWith(2, 'high')
  })

  it('refuses a non-select status (provider wiring mistake)', async () => {
    const setValue = vi.fn(async () => {})
    const methods = selectNavigationMethods(
      async () => ({ kind: 'numeric', value: 1, options: [], lastChangedAt: 0 }) as ControlStatus,
      setValue,
    )
    await expect(methods.next({ deviceId: 1, cycle: true })).rejects.toThrow(/not a select control/)
  })
})
