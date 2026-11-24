// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { DeviceProxy } from '@camstack/types'
import { MotionTriggerToggle } from '../MotionTriggerToggle'

// The cold-start seed (`enabled: false`, `lastChangedAt: 0`) is "never read",
// not "off": the toggle claims neither state yet still accepts a write.

const setMotionTrigger = vi.fn(() => Promise.resolve(undefined))
let slice: { enabled: boolean; lastChangedAt: number } | undefined

vi.mock('@camstack/ui-library', async () => {
  const actual =
    await vi.importActual<typeof import('@camstack/ui-library')>('@camstack/ui-library')
  return { ...actual, useDeviceStateSlice: () => slice }
})

const dev = {
  motionTrigger: { setMotionTrigger },
  state: { motionTrigger: {} },
} as unknown as DeviceProxy

beforeEach(() => {
  setMotionTrigger.mockClear()
})
afterEach(cleanup)

describe('MotionTriggerToggle', () => {
  it('shows unknown for the cold-start seed, and still sets it on', () => {
    slice = { enabled: false, lastChangedAt: 0 }
    render(<MotionTriggerToggle dev={dev} busy={false} setBusy={vi.fn()} />)
    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-pressed')).toBe('mixed')
    expect(button.textContent).toContain('not read yet')
    expect(button.hasAttribute('disabled')).toBe(false)
    fireEvent.click(button)
    expect(setMotionTrigger).toHaveBeenCalledWith({ enabled: true })
  })

  it('shows off once the camera was read', () => {
    slice = { enabled: false, lastChangedAt: 1_700_000_000_000 }
    render(<MotionTriggerToggle dev={dev} busy={false} setBusy={vi.fn()} />)
    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.textContent).toContain('On motion: off')
  })
})
