// @vitest-environment jsdom
/**
 * "On motion" on a light card (a floodlight): the toggle comes from the shared
 * `useMotionTrigger`, appears only when the device binds `motion-trigger`, shows
 * the served value, sends once per tap and holds while the change flies.
 */
import type { MotionTriggerStatus, SwitchStatus } from '@camstack/types'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { plugFixtures } from '../__fixtures__/plug'
import { ConnectedLightCard } from '../connected/ConnectedLightCard'

const hub = vi.hoisted(() => ({
  withMotion: true,
  canSet: true,
  switchSlice: undefined as SwitchStatus | undefined,
  motionSlice: undefined as MotionTriggerStatus | undefined,
  setMotionTrigger: vi.fn(),
}))

vi.mock('../../../contexts/system-context', () => ({
  useTrpcClient: () => ({}),
}))
vi.mock('../../../hooks/use-device-proxy', () => ({
  useDeviceProxy: () => ({
    switch: { setState: vi.fn() },
    ...(hub.withMotion ? { motionTrigger: { setMotionTrigger: hub.setMotionTrigger } } : {}),
    state: { switch: hub.switchSlice, motionTrigger: hub.motionSlice },
  }),
  useDeviceStateSlice: (slice: unknown) => slice,
}))
vi.mock('../connected/use-card-common', () => ({
  useCardCommon: () => {
    const common = plugFixtures(0)[0]?.model.common
    if (common === undefined) throw new Error('no plug fixture')
    return {
      common,
      actions: {},
      deviceType: 'light',
      role: 'light',
      features: [],
      implements: (cap: string) => cap !== 'motion-trigger' || hub.canSet,
      fail: () => undefined,
      succeed: () => undefined,
    }
  },
}))
vi.mock('../connected/use-switch-power', () => ({
  useSwitchPower: () => ({
    bound: true,
    on: false,
    since: null,
    timer: null,
    onPower: vi.fn(),
    onTimerStart: vi.fn(),
    onTimerStop: vi.fn(),
  }),
}))

beforeEach(() => {
  hub.withMotion = true
  hub.canSet = true
  hub.switchSlice = { on: false, lastChangedAt: 0 }
  hub.motionSlice = { enabled: true, lastChangedAt: 0 }
  hub.setMotionTrigger.mockReset()
  hub.setMotionTrigger.mockImplementation(() => new Promise(() => undefined))
})
afterEach(cleanup)

describe('ConnectedLightCard on motion', () => {
  it('shows the served value as a pressed toggle when the device binds motion-trigger', () => {
    render(<ConnectedLightCard deviceId={1} />)
    expect(screen.getByTestId('dc-light-motion').getAttribute('aria-pressed')).toBe('true')
  })

  it('has no toggle when the device binds none, cannot set it, or has not answered', () => {
    hub.withMotion = false
    const { unmount } = render(<ConnectedLightCard deviceId={1} />)
    expect(screen.queryByTestId('dc-light-motion')).toBeNull()
    unmount()
    hub.withMotion = true
    hub.canSet = false
    const second = render(<ConnectedLightCard deviceId={1} />)
    expect(screen.queryByTestId('dc-light-motion')).toBeNull()
    second.unmount()
    hub.canSet = true
    hub.motionSlice = undefined
    render(<ConnectedLightCard deviceId={1} />)
    expect(screen.queryByTestId('dc-light-motion')).toBeNull()
  })

  it('sends the flip once and holds the toggle while it flies', () => {
    render(<ConnectedLightCard deviceId={1} />)
    const toggle = screen.getByTestId('dc-light-motion')
    act(() => {
      fireEvent.click(toggle)
      fireEvent.click(toggle)
    })
    expect(hub.setMotionTrigger).toHaveBeenCalledTimes(1)
    expect(hub.setMotionTrigger).toHaveBeenCalledWith({ enabled: false })
    expect(screen.getByTestId('dc-light-motion').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('dc-light-motion').hasAttribute('disabled')).toBe(true)
  })
})
