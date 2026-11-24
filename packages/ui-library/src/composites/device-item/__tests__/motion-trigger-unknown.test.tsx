// @vitest-environment jsdom
//
// The row and child-row "on motion" toggles: the cold-start seed
// (`enabled: false`, `lastChangedAt: 0`) is "never read", not "off".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { OnMotionToggle } from '../actions'
import { ChildMotionTriggerToggle } from '../children-accordion'

const setMotionTrigger = vi.fn(() => Promise.resolve(undefined))
let slice: { enabled: boolean; lastChangedAt: number } | undefined

vi.mock('../../../hooks/use-device-capability', () => ({
  useDeviceCapability: () => ({
    dev: {},
    cap: { setMotionTrigger },
    slice,
    available: slice !== undefined,
  }),
}))

const trpc = {} as never
const features = ['motion-trigger']

beforeEach(() => {
  setMotionTrigger.mockClear()
})
afterEach(cleanup)

const surfaces = [
  ['OnMotionToggle', () => <OnMotionToggle trpc={trpc} deviceId={1} features={features} />],
  [
    'ChildMotionTriggerToggle',
    () => <ChildMotionTriggerToggle trpc={trpc} deviceId={1} features={features} />,
  ],
] as const

describe.each(surfaces)('%s', (_name, mount) => {
  it('shows unknown, not off, for the cold-start seed, and still sets it on', () => {
    slice = { enabled: false, lastChangedAt: 0 }
    render(mount())
    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-pressed')).toBe('mixed')
    expect(button.getAttribute('title')).toContain('not read')
    fireEvent.click(button)
    expect(setMotionTrigger).toHaveBeenCalledWith({ enabled: true })
  })

  it('shows off once the camera was read', () => {
    slice = { enabled: false, lastChangedAt: 1_700_000_000_000 }
    render(mount())
    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.getAttribute('title')).toContain('off')
  })
})
